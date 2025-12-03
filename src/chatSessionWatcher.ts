import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SnapshotManager } from './snapshotManager';
import { log, logError } from './extension';

interface ChatTurn {
    turnId: string;
    timestamp: string;
    userMessage: string;
    botResponse: string;
    thinking?: string;
    toolCalls?: any[];
    metadata?: any;
}

export class ChatSessionWatcher {
    private snapshotManager: SnapshotManager;
    private storageUri: vscode.Uri | undefined;
    private watchers: fs.FSWatcher[] = [];
    private processedTurns: Set<string> = new Set();
    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

    constructor(context: vscode.ExtensionContext, snapshotManager: SnapshotManager) {
        this.snapshotManager = snapshotManager;
        this.storageUri = context.storageUri;

        if (this.storageUri) {
            this.initWatcher();
        } else {
            logError('No storage URI available for this workspace.');
        }
    }

    private async initWatcher() {
        if (!this.storageUri) return;

        // The path is typically .../workspaceStorage/<uid>/GitHub.copilot-chat/chatSessions/
        // context.storageUri points to .../workspaceStorage/<uid>
        const chatSessionsPath = path.join(this.storageUri.fsPath, 'GitHub.copilot-chat', 'chatSessions');

        log(`Initializing ChatSessionWatcher at: ${chatSessionsPath}`);

        // Ensure directory exists before watching (it might not exist if no chat has happened yet)
        if (!fs.existsSync(chatSessionsPath)) {
            log('Chat sessions directory does not exist yet. Waiting for it to be created...');
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
        log(`Started watching chat sessions directory: ${dirPath}`);

        try {
            const watcher = fs.watch(dirPath, (eventType, filename) => {
                if (filename && filename.endsWith('.json')) {
                    this.handleFileChange(path.join(dirPath, filename));
                }
            });
            this.watchers.push(watcher);
        } catch (err) {
            logError(`Failed to watch chat sessions directory: ${err}`);
        }
    }

    private handleFileChange(filePath: string) {
        // Debounce to avoid reading file multiple times during a write burst
        if (this.debounceTimers.has(filePath)) {
            clearTimeout(this.debounceTimers.get(filePath)!);
        }

        const timer = setTimeout(() => {
            this.processChatSessionFile(filePath);
            this.debounceTimers.delete(filePath);
        }, 1000); // Wait 1s for writes to settle

        this.debounceTimers.set(filePath, timer);
    }

    private async processChatSessionFile(filePath: string) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const sessionData = JSON.parse(content);

            if (!sessionData.requests || !Array.isArray(sessionData.requests) || sessionData.requests.length === 0) {
                return;
            }

            // Get the last request (latest turn)
            const lastRequest = sessionData.requests[sessionData.requests.length - 1];

            // Check if this turn is complete (has a response)
            if (!lastRequest.response || lastRequest.response.length === 0) {
                return;
            }

            // Use requestId as a unique identifier for the turn
            const turnId = lastRequest.requestId;

            if (this.processedTurns.has(turnId)) {
                return; // Already processed this turn
            }

            // Check if the turn is actually done. 
            // Heuristic: Check if the last response item is NOT a "thinking" block that is incomplete?
            // Or just assume if we are here after debounce, and it has a response, it's likely a good time to snapshot.
            // A better check might be looking for a specific "done" marker if available, but the JSON structure varies.
            // For now, we'll assume if we have a response array, we capture it. 
            // To be safer, we could check if the last response item looks "final" (e.g. text or tool invocation).

            log(`New chat turn detected: ${turnId}`);
            this.processedTurns.add(turnId);

            // Extract details
            const userMessage = lastRequest.message?.text || '';

            // Aggregate bot response parts
            let botResponse = '';
            let thinking = '';
            const toolCalls: any[] = [];

            for (const part of lastRequest.response) {
                if (part.kind === 'text' || part.value) { // 'value' is used in some parts like thinking or text
                    if (part.kind === 'thinking') {
                        thinking += (part.value || '') + '\n';
                    } else {
                        botResponse += (part.value || part.text || '') + '\n';
                    }
                }

                if (part.kind === 'toolInvocation' || part.kind === 'toolInvocationSerialized') {
                    toolCalls.push(part);
                }
            }

            const turnData: ChatTurn = {
                turnId,
                timestamp: new Date().toISOString(),
                userMessage,
                botResponse: botResponse.trim(),
                thinking: thinking.trim(),
                toolCalls,
                metadata: lastRequest
            };

            // Trigger snapshot
            // We pass the turnData as "debugMessages" for now, or we update SnapshotManager to handle it explicitly.
            // Ideally, we update SnapshotManager.

            // Determine workspace path from the session or current workspace
            // The session file is in workspaceStorage, so we know which workspace it belongs to implicitly?
            // Actually, we are running in the extension host, so `vscode.workspace.workspaceFolders` should match.
            const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;

            if (workspacePath) {
                await this.snapshotManager.captureSnapshot(
                    workspacePath,
                    undefined, // Let manager determine index
                    turnData.timestamp,
                    [turnData] // Pass structured data
                );
            }

        } catch (err) {
            logError(`Error processing chat session file ${filePath}: ${err}`);
        }
    }

    public dispose() {
        this.watchers.forEach(w => w.close());
        this.debounceTimers.forEach(t => clearTimeout(t));
    }
}
