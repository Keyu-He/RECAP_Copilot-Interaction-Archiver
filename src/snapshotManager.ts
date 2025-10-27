import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface SnapshotMetadata {
    turn_index: number;
    timestamp: string;
    workspace_path: string;
    files_count: number;
    total_size_bytes: number;
    agent_chat_history?: {
        timestamp: string;
        turn_count: number;
        messages: any[];
    };
}

export class SnapshotManager {
    private excludePatterns: string[];
    private outputPath: string;

    constructor() {
        const config = vscode.workspace.getConfiguration('copilotArchiver');
        this.excludePatterns = config.get<string[]>('excludePatterns', [
            '.git',
            'node_modules',
            '__pycache__',
            '.DS_Store',
            '*.pyc',
            'GitHub Copilot Chat.log',
            '.snapshots'
        ]);
        this.outputPath = config.get<string>('outputPath', '.snapshots');
    }

    getOutputPath(): string {
        return this.outputPath;
    }

    async captureSnapshot(
        workspacePath: string,
        turnIndex?: number,
        debugTimestamp?: string,
        debugMessages?: any[],
        debugTurnCount?: number
    ): Promise<void> {
        const workspaceName = path.basename(workspacePath);

        // Determine turn index
        const actualTurnIndex = turnIndex ?? await this.getNextTurnIndex(workspacePath, workspaceName);

        // Create snapshot directory
        const snapshotDir = path.join(workspacePath, this.outputPath, `${actualTurnIndex}`);

        if (fs.existsSync(snapshotDir)) {
            console.log(`Snapshot directory already exists: ${snapshotDir}, skipping...`);
            return;
        }

        fs.mkdirSync(snapshotDir, { recursive: true });

        // Copy workspace files
        const stats = await this.copyDirectory(workspacePath, snapshotDir, workspacePath);

        // Create metadata file
        const metadata: SnapshotMetadata = {
            turn_index: actualTurnIndex,
            timestamp: debugTimestamp ?? new Date().toISOString(),
            workspace_path: workspacePath,
            files_count: stats.filesCount,
            total_size_bytes: stats.totalSize
        };

        if (debugMessages && debugMessages.length >= 0) {
            const turnCount = typeof debugTurnCount === 'number' ? debugTurnCount : this.countTurnsFromMessages(debugMessages);
            metadata.agent_chat_history = {
                timestamp: debugTimestamp ?? '',
                turn_count: turnCount,
                messages: debugMessages
            };
        }

        const metadataPath = path.join(snapshotDir, '_snapshot_metadata.json');
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

        // Log via outputChannel using the logger if needed, but keep this quiet here
    }

    private countTurnsFromMessages(messages: any[]): number {
        let turns = 0;
        for (const msg of messages) {
            if (msg && msg.role === 'user') {
                const contentText = this.extractContentText(msg.content);
                if (contentText.includes('<userRequest>')) {
                    turns += 1;
                }
            }
        }
        return turns;
    }

    private extractContentText(content: any): string {
        if (typeof content === 'string') {
            return content;
        }
        if (Array.isArray(content) && content.length > 0) {
            const parts: string[] = [];
            for (const item of content) {
                if (item && typeof item === 'object') {
                    if (item.type === 'input_text' && typeof item.text === 'string') {
                        parts.push(item.text);
                    } else if (item.type === 'output_text' && typeof item.text === 'string') {
                        parts.push(item.text);
                    } else if (typeof item.text === 'string' && item.type !== 'input_image' && item.type !== 'output_image') {
                        parts.push(item.text);
                    }
                }
            }
            return parts.join('\n');
        }
        return content ? String(content) : '';
    }

    private async getNextTurnIndex(workspacePath: string, workspaceName: string): Promise<number> {
        const snapshotsDir = path.join(workspacePath, this.outputPath);

        if (!fs.existsSync(snapshotsDir)) {
            return 0;
        }

        const entries = fs.readdirSync(snapshotsDir, { withFileTypes: true });
        const turnDirs = entries
            .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
            .map(entry => {
                return parseInt(entry.name, 10);
            })
            .filter(index => !isNaN(index) && index >= 0);

        return turnDirs.length > 0 ? Math.max(...turnDirs) + 1 : 0;
    }

    private async copyDirectory(
        src: string,
        dest: string,
        workspaceRoot: string
    ): Promise<{ filesCount: number; totalSize: number }> {
        let filesCount = 0;
        let totalSize = 0;

        const entries = fs.readdirSync(src, { withFileTypes: true });

        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);

            // Skip dot-directories entirely (e.g., .mypy_cache, .git, .venv, etc.)
            if (entry.isDirectory() && entry.name.startsWith('.')) {
                continue;
            }

            // Check if should be excluded
            if (this.shouldExclude(srcPath, workspaceRoot)) {
                continue;
            }

            if (entry.isDirectory()) {
                fs.mkdirSync(destPath, { recursive: true });
                const subStats = await this.copyDirectory(srcPath, destPath, workspaceRoot);
                filesCount += subStats.filesCount;
                totalSize += subStats.totalSize;
            } else if (entry.isFile()) {
                const stats = fs.statSync(srcPath);
                fs.copyFileSync(srcPath, destPath);
                filesCount++;
                totalSize += stats.size;
            }
        }

        return { filesCount, totalSize };
    }

    private shouldExclude(filePath: string, workspaceRoot: string): boolean {
        const relativePath = path.relative(workspaceRoot, filePath);

        for (const pattern of this.excludePatterns) {
            // Simple pattern matching (exact match or wildcard)
            if (pattern.includes('*')) {
                // Convert glob pattern to regex
                const regexPattern = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*');
                const regex = new RegExp(`^${regexPattern}$`);
                if (regex.test(path.basename(filePath))) {
                    return true;
                }
            } else {
                // Exact match on name or path component
                if (relativePath.includes(pattern) || path.basename(filePath) === pattern) {
                    return true;
                }
            }
        }

        return false;
    }
}
