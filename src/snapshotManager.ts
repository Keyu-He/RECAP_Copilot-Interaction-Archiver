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

    async captureSnapshot(
        workspacePath: string,
        chatId: string,
        turnIndex: number,
        debugTimestamp: string,
        debugMessages?: any[],
        debugTurnCount?: number,
        phase?: 'input' | 'output',
        chatSessionPath?: string
    ): Promise<void> {
        try {
            const workspaceName = path.basename(workspacePath);

            // Create snapshot directory: .snapshots/<chat_id>/<turn_index>
            const snapshotDir = path.join(workspacePath, this.outputPath, chatId, `${turnIndex}${phase ? `_${phase}` : ''}`);
            // Create snapshot directory
            if (!fs.existsSync(snapshotDir)) {
                fs.mkdirSync(snapshotDir, { recursive: true });
            }

            // Copy workspace files
            const stats = await this.copyFiles(workspacePath, snapshotDir, workspacePath);
            Logger.info(`Snapshot created at ${snapshotDir}`);

            // Copy Chat Session JSON if provided
            if (chatSessionPath && fs.existsSync(chatSessionPath)) {
                const destSessionPath = path.join(snapshotDir, path.basename(chatSessionPath));
                fs.copyFileSync(chatSessionPath, destSessionPath);
            }

            // Create metadata file
            const metadata: SnapshotMetadata = {
                turn_index: turnIndex,
                timestamp: debugTimestamp,
                workspace_path: workspacePath,
                chat_id: chatId,
                repo_path: workspacePath,
                files_count: stats.filesCount,
                total_size_bytes: stats.totalSize,
                // Store the structured chat data if available
                chat_data: debugMessages && debugMessages.length > 0 ? debugMessages[0] : undefined
            };

            const metadataPath = path.join(snapshotDir, '_snapshot_metadata.json');
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

            // Zip and Upload to S3
            // Upload to S3 if enabled
            const config = vscode.workspace.getConfiguration('copilotArchiver');
            if (config.get<boolean>('s3.enabled', false)) {
                const s3FolderPrefix = config.get<string>('s3.folderPrefix', 'copilot-snapshots');
                const s3KeyPrefix = `${s3FolderPrefix}/${chatId}/${turnIndex}${phase ? `_${phase}` : ''}`;
                // Upload directory recursively
                await this.uploadDirectory(snapshotDir, s3KeyPrefix);
            }
        } catch (err) {
            Logger.error(`Failed to capture snapshot: ${err}`);
        }
    }


    async captureTempSnapshot(phase?: 'input' | 'output'): Promise<void> {
        try {
            const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
            if (!workspacePath) return;

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const tempDirName = phase ? `${timestamp}_${phase}` : timestamp;
            const tempDir = path.join(workspacePath, this.outputPath, '_temp', tempDirName);

            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');

            for (const file of files) {
                const relativePath = vscode.workspace.asRelativePath(file);
                if (relativePath.startsWith('.snapshots') || relativePath.startsWith('.git') || relativePath.includes('node_modules')) {
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

            const meta = {
                timestamp: new Date().toISOString(),
                phase: phase,
                ready: true
            };
            fs.writeFileSync(path.join(tempDir, '_meta.json'), JSON.stringify(meta, null, 2));

        } catch (err) {
            Logger.error(`Error capturing temp snapshot: ${err}`);
        }
    }



    async uploadFile(filePath: string, s3Key: string): Promise<void> {
        return this.uploadToS3(filePath, s3Key);
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
                const selection = await vscode.window.showWarningMessage(
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
                    const selection = await vscode.window.showWarningMessage(
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

            // Logger.info(`Uploaded ${key}`); 
        } catch (err) {
            Logger.error(`Error uploading to S3 via Backend: ${err}`);
            // Don't throw, just log to allow other files to proceed? 
            // Or maybe throw to indicate failure.
            throw err;
        }
    }

    private async copyFiles(
        src: string,
        dest: string,
        workspaceRoot: string
    ): Promise<{ filesCount: number; totalSize: number }> {
        let filesCount = 0;
        let totalSize = 0;

        const entries = fs.readdirSync(src, { withFileTypes: true });

        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);

            // Skip dot-directories entirely (e.g., .mypy_cache, .git, .venv, etc.)
            if (entry.isDirectory() && entry.name.startsWith('.')) {
                continue;
            }

            // Check if should be excluded
            if (this.shouldExclude(srcPath, workspaceRoot)) {
                continue;
            }

            if (entry.isDirectory()) {
                fs.mkdirSync(destPath, { recursive: true });
                const subStats = await this.copyFiles(srcPath, destPath, workspaceRoot);
                filesCount += subStats.filesCount;
                totalSize += subStats.totalSize;
            } else if (entry.isFile()) {
                const stats = fs.statSync(srcPath);
                fs.copyFileSync(srcPath, destPath);
                filesCount++;
                totalSize += stats.size;
            }
        }

        return { filesCount, totalSize };
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
}
