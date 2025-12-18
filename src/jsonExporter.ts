import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from './logger';

type AnyObject = Record<string, any>;

function extractContentText(content: any): string {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content) && content.length > 0) {
        const textParts: string[] = [];
        for (const item of content) {
            if (item && typeof item === 'object') {
                if (item.type === 'input_text' && typeof item.text === 'string') {
                    textParts.push(item.text);
                } else if (item.type === 'output_text' && typeof item.text === 'string') {
                    textParts.push(item.text);
                } else if (typeof (item as AnyObject).text === 'string' && item.type !== 'input_image' && item.type !== 'output_image') {
                    textParts.push((item as AnyObject).text as string);
                }
            }
        }
        return textParts.length > 0 ? textParts.join('\n') : '';
    }
    return content ? String(content) : '';
}

function toIsoTimestamp(ts: string): string {
    // Expecting format like: 2025-10-08 00:06:58.617
    // Convert to ISO by inserting 'T'
    const trimmed = ts.trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(trimmed)) {
        return trimmed.replace(' ', 'T');
    }
    return trimmed;
}

export class JsonExporter {
    private workspacePath: string;
    private sessionId: string;
    private bestMessages: any[] | null = null;
    private userMessageTimestamps: Map<string, string> = new Map();
    private jsonOutputEnabled: boolean;
    private jsonOutputDir: string;
    private snapshotsOutputPath: string;
    private incrementalMappingPath: string | null = null;
    private completeHistoryPath: string | null = null;

    constructor(workspacePath: string) {
        this.workspacePath = workspacePath;
        this.sessionId = path.basename(workspacePath);
        const config = vscode.workspace.getConfiguration('copilotArchiver');
        this.jsonOutputEnabled = config.get<boolean>('jsonOutputEnabled', true);
        this.snapshotsOutputPath = config.get<string>('outputPath', '.snapshots');
        this.jsonOutputDir = config.get<string>('jsonOutputDir', path.join(this.snapshotsOutputPath, 'copilot_debug_messages'));
    }

    updateConfigFromSettings() {
        const config = vscode.workspace.getConfiguration('copilotArchiver');
        this.jsonOutputEnabled = config.get<boolean>('jsonOutputEnabled', true);
        this.snapshotsOutputPath = config.get<string>('outputPath', '.snapshots');
        this.jsonOutputDir = config.get<string>('jsonOutputDir', path.join(this.snapshotsOutputPath, 'copilot_debug_messages'));
    }

    recordDebugLine(timestampRaw: string, rawMessagesJson: string) {
        try {
            const messages: any[] = JSON.parse(rawMessagesJson.trim());
            // Update timestamps map if last is user
            if (messages && messages.length > 0 && messages[messages.length - 1]?.role === 'user') {
                const userMsgContent = extractContentText(messages[messages.length - 1]?.content);
                if (userMsgContent && !this.userMessageTimestamps.has(userMsgContent)) {
                    this.userMessageTimestamps.set(userMsgContent, toIsoTimestamp(timestampRaw));
                }
            }
            // Decide if this is the best messages array so far
            const score = (arr: any[]) => {
                let userCount = 0;
                for (const m of arr) {
                    if (m?.role === 'user') userCount++;
                }
                return [userCount, arr.length] as [number, number];
            };
            if (!this.bestMessages) {
                this.bestMessages = messages;
            } else {
                const [u1, l1] = score(this.bestMessages);
                const [u2, l2] = score(messages);
                if (u2 > u1 || (u2 === u1 && l2 > l1)) {
                    this.bestMessages = messages;
                }
            }
            // Also persist incremental mapping for each debug line for easier analysis
            this.appendIncrementalMapping(timestampRaw, messages);
        } catch (e) {
            console.error(`Failed to parse [debug] messages JSON: ${e}`);
        }
    }

    private ensureIncrementalMappingPath() {
        if (!this.jsonOutputEnabled) return;
        if (this.incrementalMappingPath) return;
        const dir = path.join(this.workspacePath, this.jsonOutputDir);
        try { fs.mkdirSync(dir, { recursive: true }); } catch { }
        this.incrementalMappingPath = path.join(dir, `${this.sessionId}-incremental.jsonl`);
    }

    private appendIncrementalMapping(timestampRaw: string, messages: any[]) {
        this.ensureIncrementalMappingPath();
        if (!this.incrementalMappingPath) return;
        const obj = { timestamp: toIsoTimestamp(timestampRaw), messages };
        try {
            fs.appendFileSync(this.incrementalMappingPath, JSON.stringify(obj) + '\n', 'utf-8');
        } catch (e) {
            console.warn(`Failed to write incremental mapping: ${e}`);
        }
    }

    private createCompactConversation(messages: any[]): any[] {
        const compactTurns: any[] = [];
        let i = 0;
        while (i < messages.length) {
            const msg = messages[i];
            if (msg?.role === 'user') {
                const content = extractContentText(msg.content ?? '');
                const timestamp = msg.timestamp ?? undefined;
                const match = content.match(/<userRequest>([\s\S]*?)<\/userRequest>/);
                if (match) {
                    const userRequest = (match[1] ?? '').trim();
                    const assistantResponses: string[] = [];
                    let j = i + 1;
                    while (j < messages.length) {
                        const nextMsg = messages[j];
                        const nextContent = extractContentText(nextMsg?.content ?? '');
                        if (nextMsg?.role === 'user' && nextContent.includes('<userRequest>')) {
                            break;
                        }
                        if (nextMsg?.role === 'assistant') {
                            const assistantText = extractContentText(nextMsg?.content ?? '').trim();
                            if (assistantText) assistantResponses.push(assistantText);
                        }
                        j++;
                    }
                    const attachmentText = '(See <attachments> above for file contents. You may not need to search or read the file again.)';
                    const userRequestClean = userRequest.replace(attachmentText, '').trim();
                    const rawContent = msg.content ?? '';
                    const multimodalItems: any[] = [];
                    if (Array.isArray(rawContent)) {
                        for (const item of rawContent) {
                            if (item && typeof item === 'object') {
                                const itemType = (item as AnyObject).type ?? '';
                                if (itemType !== 'input_text' && itemType !== 'output_text') {
                                    multimodalItems.push(item);
                                }
                            }
                        }
                    }
                    const turnObj: AnyObject = {
                        turn_index: compactTurns.length,
                        timestamp: timestamp,
                        user_request: userRequestClean,
                        assistant_responses: assistantResponses,
                        code_snapshot_first: null,
                        code_snapshot_last: null
                    };
                    if (multimodalItems.length > 0) {
                        turnObj['prompt_content'] = multimodalItems;
                    }
                    compactTurns.push(turnObj);
                    i = j;
                    continue;
                }
            }
            i++;
        }
        return compactTurns;
    }

    private linkSnapshotsToTurns(compactTurns: any[]): any[] {
        const workspacePath = this.workspacePath;
        const snapshotsDir = path.join(workspacePath, this.snapshotsOutputPath);
        if (!fs.existsSync(snapshotsDir)) {
            return compactTurns;
        }

        // Read all snapshot metadata
        const entries = fs.readdirSync(snapshotsDir, { withFileTypes: true });
        const snapshots: Array<{
            snapshotIndex: number;
            turnCount: number;
            metadata: any;
            snapshotDir: string;
        }> = [];

        for (const entry of entries) {
            if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
            const snapshotIndex = parseInt(entry.name, 10);
            if (isNaN(snapshotIndex)) continue;

            const snapshotDir = path.join(snapshotsDir, entry.name);
            const metadataPath = path.join(snapshotDir, '_snapshot_metadata.json');
            if (!fs.existsSync(metadataPath)) continue;

            try {
                const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
                const turnCount = metadata.agent_chat_history?.turn_count ?? 0;
                snapshots.push({ snapshotIndex, turnCount, metadata, snapshotDir });
            } catch (e) {
                console.warn(`Warning: Could not read metadata from ${metadataPath}: ${e}`);
            }
        }

        // For each turn, find the first and last snapshot that includes that turn
        for (let turnIndex = 0; turnIndex < compactTurns.length; turnIndex++) {
            // Find all snapshots with turn_count = turnIndex + 1
            const candidateSnapshots = snapshots.filter(s => s.turnCount === turnIndex + 1);

            if (candidateSnapshots.length > 0) {
                // Pick the snapshot with the lowest snapshotIndex (first/baseline)
                const firstSnapshot = candidateSnapshots.reduce((prev, curr) =>
                    curr.snapshotIndex < prev.snapshotIndex ? curr : prev
                );

                // Pick the snapshot with the highest snapshotIndex (last/final)
                const lastSnapshot = candidateSnapshots.reduce((prev, curr) =>
                    curr.snapshotIndex > prev.snapshotIndex ? curr : prev
                );

                const firstRelPath = path.relative(path.dirname(workspacePath), firstSnapshot.snapshotDir);
                compactTurns[turnIndex]['code_snapshot_first'] = {
                    path: firstRelPath,
                    timestamp: firstSnapshot.metadata.timestamp,
                    files_count: firstSnapshot.metadata.files_count,
                    total_size_bytes: firstSnapshot.metadata.total_size_bytes
                };

                const lastRelPath = path.relative(path.dirname(workspacePath), lastSnapshot.snapshotDir);
                compactTurns[turnIndex]['code_snapshot_last'] = {
                    path: lastRelPath,
                    timestamp: lastSnapshot.metadata.timestamp,
                    files_count: lastSnapshot.metadata.files_count,
                    total_size_bytes: lastSnapshot.metadata.total_size_bytes
                };
            }
        }

        return compactTurns;
    }

    writeOutputs(activeLogPath?: string) {
        if (!this.jsonOutputEnabled || !this.bestMessages) {
            return;
        }
        // Update user timestamps into messages
        for (const msg of this.bestMessages) {
            if (msg?.role === 'user') {
                const contentText = extractContentText(msg?.content);
                const ts = this.userMessageTimestamps.get(contentText);
                if (ts) {
                    msg.timestamp = ts;
                }
            }
        }

        const workspacePath = this.workspacePath;
        const sessionId = this.sessionId;
        const outputDir = path.join(workspacePath, this.jsonOutputDir);
        try {
            fs.mkdirSync(outputDir, { recursive: true });
        } catch { }

        // Full version
        const fullOutput = {
            session_id: sessionId,
            workspace_path: workspacePath,
            log_path: activeLogPath ?? '',
            message_count: this.bestMessages.length,
            messages: this.bestMessages
        };
        const fullPath = path.join(outputDir, `${sessionId}.json`);
        fs.writeFileSync(fullPath, JSON.stringify(fullOutput, null, 2), 'utf-8');

        // Compact version
        let compactTurns = this.createCompactConversation(this.bestMessages);
        compactTurns = this.linkSnapshotsToTurns(compactTurns);
        const compactOutput = {
            session_id: sessionId,
            workspace_path: workspacePath,
            log_path: activeLogPath ?? '',
            turn_count: compactTurns.length,
            turns: compactTurns
        };
        const compactPath = path.join(outputDir, `${sessionId}-compact.json`);
        fs.writeFileSync(compactPath, JSON.stringify(compactOutput, null, 2), 'utf-8');

        // Complete history version (preserves rolled-back turns)
        this.writeCompleteHistory(outputDir, sessionId, compactTurns);

        Logger.info(`Wrote Copilot JSON: ${path.relative(workspacePath, fullPath)}, ${path.relative(workspacePath, compactPath)}`);
    }

    private writeCompleteHistory(outputDir: string, sessionId: string, currentTurns: any[]) {
        const historyPath = path.join(outputDir, `${sessionId}-complete-history.json`);

        // Read existing complete history
        let completeHistory: any = {
            session_id: sessionId,
            workspace_path: this.workspacePath,
            last_updated: new Date().toISOString(),
            all_turns: []
        };

        if (fs.existsSync(historyPath)) {
            try {
                const existing = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
                completeHistory.all_turns = existing.all_turns || [];
            } catch (e) {
                console.warn(`Failed to read existing complete history: ${e}`);
            }
        }

        // Create a map of current turns by their unique signature
        const currentTurnSignatures = new Set<string>();
        for (const turn of currentTurns) {
            const signature = this.getTurnSignature(turn);
            currentTurnSignatures.add(signature);
        }

        // Mark existing turns as deleted if they no longer exist in current turns
        const existingSignatures = new Set<string>();
        for (const historicalTurn of completeHistory.all_turns) {
            const signature = this.getTurnSignature(historicalTurn);
            existingSignatures.add(signature);

            if (!currentTurnSignatures.has(signature)) {
                // Turn was rolled back/deleted
                historicalTurn.deleted = true;
                historicalTurn.deleted_at = new Date().toISOString();
            } else {
                // Turn still exists, update it
                const currentTurn = currentTurns.find(t => this.getTurnSignature(t) === signature);
                if (currentTurn) {
                    // Update with latest information
                    Object.assign(historicalTurn, currentTurn);
                    historicalTurn.deleted = false;
                }
            }
        }

        // Add new turns that don't exist in history
        for (const turn of currentTurns) {
            const signature = this.getTurnSignature(turn);
            if (!existingSignatures.has(signature)) {
                // New turn
                const newTurn = { ...turn, deleted: false, first_seen: new Date().toISOString() };
                completeHistory.all_turns.push(newTurn);
            }
        }

        // Update metadata
        completeHistory.last_updated = new Date().toISOString();
        completeHistory.total_turns = completeHistory.all_turns.length;
        completeHistory.active_turns = completeHistory.all_turns.filter((t: any) => !t.deleted).length;
        completeHistory.deleted_turns = completeHistory.all_turns.filter((t: any) => t.deleted).length;

        // Write complete history
        fs.writeFileSync(historyPath, JSON.stringify(completeHistory, null, 2), 'utf-8');
    }

    private getTurnSignature(turn: any): string {
        // Create a unique signature for a turn based on timestamp and user request
        // This helps identify the same turn across different versions
        const timestamp = turn.timestamp || '';
        const userRequest = turn.user_request || '';
        return `${timestamp}:${userRequest.substring(0, 100)}`;
    }
}

