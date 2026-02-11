/*
This file looks at the chat session JSON files and triggers a snapshot when a new turn starts.
*/
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SnapshotManager } from './snapshotManager';
import { Logger } from './logger';

// Mount paths for different host OS (configured in devcontainer.json)
const HOST_MOUNT_PATHS = [
    '/host-workspaceStorage',         // macOS
    '/host-workspaceStorage-linux',   // Linux
    '/host-workspaceStorage-windows'  // Windows
];

export class ChatSessionWatcher {
    private snapshotManager: SnapshotManager;
    private storageUri: vscode.Uri | undefined;
    private context: vscode.ExtensionContext;
    private watchers: fs.FSWatcher[] = [];

    constructor(context: vscode.ExtensionContext, snapshotManager: SnapshotManager) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        // When the extension starts, VSCode gives it a context object that contains a storageUri property.
        // We use this to find the chat sessions directory.
        this.storageUri = context.storageUri;

        if (this.storageUri) {
            Logger.info(`Storage URI: ${this.storageUri.fsPath}`);
            this.initWatcher();
        } else {
            Logger.error('No storage URI available for this workspace.');
        }
    }

    /**
     * Check if we're running in a remote/container environment
     */
    private isRemoteEnvironment(): boolean {
        return vscode.env.remoteName !== undefined;
    }

    /**
     * Find an available host mount path (for DevContainer scenarios)
     */
    private findHostMountPath(): string | undefined {
        for (const mountPath of HOST_MOUNT_PATHS) {
            if (fs.existsSync(mountPath)) {
                Logger.info(`Found host mount at: ${mountPath}`);
                return mountPath;
            }
        }
        return undefined;
    }

    /**
     * Extract workspace hash from storage URI path
     * e.g., /home/node/.vscode-server/data/User/workspaceStorage/ae0099939b76912e8a61f62483b0fe28/...
     *       -> ae0099939b76912e8a61f62483b0fe28
     */
    private extractWorkspaceHash(): string | undefined {
        if (!this.storageUri) return undefined;

        const storagePath = this.storageUri.fsPath;
        // The path contains .../workspaceStorage/<hash>/...
        const match = storagePath.match(/workspaceStorage[\/\\]([a-f0-9]+)/i);
        if (match && match[1]) {
            Logger.info(`Extracted workspace hash: ${match[1]}`);
            return match[1];
        }
        return undefined;
    }

    private async initWatcher() {
        if (!this.storageUri) return;

        let chatSessionsPath: string;

        // Debug: Log remote environment detection
        Logger.info(`Remote environment check: remoteName = ${vscode.env.remoteName}`);

        // Check if we're in a remote/container environment with a host mount
        if (this.isRemoteEnvironment()) {
            Logger.info('Detected remote environment (DevContainer/SSH)');

            const hostMountPath = this.findHostMountPath();
            const workspaceHash = this.extractWorkspaceHash();

            if (hostMountPath && workspaceHash) {
                // Use the mounted host path
                chatSessionsPath = path.join(hostMountPath, workspaceHash, 'chatSessions');
                Logger.info(`Using mounted host path for chat sessions: ${chatSessionsPath}`);
            } else {
                // Fall back to container path (might not have chat sessions)
                Logger.warn('Host mount not available or hash not found. Chat session tracking may be limited.');
                const workspaceStorageRoot = path.dirname(this.storageUri.fsPath);
                chatSessionsPath = path.join(workspaceStorageRoot, 'chatSessions');
            }
        } else {
            // Normal local environment
            // The path is typically .../workspaceStorage/<uid>/chatSessions/
            // context.storageUri points to .../workspaceStorage/<uid>/<extensionId>
            // So we need to go up one level to find the chatSessions folder
            const workspaceStorageRoot = path.dirname(this.storageUri.fsPath);
            chatSessionsPath = path.join(workspaceStorageRoot, 'chatSessions');
        }

        Logger.info(`Initializing ChatSessionWatcher at: ${chatSessionsPath}`);

        // Ensure directory exists before watching (it might not exist if no chat has happened yet)
        if (!fs.existsSync(chatSessionsPath)) {
            Logger.info('Chat sessions directory does not exist yet. Waiting for it to be created...');
            // Poll for directory existence
            const pollInterval = setInterval(() => {
                if (fs.existsSync(chatSessionsPath)) {
                    clearInterval(pollInterval);
                    this.startWatching(chatSessionsPath);
                }
            }, 5000);
            return;
        }

        this.startWatching(chatSessionsPath);
    }

    private startWatching(dirPath: string) {
        Logger.info(`Started watching chat sessions directory: ${dirPath}`);

        try {
            const watcher = fs.watch(dirPath, (eventType, filename) => {
                Logger.info(`File change detected: ${filename}`);
                if (filename && (filename.endsWith('.json') || filename.endsWith('.jsonl'))) {
                    this.handleFileChange(path.join(dirPath, filename));
                }
            });
            this.watchers.push(watcher);
        } catch (err) {
            Logger.error(`Failed to watch chat sessions directory: ${err}`);
        }
    }

    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
    private lastUploadTime: Map<string, number> = new Map();

    private handleFileChange(filePath: string) {
        const ext = path.extname(filePath);
        const chatId = path.basename(filePath, ext);
        const now = Date.now();
        const lastUpload = this.lastUploadTime.get(filePath) || 0;

        const doUpload = async () => {
            this.debounceTimers.delete(filePath);
            this.lastUploadTime.set(filePath, Date.now());
            Logger.info(`Chat session update for ${chatId}`);
            await this.snapshotManager.updateChatSessionFile(chatId, filePath);
        };

        if (now - lastUpload >= 10000) {
            // No recent upload — fire immediately
            doUpload();
        } else if (!this.debounceTimers.has(filePath)) {
            // Schedule trailing upload at exactly lastUpload + 10s
            const remaining = 10000 - (now - lastUpload);
            this.debounceTimers.set(filePath, setTimeout(doUpload, remaining));
        }
    }

    public dispose() {
        this.watchers.forEach(w => w.close());
        this.debounceTimers.forEach(t => clearTimeout(t));
    }
}
