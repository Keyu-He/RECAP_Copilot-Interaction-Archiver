import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

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

    constructor(workspacePath: string) {
        this.workspacePath = workspacePath;
        this.sessionId = path.basename(workspacePath);
        const config = vscode.workspace.getConfiguration('copilotArchiver');
        this.jsonOutputEnabled = config.get<boolean>('jsonOutputEnabled', true);
        this.jsonOutputDir = config.get<string>('jsonOutputDir', 'copilot_debug_messages');
        this.snapshotsOutputPath = config.get<string>('outputPath', '.snapshots');
    }

    updateConfigFromSettings() {
        const config = vscode.workspace.getConfiguration('copilotArchiver');
        this.jsonOutputEnabled = config.get<boolean>('jsonOutputEnabled', true);
        this.jsonOutputDir = config.get<string>('jsonOutputDir', 'copilot_debug_messages');
        this.snapshotsOutputPath = config.get<string>('outputPath', '.snapshots');
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
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
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
                        code_snapshot: null
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
        const entries = fs.readdirSync(snapshotsDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith('turn_')) continue;
            const match = entry.name.match(/^turn_(\d+)$/);
            if (!match) continue;
            const turnIndex = parseInt(match[1], 10);
            const snapshotDir = path.join(snapshotsDir, entry.name);
            const metadataPath = path.join(snapshotDir, '_snapshot_metadata.json');
            if (!fs.existsSync(metadataPath)) continue;
            try {
                const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
                if (turnIndex >= 0 && turnIndex < compactTurns.length) {
                    const relPath = path.relative(path.dirname(workspacePath), snapshotDir);
                    compactTurns[turnIndex]['code_snapshot'] = {
                        path: relPath,
                        timestamp: metadata.timestamp,
                        files_count: metadata.files_count,
                        total_size_bytes: metadata.total_size_bytes
                    };
                }
            } catch (e) {
                console.warn(`Warning: Could not read metadata from ${metadataPath}: ${e}`);
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
        } catch {}

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

        console.log(`Wrote Copilot JSON: ${path.relative(workspacePath, fullPath)}, ${path.relative(workspacePath, compactPath)}`);
    }
}


