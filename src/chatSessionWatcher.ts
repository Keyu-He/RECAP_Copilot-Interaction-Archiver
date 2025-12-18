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

                await this.captureSnapshotWrapper(filePath, chatIdOverride, currentRequestsLength, turnData, 'input', inputTimestamp);
            }

            // --- Condition 2: Output Snapshot (Completion Detected) ---
            if (currentRequestsLength > 0) {
                const lastRequest = sessionData.requests[currentRequestsLength - 1];

                const editsResolved = fileState.lastHasPendingEdits === true && currentHasPendingEdits === false;
                const responseDone = lastRequest.response?.done === true && currentHasPendingEdits !== true;

                if ((editsResolved || responseDone) && lastRequest.response) {
                    Logger.info(`Output triggered for turn ${lastRequest.requestId}`);

                    const turnData = this.extractTurnData(lastRequest, true);

                    // Output Timestamp: Try modelState.completedAt, fall back if needed
                    // Note: We need to verify where completedAt is. Usually in modelState matching the turn?
                    // Or if response is an array of parts, maybe implied.
                    // User said: requests[i].modelState.completedAt
                    const outputTimestamp = lastRequest.modelState?.completedAt || turnData.timestamp;

                    await this.captureSnapshotWrapper(filePath, chatIdOverride, currentRequestsLength, turnData, 'output', outputTimestamp);
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
            metadata: isOutput ? request : undefined
        };
    }

    private async captureSnapshotWrapper(
        filePath: string,
        chatId: string,
        turnIndex: number,
        turnData: ChatTurn,
        phase: 'input' | 'output',
        targetTimestamp?: string
    ) {
        const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspacePath) return;

        // --- Hybrid Sync Logic ---
        const tempSnapshotPath = await this.findMatchingTempSnapshot(workspacePath, phase, targetTimestamp);
        const config = vscode.workspace.getConfiguration('copilotArchiver');
        const outputPath = config.get<string>('outputPath', '.snapshots');

        // Paths
        const chatIdDir = path.join(workspacePath, outputPath, chatId);
        const codebaseSnapshotsDir = path.join(chatIdDir, 'codebase_snapshots');
        const metadataDirName = `${turnIndex}_${phase}`; // 1_input, 1_output
        const metadataDir = path.join(chatIdDir, metadataDirName);

        // Ensure directories exist
        if (!fs.existsSync(codebaseSnapshotsDir)) {
            fs.mkdirSync(codebaseSnapshotsDir, { recursive: true });
        }
        if (!fs.existsSync(metadataDir)) {
            fs.mkdirSync(metadataDir, { recursive: true });
        }

        let finalRepoSnapshotPath: string | undefined;

        // 1. Handle Repo Snapshot (Move from Temp or Fallback)
        if (tempSnapshotPath) {
            Logger.info(`Syncing temp snapshot for ${phase}: ${path.basename(tempSnapshotPath)} -> Turn ${turnIndex}`);

            const tempDirName = path.basename(tempSnapshotPath);
            const repoSnapshotName = tempDirName;
            const destPath = path.join(codebaseSnapshotsDir, repoSnapshotName);

            // Move
            try {
                if (fs.existsSync(destPath)) {
                    fs.rmSync(destPath, { recursive: true, force: true });
                }
                fs.renameSync(tempSnapshotPath, destPath);

                // Cleanup internal meta files from repo snapshot
                const internalMeta = path.join(destPath, '_meta.json');
                if (fs.existsSync(internalMeta)) fs.unlinkSync(internalMeta);
                // _timestamp.txt if it existed

                finalRepoSnapshotPath = `../codebase_snapshots/${repoSnapshotName}`; // Relative path for summary.json

                Logger.info(`Moved repo snapshot to ${destPath}`);

            } catch (err) {
                Logger.error(`Failed to move temp snapshot: ${err}`);
            }
        } else {
            Logger.warn(`No temp snapshot found for ${phase}. Capturing live state.`);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const repoSnapshotName = `${timestamp}_${phase}_fallback`;
            const destPath = path.join(codebaseSnapshotsDir, repoSnapshotName);
        }

        // 2. Generate summary.json
        const summary = {
            turnIndex: turnIndex,
            phase: phase,
            timestamp: turnData.timestamp,
            userPrompt: turnData.userMessage,
            modelResponse: turnData.botResponse,
            repoSnapshotPath: finalRepoSnapshotPath || "MISSING_SNAPSHOT"
        };
        fs.writeFileSync(path.join(metadataDir, 'summary.json'), JSON.stringify(summary, null, 2));

        // 3. Archive Logs
        // A. ChatId.json
        const sessionFileDest = path.join(metadataDir, path.basename(filePath));
        fs.copyFileSync(filePath, sessionFileDest);

        // B. GitHub Copilot Chat.log
        const logPath = await this.locateCopilotLogFile();
        if (logPath && fs.existsSync(logPath)) {
            const logDest = path.join(metadataDir, 'GitHubCopilotChat.log');
            fs.copyFileSync(logPath, logDest);
        } else {
            Logger.warn('Could not locate GitHub Copilot Chat.log for archiving.');
        }

        Logger.info(`Metadata and logs archived to ${metadataDir}`);

        // --- S3 Upload triggered ---
        const s3Prefix = config.get<string>('s3.folderPrefix', 'copilot-snapshots');

        // 1. Upload Repo Snapshot (if validated)
        if (finalRepoSnapshotPath && finalRepoSnapshotPath !== "MISSING_SNAPSHOT") {
            // Reconstruct full path. finalRepoSnapshotPath is relative "../codebase_snapshots/..."
            const repoName = path.basename(finalRepoSnapshotPath);
            const repoPath = path.join(codebaseSnapshotsDir, repoName);
            const s3RepoKey = `${s3Prefix}/${chatId}/codebase_snapshots/${repoName}`;

            await this.snapshotManager.uploadDirectory(repoPath, s3RepoKey);
        }

        // 2. Upload Metadata Folder
        const s3MetaKey = `${s3Prefix}/${chatId}/${metadataDirName}`;
        await this.snapshotManager.uploadDirectory(metadataDir, s3MetaKey);
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
            const tempDir = path.join(workspacePath, outputPath, '_temp');

            if (!fs.existsSync(tempDir)) return undefined;

            const targetTime = new Date(targetIsoTime).getTime();
            const entries = await fs.promises.readdir(tempDir, { withFileTypes: true });

            let bestCandidate: string | undefined;
            let minDiff = Infinity;

            for (const e of entries) {
                if (e.isDirectory() && e.name.includes(phase)) {
                    const fullPath = path.join(tempDir, e.name);
                    try {
                        const stats = fs.statSync(fullPath);
                        const snapshotTime = stats.birthtimeMs;

                        // Calculate absolute difference between JSON event time and File creation time
                        const diff = Math.abs(snapshotTime - targetTime);

                        // Match window: 10 seconds triggers
                        if (diff < 10000 && diff < minDiff) {
                            minDiff = diff;
                            bestCandidate = fullPath;
                        }
                    } catch (err) { }
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
