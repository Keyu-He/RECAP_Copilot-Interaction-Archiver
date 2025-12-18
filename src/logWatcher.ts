import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';
import { SnapshotManager } from './snapshotManager';

export class LogWatcher {
    private context: vscode.ExtensionContext;
    private snapshotManager: SnapshotManager;
    private logFilePath: string | undefined;
    private tailInterval: NodeJS.Timeout | undefined;
    private currentSize: number = 0;

    constructor(context: vscode.ExtensionContext, snapshotManager: SnapshotManager) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.initWatcher();
    }

    private async initWatcher() {
        Logger.info('Initializing LogWatcher...');
        this.logFilePath = await this.locateCopilotLogFile();

        if (this.logFilePath) {
            Logger.info(`Found Copilot Chat log: ${this.logFilePath}`);
            this.startTailing();
        } else {
            Logger.warn('Could not locate GitHub Copilot Chat output.log. Real-time triggers disabled.');
        }
    }

    private async locateCopilotLogFile(): Promise<string | undefined> {
        try {
            // Strategy: Go up from our extension's log URI to the 'output_logging_...' directory
            // log uri: .../logs/2025.../window1/exthost/output_logging_.../<username>.copilot-archiver...
            // We want: .../logs/2025.../window1/exthost/output_logging_.../GitHub.copilot-chat/GitHub Copilot Chat.log

            // Note: context.logUri is available in recent VS Code versions.
            if (!this.context.logUri) {
                return undefined;
            }
            Logger.info(`Extension log URI fsPath: ${this.context.logUri.fsPath}`);

            const myLogDir = this.context.logUri.fsPath;
            const outputLoggingDir = path.dirname(myLogDir); // Parent of specific extension log folder

            if (!fs.existsSync(outputLoggingDir)) {
                return undefined;
            }

            const entries = await fs.promises.readdir(outputLoggingDir, { withFileTypes: true });


            for (const entry of entries) {
                if (entry.isDirectory() && entry.name === 'GitHub.copilot-chat') {
                    const candidateDir = path.join(outputLoggingDir, entry.name);
                    const files = await fs.promises.readdir(candidateDir);

                    if (files.includes('GitHub Copilot Chat.log')) {
                        return path.join(candidateDir, 'GitHub Copilot Chat.log');
                    }
                }
            }

        } catch (err) {
            Logger.error(`Error searching for log file: ${err}`);
        }
        return undefined;
    }

    private startTailing() {
        if (!this.logFilePath) return;

        // Initial size
        try {
            const stats = fs.statSync(this.logFilePath);
            this.currentSize = stats.size;
        } catch (e) {
            this.currentSize = 0;
        }

        // Poll every 500ms (fast enough for real-time)
        this.tailInterval = setInterval(async () => {
            await this.checkLogUpdates();
        }, 500);
    }

    private async checkLogUpdates() {
        if (!this.logFilePath) return;

        try {
            const stats = await fs.promises.stat(this.logFilePath);
            if (stats.size > this.currentSize) {
                const stream = fs.createReadStream(this.logFilePath, {
                    start: this.currentSize,
                    end: stats.size,
                    encoding: 'utf-8'
                });

                let newContent = '';
                for await (const chunk of stream) {
                    newContent += chunk;
                }

                this.currentSize = stats.size;
                await this.processLogLines(newContent);
            } else if (stats.size < this.currentSize) {
                // Log rotated or truncated? Reset.
                this.currentSize = stats.size;
            }
        } catch (err) {
            Logger.debug(`Error tailing log: ${err}`);
        }
    }

    private async processLogLines(content: string) {
        const lines = content.split('\n');
        for (const line of lines) {
            // These two triggers covers the input and output triggers in the Copilot Chat, but often we do have extra triggers.
            // Trigger 1: AgentIntent
            // Example: [debug] AgentIntent: rendering ...
            if (line.includes('AgentIntent:') && line.includes('rendering')) {
                Logger.info('LogWatcher: Detected AgentIntent Trigger');
                await this.snapshotManager.captureTempSnapshot();
            }

            // Trigger 2: ccreq (Success)
            // Example: [info] ccreq:... | success | ...
            // Be careful to match the "success" completion line
            if (line.includes('ccreq:') && line.includes('| success |')) {
                Logger.info('LogWatcher: Detected ccreq Trigger');
                await this.snapshotManager.captureTempSnapshot();
            }
        }
    }

    public dispose() {
        if (this.tailInterval) {
            clearInterval(this.tailInterval);
        }
    }
}
