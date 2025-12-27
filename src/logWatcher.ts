/*
This file looks at the Copilot Chat log file and triggers a snapshot when a new turn starts.
*/

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
            // Check if the log file has size increase, i.e. new content has been added
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
                Logger.warn('Log rotated or truncated. Resetting current size.');
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
            // Trigger 2: ccreq (Success)
            // Example: [info] ccreq:... | success | ...
            // Be careful to match the "success" completion line
            const trigger1 = line.includes('AgentIntent:') && line.includes('rendering');
            const trigger2 = line.includes('ccreq:') && line.includes('| success |');
            let ccreqPath = '';
            if (trigger2) {
                // Read the ccreq file
                ccreqPath = line.substring(line.indexOf('ccreq:'), line.indexOf('| success |'));
            }
            if (trigger1 || trigger2) {
                Logger.info(`LogWatcher: Detected Trigger. Trigger1: ${trigger1}, Trigger2: ${trigger2}.`);
                // Read the timestamp from the log line
                // It is in the format of: "2025-12-23 01:14:48.197 <Level> ..."
                // Extract the first 23 chars: "2025-12-23 01:14:48.197"
                const timestampstr = line.substring(0, 23);

                // Convert to ISO format if valid
                let isoTimestamp = '';
                try {
                    isoTimestamp = new Date(timestampstr).toISOString();
                } catch (e) {
                    Logger.warn(`LogWatcher: Failed to parse timestamp '${timestampstr}', using current time.`);
                    // Pass empty string to let Manager handle it
                }
                await this.snapshotManager.captureRepoSnapshot(isoTimestamp, ccreqPath);
            }
        }
    }

    public dispose() {
        if (this.tailInterval) {
            clearInterval(this.tailInterval);
        }
    }
}
