import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Logger } from './logger';

interface SnapshotMetadata {
    turn_index: number;
    timestamp: string;
    workspace_path: string;
    chat_id: string;
    repo_path: string;
    files_count: number;
    total_size_bytes: number;
    chat_data?: any;
    agent_chat_history?: {
        timestamp: string;
        turn_count: number;
        messages: any[];
    };
}

export class SnapshotManager {
    private excludePatterns: string[];
    private outputPath: string;

    private secretStorage: vscode.SecretStorage;

    constructor(secretStorage: vscode.SecretStorage) {
        this.secretStorage = secretStorage;
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

    async captureRepoSnapshot(timestamp?: string, ccreqPath?: string): Promise<void> {
        try {
            const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
            if (!workspacePath) return;

            let currTimestamp = new Date().toISOString();
            if (!timestamp) {
                Logger.warn('No timestamp provided for temp snapshot, using current time...');
            }
            const tempDir = path.join(workspacePath, this.outputPath, 'repo_snapshots', timestamp || currTimestamp);

            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');

            for (const file of files) {
                const relativePath = vscode.workspace.asRelativePath(file);
                if (relativePath.startsWith('.snapshots') || relativePath.startsWith('.git') || relativePath.startsWith('.mypy_cache') || relativePath.includes('node_modules')) {
                    continue;
                }

                const sourcePath = file.fsPath;
                const destPath = path.join(tempDir, relativePath);

                const destFileDir = path.dirname(destPath);
                if (!fs.existsSync(destFileDir)) {
                    fs.mkdirSync(destFileDir, { recursive: true });
                }

                fs.copyFileSync(sourcePath, destPath);
            }

            if (ccreqPath) {
                Logger.debug(`Reading ccreq file structure: ${ccreqPath}`);
                try {
                    const uri = vscode.Uri.parse(ccreqPath);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    const content = doc.getText();

                    const destPath = path.join(tempDir, "ccreq.md");
                    // It's likely JSON or text, just save it.
                    fs.writeFileSync(destPath, content);
                    Logger.debug(`Saved ccreq content to ${destPath}`);
                } catch (readErr) {
                    Logger.warn(`Failed to read/save ccreq file ${ccreqPath}: ${readErr}`);
                }
            }

            const meta = {
                input_timestamp: timestamp,
                capture_timestamp: currTimestamp,
                contains_ccreq: !!ccreqPath,
            };
            fs.writeFileSync(path.join(tempDir, '_meta.json'), JSON.stringify(meta, null, 2));

        } catch (err) {
            Logger.error(`Error capturing snapshot: ${err}`);
        }
    }

    async uploadDirectory(dirPath: string, s3Prefix: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('copilotArchiver');
        if (!config.get<boolean>('s3.enabled', false)) return;

        const files: string[] = [];

        const walk = (dir: string) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!entry.name.startsWith('.')) { // basic skip
                        walk(fullPath);
                    }
                } else {
                    files.push(fullPath);
                }
            }
        };

        try {
            walk(dirPath);
            Logger.info(`Uploading ${files.length} files from ${dirPath} to S3...`);

            // Use a simple concurrency limit
            const CONCURRENCY = 50;
            for (let i = 0; i < files.length; i += CONCURRENCY) {
                const chunk = files.slice(i, i + CONCURRENCY);
                await Promise.all(chunk.map(file => {
                    const relativePath = path.relative(dirPath, file);
                    // Use forward slashes for S3 keys regardless of OS
                    const s3Key = path.join(s3Prefix, relativePath).replace(/\\/g, '/');

                    // Respect exclude patterns
                    if (this.shouldExclude(file, dirPath)) {
                        return Promise.resolve();
                    }

                    return this.uploadToS3(file, s3Key);
                }));
            }
            Logger.info(`Upload complete for ${dirPath}`);
        } catch (err) {
            Logger.error(`Error uploading directory ${dirPath}: ${err}`);
        }
    }

    private async uploadToS3(filePath: string, key: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('copilotArchiver');
        const backendUrl = config.get<string>('backendUrl');

        if (!backendUrl) return;

        try {
            // Get JWT Token
            const token = await this.secretStorage.get('archiver.jwt');
            if (!token) {
                Logger.warn("Upload skipped: No Login Token found.");
                const selection = await vscode.window.showErrorMessage(
                    "Copilot Archiver: You are not logged in. Snapshots are not being uploaded.",
                    "Login"
                );
                if (selection === "Login") {
                    vscode.commands.executeCommand('copilotArchiver.login');
                }
                return;
            }

            // 1. Get Presigned URL
            const response = await fetch(`${backendUrl}/sign-upload`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ key })
            });

            if (!response.ok) {
                if (response.status === 401 || response.status === 403) {
                    await this.secretStorage.delete('archiver.jwt');
                    const selection = await vscode.window.showErrorMessage(
                        "Copilot Archiver: Login session expired. Please login again.",
                        "Login"
                    );
                    if (selection === "Login") {
                        vscode.commands.executeCommand('copilotArchiver.login');
                    }
                    return;
                }
                throw new Error(`Backend returned ${response.status}: ${response.statusText}`);
            }

            const data = await response.json() as { uploadUrl: string };
            const uploadUrl = data.uploadUrl;

            // 2. Upload to S3
            const fileContent = fs.readFileSync(filePath);
            const uploadResponse = await fetch(uploadUrl, {
                method: 'PUT',
                body: fileContent
            });

            if (!uploadResponse.ok) {
                throw new Error(`S3 Upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
            }

        } catch (err) {
            Logger.error(`Error uploading to S3 via Backend: ${err}`);
            // Still throw to indicate failure.
            throw err;
        }
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

    async updateChatSessionFile(chatId: string, sessionData: any): Promise<void> {
        try {
            const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
            if (!workspacePath) return;

            const chatDir = path.join(workspacePath, this.outputPath, chatId);
            if (!fs.existsSync(chatDir)) {
                fs.mkdirSync(chatDir, { recursive: true });
            }

            // Overwrite chat_session.json with latest data
            const sessionFilePath = path.join(chatDir, 'chat_session.json');
            fs.writeFileSync(sessionFilePath, JSON.stringify(sessionData, null, 2));
            Logger.info(`Updated chat_session.json for ${chatId}`);

            // Upload updated session file
            const config = vscode.workspace.getConfiguration('copilotArchiver');
            if (config.get<boolean>('s3.enabled', false)) {
                const s3FolderPrefix = config.get<string>('s3.folderPrefix', 'copilot-snapshots');
                const s3Key = `${s3FolderPrefix}/${chatId}/chat_session.json`;
                this.uploadToS3(sessionFilePath, s3Key).catch(e => Logger.error(`Session file upload failed: ${e}`));
            }

        } catch (err) {
            Logger.error(`Failed to update chat session file: ${err}`);
        }
    }
}
