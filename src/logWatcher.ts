import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import * as vscode from 'vscode';
import * as os from 'os';
import { SnapshotManager } from './snapshotManager';
import { JsonExporter } from './jsonExporter';
import { log, error as logError } from './logger';

export class LogWatcher {
    private workspacePath: string;
    private watcher: chokidar.FSWatcher | undefined;
    private snapshotManager: SnapshotManager;
    private lastProcessedLineCountByFile: Map<string, number> = new Map();
    private currentTurnIndex: number = 0;
    private logFileName: string;
    private logFilePatterns: string[];
    private jsonExporter: JsonExporter;

    constructor(workspacePath: string, snapshotManager: SnapshotManager) {
        this.workspacePath = workspacePath;
        const config = vscode.workspace.getConfiguration('copilotArchiver');
        const logFileName = config.get<string>('logFileName', 'GitHub Copilot Chat.log');
        this.logFileName = logFileName;
        this.logFilePatterns = config.get<string[]>('logFilePatterns', [
            logFileName,
            'GitHub Copilot*.log',
            'GitHub Copilot Chat*.log',
            'Copilot*.log'
        ]);
        this.snapshotManager = snapshotManager;
        this.jsonExporter = new JsonExporter(this.workspacePath);
    }

    start() {
        const logRoots = this.getVSCodeLogRoots();
        const globPatterns: string[] = [];
        for (const root of logRoots) {
            for (const pattern of this.logFilePatterns) {
                globPatterns.push(path.join(root, '**', pattern));
            }
        }

        this.watcher = chokidar.watch(globPatterns, {
            persistent: true,
            ignoreInitial: false,
        });

        this.watcher
            .on('add', (filePath) => {
                // Initialize cursor at end to avoid replaying old content
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const lines = content.split('\n');
                    this.lastProcessedLineCountByFile.set(filePath, lines.length);
                } catch (e) {
                    this.lastProcessedLineCountByFile.set(filePath, 0);
                }
                log(`Copilot log detected: ${filePath}`);
            })
            .on('change', (filePath) => {
                this.processLogFile(filePath);
            })
            .on('unlink', (filePath) => {
                this.lastProcessedLineCountByFile.delete(filePath);
                log(`Copilot log removed: ${filePath}`);
            })
            .on('error', (err) => {
                logError(`Watcher error: ${err}`);
            });

        log(`Watching for Copilot logs under: ${logRoots.join(', ')} with patterns: ${this.logFilePatterns.join(', ')}`);
    }

    stop() {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = undefined;
        }
    }

    private processLogFile(filePath: string) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');

            // Process only new lines
            const prev = this.lastProcessedLineCountByFile.get(filePath) ?? 0;
            const newLines = lines.slice(prev);
            this.lastProcessedLineCountByFile.set(filePath, lines.length);

            // Capture [debug] messages lines for JSON exporter and snapshot per debug
            for (const line of newLines) {
                if (line.includes('[debug] messages:') || line.includes('[debug] input:')) {
                    const debugType = line.includes('[debug] messages:') ? '[debug] messages:' : '[debug] input:';
                    const parts = line.split(debugType);
                    const ts = parts[0].trim();
                    const raw = parts.slice(1).join(debugType).trim();
                    // Extract a JSON array substring robustly (from first '[' to last ']')
                    const jsonStr = this.extractJsonArrayFromDebugLine(raw) ?? raw;
                    // Store progressively with normalized JSON array
                    this.jsonExporter.recordDebugLine(ts, jsonStr);

                    // Log verbose details about the detected line and JSON
                    log(`Detected ${debugType} line at ${ts}`);
                    const lineShort = line.length > 150 ? line.slice(0, 150) + '...' : line;
                    const jsonShort = jsonStr.length > 150 ? jsonStr.slice(0, 150) + '...' : jsonStr;
                    log(`Line: ${lineShort}`);
                    log(`Extracted JSON: ${jsonShort}`);

                    // Parse messages JSON once for snapshot metadata
                    let parsedMessages: any[] | undefined = undefined;
                    try {
                        parsedMessages = JSON.parse(jsonStr);
                    } catch {}
                    const turnCount = parsedMessages ? this.countUserTurns(parsedMessages) : undefined;
                    // Trigger a snapshot on every debug line to mirror the Python pipeline
                    this.onTurnComplete(this.currentTurnIndex, ts, parsedMessages, turnCount);
                    this.currentTurnIndex++;
                }
            }

            // After processing a batch from this file, write JSON outputs reflecting latest best messages
            this.jsonExporter.writeOutputs(filePath);
        } catch (err) {
            logError(`Error reading log file: ${err}`);
        }
    }

    private extractJsonArrayFromDebugLine(line: string): string | undefined {
        const start = line.indexOf('[');
        const end = line.lastIndexOf(']');
        if (start >= 0 && end >= start) {
            return line.slice(start, end + 1).trim();
        }
        return undefined;
    }

    private async onTurnComplete(turnIndex: number, debugTimestamp?: string, debugMessages?: any[], debugTurnCount?: number) {
        log(`Turn ${turnIndex} completed, capturing snapshot...`);
        try {
            await this.snapshotManager.captureSnapshot(this.workspacePath, turnIndex, debugTimestamp, debugMessages, debugTurnCount);
            vscode.window.showInformationMessage(`Snapshot captured for turn ${turnIndex}`);
        } catch (err) {
            logError(`Failed to capture snapshot: ${err}`);
            vscode.window.showErrorMessage(`Failed to capture snapshot: ${String(err)}`);
        }
    }

    private countUserTurns(messages: any[]): number {
        let turns = 0;
        for (const msg of messages) {
            if (msg && msg.role === 'user') {
                const content = msg.content;
                const contentText = this.extractContentText(content);
                if (contentText.includes('<userRequest>')) {
                    turns += 1;
                }
            }
        }
        return turns;
    }

    private extractContentText(content: any): string {
        if (typeof content === 'string') return content;
        if (Array.isArray(content) && content.length > 0) {
            const parts: string[] = [];
            for (const item of content) {
                if (item && typeof item === 'object') {
                    if (item.type === 'input_text' && typeof item.text === 'string') parts.push(item.text);
                    else if (item.type === 'output_text' && typeof item.text === 'string') parts.push(item.text);
                    else if (typeof item.text === 'string' && item.type !== 'input_image' && item.type !== 'output_image') parts.push(item.text);
                }
            }
            return parts.join('\n');
        }
        return content ? String(content) : '';
    }

    private getVSCodeLogRoots(): string[] {
        const homeDir = os.homedir();
        const appName = vscode.env.appName || 'Visual Studio Code';
        // Map VS Code app name to folder name used under user config
        const folderCandidates: string[] = [];
        if (/Insiders/i.test(appName)) {
            folderCandidates.push('Code - Insiders');
        } else if (/VSCodium/i.test(appName)) {
            folderCandidates.push('VSCodium');
        }
        // Always include stable Code and Insiders as fallbacks
        folderCandidates.push('Code');
        folderCandidates.push('Code - Insiders');
        folderCandidates.push('VSCodium');

        const roots: string[] = [];
        const platform = process.platform;
        for (const folder of folderCandidates) {
            if (platform === 'darwin') {
                roots.push(path.join(homeDir, 'Library', 'Application Support', folder, 'logs'));
            } else if (platform === 'win32') {
                const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
                roots.push(path.join(appData, folder, 'logs'));
            } else {
                roots.push(path.join(homeDir, '.config', folder, 'logs'));
            }
        }
        // Deduplicate
        return Array.from(new Set(roots));
    }
}
