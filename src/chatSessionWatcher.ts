/*
This file looks at the chat session JSON files and triggers a snapshot when a new turn starts.
*/
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SnapshotManager } from './snapshotManager';
import { Logger } from './logger';

const ENABLE_DEBUG_LOGGING = true;

interface ChatTurn {
    turnId: string;
    timestamp: string;
    userMessage: string;
    botResponse: string;
    thinking?: string;
    toolCalls?: any[];
    edits?: any[];
    agentIntent?: any;
    metadata?: any;
}

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

    private async initWatcher() {
        if (!this.storageUri) return;

        // The path is typically .../workspaceStorage/<uid>/chatSessions/
        // context.storageUri points to .../workspaceStorage/<uid>/<extensionId>
        // So we need to go up one level to find the chatSessions folder
        const workspaceStorageRoot = path.dirname(this.storageUri.fsPath);
        const chatSessionsPath = path.join(workspaceStorageRoot, 'chatSessions');

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
                if (filename && filename.endsWith('.json')) {
                    this.handleFileChange(path.join(dirPath, filename));
                }
            });
            this.watchers.push(watcher);
        } catch (err) {
            Logger.error(`Failed to watch chat sessions directory: ${err}`);
        }
    }

    private handleFileChange(filePath: string) {
        this.processChatSessionFile(filePath);
    }

    private processedFiles: Map<string, { lastRequestsLength: number; lastHasPendingEdits: boolean | undefined; lastSessionData?: any }> = new Map();

    private async processChatSessionFile(filePath: string) {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const sessionData = JSON.parse(content);
            const chatIdOverride = path.basename(filePath, '.json');

            if (!sessionData.requests || !Array.isArray(sessionData.requests)) {
                return;
            }

            if (!this.processedFiles.has(filePath)) {
                this.processedFiles.set(filePath, {
                    lastRequestsLength: 0,
                    lastHasPendingEdits: undefined,
                    lastSessionData: undefined
                });
            }

            const fileState = this.processedFiles.get(filePath)!;
            const currentRequestsLength = sessionData.requests.length;
            const currentHasPendingEdits = sessionData.hasPendingEdits;

            // --- Condition 1: Input Snapshot (New Request Detected) ---
            if (currentRequestsLength > fileState.lastRequestsLength) {
                const lastRequest = sessionData.requests[currentRequestsLength - 1];
                Logger.info(`New chat turn detected (Input Phase): ${lastRequest.requestId}`);

                const turnData = this.extractTurnData(lastRequest, false);

                // Input Timestamp: Use request.timestamp
                const inputTimestamp = lastRequest.timestamp;

                await this.captureSnapshotWrapper(filePath, chatIdOverride, currentRequestsLength, turnData, 'input', inputTimestamp, sessionData);
            }

            // --- Condition 2: Output Snapshot (Completion Detected) ---
            if (currentRequestsLength > 0) {
                const lastRequest = sessionData.requests[currentRequestsLength - 1];

                const editsResolved = fileState.lastHasPendingEdits === true && currentHasPendingEdits === false;
                const responseDone = lastRequest.response?.done === true && currentHasPendingEdits !== true;

                if ((editsResolved || responseDone) && lastRequest.response) {
                    Logger.info(`Output triggered for turn ${lastRequest.requestId}`);

                    const turnData = this.extractTurnData(lastRequest, true);

                    // Output Timestamp: Try modelState.completedAt, fall back to turnData.timestamp
                    const outputTimestamp = lastRequest.modelState?.completedAt ? new Date(lastRequest.modelState.completedAt).toISOString() : turnData.timestamp;

                    await this.captureSnapshotWrapper(filePath, chatIdOverride, currentRequestsLength, turnData, 'output', outputTimestamp, sessionData);
                }
            }

            // --- Condition 3: Debug Change Logging (Always run if enabled) ---
            if (ENABLE_DEBUG_LOGGING) {
                this.logDebugChanges(filePath, chatIdOverride, fileState.lastSessionData, sessionData, currentRequestsLength, currentHasPendingEdits);
            }

            // Update state
            fileState.lastRequestsLength = currentRequestsLength;
            fileState.lastHasPendingEdits = currentHasPendingEdits;
            fileState.lastSessionData = sessionData;

        } catch (err) {
            Logger.error(`Error processing chat session file ${filePath}: ${err}`);
        }
    }

    // --- Helper Methods ---

    private extractTurnData(request: any, isOutput: boolean): ChatTurn {
        const turnId = request.requestId;
        const userMessage = request.message?.text || '';

        let botResponse = '';
        let thinking = '';
        const toolCalls: any[] = [];
        const edits: any[] = [];

        if (isOutput && request.response) {
            for (const part of request.response) {
                if (part.kind === 'text' || (!part.kind && part.value)) {
                    botResponse += (part.value || part.text || '') + '\n';
                }
                if (part.kind === 'thinking') {
                    thinking += (part.value || '') + '\n';
                }
                if (part.kind === 'toolInvocation' || part.kind === 'toolInvocationSerialized') {
                    toolCalls.push(part);
                }
                if (part.kind === 'textEditGroup') {
                    edits.push({
                        file: part.uri?.fsPath,
                        edits: part.edits
                    });
                }
            }
        }

        return {
            turnId,
            timestamp: new Date().toISOString(),
            userMessage,
            botResponse: botResponse.trim(),
            thinking: thinking.trim(),
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            edits: edits.length > 0 ? edits : undefined,
            agentIntent: request.usedContext?.agentIntent, // Assuming it lives here or top level
            metadata: isOutput ? request : undefined
        };
    }

    private async captureSnapshotWrapper(
        filePath: string,
        chatId: string,
        turnIndex: number,
        turnData: ChatTurn,
        phase: 'input' | 'output',
        targetTimestamp?: string,
        sessionData?: any
    ) {
        const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspacePath) return;

        // 1. Handle Repo Snapshot (Move from Temp)
        const tempSnapshotPath = await this.findMatchingTempSnapshot(workspacePath, phase, targetTimestamp);

        if (tempSnapshotPath) {
            const snapshotTimestamp = path.basename(tempSnapshotPath);
            Logger.info(`Found timestamp-matched snapshot for ${phase}: ${snapshotTimestamp}`);
        } else {
            Logger.warn(`No snapshot found for ${phase} to associate.`);
        }

        // 2. Update Chat Session File
        if (sessionData) {
            await this.snapshotManager.updateChatSessionFile(chatId, sessionData);
        }
    }

    // Helper to find log file (Duplicate of LogWatcher logic for now to keep independent)
    private async locateCopilotLogFile(): Promise<string | undefined> {
        if (!this.context.logUri) return undefined;
        try {
            const outputLoggingDir = path.dirname(this.context.logUri.fsPath);
            if (!fs.existsSync(outputLoggingDir)) return undefined;

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
        } catch (e) { /* ignore */ }
        return undefined;
    }

    private async findMatchingTempSnapshot(workspacePath: string, phase: 'input' | 'output', targetIsoTime?: string): Promise<string | undefined> {
        if (!targetIsoTime) return undefined; // Cannot match without timestamp

        try {
            const config = vscode.workspace.getConfiguration('copilotArchiver');
            const outputPath = config.get<string>('outputPath', '.snapshots');
            const tempDir = path.join(workspacePath, outputPath, 'repo_snapshots');

            if (!fs.existsSync(tempDir)) return undefined;

            const targetTime = new Date(targetIsoTime).getTime();
            const entries = await fs.promises.readdir(tempDir, { withFileTypes: true });

            let bestCandidate: string | undefined;
            let minDiff = Infinity;

            for (const e of entries) {
                if (e.isDirectory()) {
                    const folderName = e.name; // e.g. 2025-12-23T01_14_48.197Z
                    // Restore colons for ISO parsing
                    const isoString = folderName.replace(/_/g, ':');
                    const snapshotTime = new Date(isoString).getTime();

                    if (!isNaN(snapshotTime)) {
                        // Calculate difference: Target (JSON Event) vs Snapshot (Log Event)

                        const diff = snapshotTime - targetTime;

                        // Check window: -5000ms to 5000ms
                        if (diff >= -5000 && diff <= 5000) {
                            if (Math.abs(diff) < minDiff) {
                                minDiff = Math.abs(diff);
                                bestCandidate = path.join(tempDir, e.name);
                            }
                        }
                    }
                }
            }
            return bestCandidate;

        } catch (err) {
            Logger.warn(`Error finding temp snapshot: ${err}`);
        }
        return undefined;
    }


    private logDebugChanges(
        filePath: string,
        chatId: string,
        lastData: any,
        currentData: any,
        currentRequestsLength: number,
        currentHasPendingEdits: boolean | undefined
    ) {
        const changes: string[] = [];
        lastData = lastData || {};

        // 1. Check Requests Length
        if (currentRequestsLength !== (lastData.requests?.length || 0)) {
            changes.push(`Requests length changed: ${lastData.requests?.length || 0} -> ${currentRequestsLength}`);
        }

        // 2. Check Pending Edits
        if (currentHasPendingEdits !== lastData.hasPendingEdits) {
            changes.push(`hasPendingEdits changed: ${lastData.hasPendingEdits} -> ${currentHasPendingEdits}`);
        }

        // 3. Check Last Response Content
        if (currentRequestsLength > 0) {
            const lastReq = currentData.requests[currentRequestsLength - 1];
            const prevReq = lastData.requests?.[currentRequestsLength - 1];

            if (prevReq) {
                if (lastReq.response?.done !== prevReq.response?.done) {
                    changes.push(`Turn ${lastReq.requestId} response.done changed: ${prevReq.response?.done} -> ${lastReq.response?.done}`);
                }
                const currRespLen = JSON.stringify(lastReq.response || []).length;
                const prevRespLen = JSON.stringify(prevReq.response || []).length;
                if (currRespLen !== prevRespLen) {
                    changes.push(`Turn ${lastReq.requestId} response content length changed: ${prevRespLen} -> ${currRespLen}`);
                }
            } else if (currentRequestsLength > (lastData.requests?.length || 0)) {
                changes.push(`New Turn Added: ${lastReq.requestId}`);
            }
        }

        if (changes.length > 0) {
            const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
            if (workspacePath) {
                // CHANGED: Debug logs now go to .snapshots/debug/<chatId>/...
                const logDir = path.join(workspacePath, '.snapshots', 'debug', chatId);
                if (!fs.existsSync(logDir)) {
                    fs.mkdirSync(logDir, { recursive: true });
                }
                const debugLogEntry = {
                    timestamp: new Date().toISOString(),
                    changes: changes,
                };
                fs.appendFileSync(path.join(logDir, '_debug_changes.jsonl'), JSON.stringify(debugLogEntry) + '\n');
            }
        }
    }

    public dispose() {
        this.watchers.forEach(w => w.close());
    }
}
