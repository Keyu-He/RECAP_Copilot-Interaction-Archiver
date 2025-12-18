import * as vscode from 'vscode';
import { Logger } from './logger';
import { SnapshotManager } from './snapshotManager';
import * as path from 'path';
import * as fs from 'fs';

export class PasteWatcher {
    private snapshotManager: SnapshotManager;
    private context: vscode.ExtensionContext;
    private disposables: vscode.Disposable[] = [];

    // Configuration
    private readonly PASTE_THRESHOLD = 50; // Minimum characters to be considered a paste

    constructor(context: vscode.ExtensionContext, snapshotManager: SnapshotManager) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.initWatcher();
    }

    private initWatcher() {
        Logger.info('Initializing PasteWatcher...');

        const watcher = vscode.workspace.onDidChangeTextDocument(async (event) => {
            await this.handleDocumentChange(event);
        });

        this.disposables.push(watcher);
    }

    private async handleDocumentChange(event: vscode.TextDocumentChangeEvent) {
        // Ignore changes from output panels, log files, etc.
        if (event.document.uri.scheme !== 'file') {
            return;
        }

        for (const change of event.contentChanges) {
            // Heuristic 1: Length check
            // If the inserted text matches a significant length, it's likely a paste or auto-generate
            if (change.text.length > this.PASTE_THRESHOLD) {
                await this.analyzePotentialPaste(change.text, event.document.uri);
            }
        }
    }

    private async analyzePotentialPaste(insertedText: string, documentUri: vscode.Uri) {
        try {
            // Heuristic 2: Clipboard Check
            const clipboardText = await vscode.env.clipboard.readText();
            const isClipboardPaste = insertedText === clipboardText || insertedText.trim() === clipboardText.trim();

            const eventType = isClipboardPaste ? 'CLIPBOARD_PASTE' : 'LARGE_INSERTION';

            Logger.info(`Detected ${eventType} in ${path.basename(documentUri.fsPath)} (${insertedText.length} chars)`);

            // Log this event
            const pasteEvent = {
                timestamp: new Date().toISOString(),
                eventType: eventType,
                filePath: documentUri.fsPath,
                length: insertedText.length,
                isClipboardMatch: isClipboardPaste,
                // We truncate the content for logs to avoid massive files, or store full? 
                // Let's store full for now as per "archival" goal, but be careful.
                content: insertedText
            };

            // Using a specialized log file for pastes
            const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
            if (workspacePath) {
                await this.logPasteEvent(workspacePath, pasteEvent);
            }

        } catch (err) {
            Logger.error(`Error detecting paste: ${err}`);
        }
    }

    private async logPasteEvent(workspacePath: string, event: any) {
        // We'll store these in a specialized log file in the .snapshots directory
        // We can reuse SnapshotManager's output path config if public, but for now let's manually write
        // to ensure we don't break the snapshot logic.
        // Better yet: Ask SnapshotManager to do it?
        // For speed, let's write to .snapshots/_paste_events.jsonl (line separated JSON)

        try {
            const config = vscode.workspace.getConfiguration('copilotArchiver');
            const outputPath = config.get<string>('outputPath', '.snapshots');
            const logDir = path.join(workspacePath, outputPath);

            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }

            const logFile = path.join(logDir, '_paste_events.jsonl');
            fs.appendFileSync(logFile, JSON.stringify(event) + '\n');

        } catch (err) {
            Logger.error(`Failed to log paste event: ${err}`);
        }
    }

    public dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}
