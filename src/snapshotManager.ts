import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import archiver = require('archiver');
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { log, error as logError } from './logger';

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
    private chatId: string;
    private s3Client: S3Client | undefined;
    private s3Bucket: string | undefined;
    private s3FolderPrefix: string | undefined;
    private isProcessing: boolean = false;

    constructor(chatId: string) {
        this.chatId = chatId;
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

        // Initialize S3 if enabled
        if (config.get<boolean>('s3.enabled', false)) {
            const region = config.get<string>('s3.region', 'us-east-1');
            const accessKeyId = config.get<string>('s3.accessKeyId', '');
            const secretAccessKey = config.get<string>('s3.secretAccessKey', '');
            this.s3Bucket = config.get<string>('s3.bucket', '');
            this.s3FolderPrefix = config.get<string>('s3.folderPrefix', 'copilot-snapshots');

            if (accessKeyId && secretAccessKey && this.s3Bucket) {
                this.s3Client = new S3Client({
                    region,
                    credentials: {
                        accessKeyId,
                        secretAccessKey
                    }
                });
                log('S3 Client initialized');
            } else {
                logError('S3 enabled but missing credentials or bucket name');
            }
        }
    }

    getOutputPath(): string {
        return this.outputPath;
    }

    async captureSnapshot(
        workspacePath: string,
        turnIndex?: number,
        debugTimestamp?: string,
        debugMessages?: any[],
        debugTurnCount?: number
    ): Promise<void> {
        if (this.isProcessing) {
            log('Snapshot already in progress, skipping...');
            return;
        }

        this.isProcessing = true;

        try {
            const workspaceName = path.basename(workspacePath);

            // Determine turn index
            const actualTurnIndex = turnIndex ?? await this.getNextTurnIndex(workspacePath);

            // Create snapshot directory: .snapshots/<chat_id>/<turn_index>
            const snapshotDir = path.join(workspacePath, this.outputPath, this.chatId, `${actualTurnIndex}`);

            // Create snapshot directory
            if (!fs.existsSync(snapshotDir)) {
                fs.mkdirSync(snapshotDir, { recursive: true });
            }

            // Copy workspace files
            const stats = await this.copyFiles(workspacePath, snapshotDir, workspacePath);
            log(`Snapshot created at ${snapshotDir}`);

            // Create metadata file
            const metadata: SnapshotMetadata = {
                turn_index: actualTurnIndex,
                timestamp: debugTimestamp ?? new Date().toISOString(),
                workspace_path: workspacePath,
                chat_id: this.chatId,
                repo_path: workspacePath,
                files_count: stats.filesCount,
                total_size_bytes: stats.totalSize,
                // Store the structured chat data if available
                chat_data: debugMessages && debugMessages.length > 0 ? debugMessages[0] : undefined
            };

            const metadataPath = path.join(snapshotDir, '_snapshot_metadata.json');
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

            // Zip and Upload to S3
            if (this.s3Client && this.s3Bucket) {
                try {
                    const zipPath = await this.zipSnapshot(snapshotDir, actualTurnIndex);
                    await this.uploadToS3(zipPath, `${this.s3FolderPrefix}/${this.chatId}/${actualTurnIndex}.zip`);
                    // Optional: Clean up zip file after upload? Keeping it for now as local backup.
                    // fs.unlinkSync(zipPath); 
                } catch (err) {
                    logError(`Failed to zip/upload snapshot: ${err}`);
                }
            }
        } catch (err) {
            logError(`Failed to capture snapshot: ${err}`);
        } finally {
            this.isProcessing = false;
        }
    }

    private async zipSnapshot(sourceDir: string, turnIndex: number): Promise<string> {
        return new Promise((resolve, reject) => {
            const zipPath = path.join(path.dirname(sourceDir), `${turnIndex}.zip`);
            const output = fs.createWriteStream(zipPath);
            const archive = archiver('zip', {
                zlib: { level: 9 } // Sets the compression level.
            });

            output.on('close', () => {
                log(`${archive.pointer()} total bytes`);
                log('archiver has been finalized and the output file descriptor has closed.');
                resolve(zipPath);
            });

            archive.on('error', (err: any) => {
                reject(err);
            });

            archive.pipe(output);
            archive.directory(sourceDir, false);
            archive.finalize();
        });
    }

    private async uploadToS3(filePath: string, key: string): Promise<void> {
        if (!this.s3Client || !this.s3Bucket) return;

        const fileContent = fs.readFileSync(filePath);
        const command = new PutObjectCommand({
            Bucket: this.s3Bucket,
            Key: key,
            Body: fileContent
        });

        try {
            await this.s3Client.send(command);
            log(`Successfully uploaded ${key} to S3`);
        } catch (err) {
            logError(`Error uploading to S3: ${err}`);
            throw err;
        }
    }

    private countTurnsFromMessages(messages: any[]): number {
        let turns = 0;
        for (const msg of messages) {
            if (msg && msg.role === 'user') {
                const contentText = this.extractContentText(msg.content);
                if (contentText.includes('<userRequest>')) {
                    turns += 1;
                }
            }
        }
        return turns;
    }

    private extractContentText(content: any): string {
        if (typeof content === 'string') {
            return content;
        }
        if (Array.isArray(content) && content.length > 0) {
            const parts: string[] = [];
            for (const item of content) {
                if (item && typeof item === 'object') {
                    if (item.type === 'input_text' && typeof item.text === 'string') {
                        parts.push(item.text);
                    } else if (item.type === 'output_text' && typeof item.text === 'string') {
                        parts.push(item.text);
                    } else if (typeof item.text === 'string' && item.type !== 'input_text' && item.type !== 'output_text' && item.type !== 'input_image' && item.type !== 'output_image') {
                        parts.push(item.text);
                    }
                }
            }
            return parts.join('\n');
        }
        return content ? String(content) : '';
    }

    private async getNextTurnIndex(workspacePath: string): Promise<number> {
        // Check .snapshots/<chat_id>/
        const chatSnapshotsDir = path.join(workspacePath, this.outputPath, this.chatId);

        if (!fs.existsSync(chatSnapshotsDir)) {
            return 0;
        }

        const entries = fs.readdirSync(chatSnapshotsDir, { withFileTypes: true });
        const turnDirs = entries
            .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
            .map(entry => {
                return parseInt(entry.name, 10);
            })
            .filter(index => !isNaN(index) && index >= 0);

        return turnDirs.length > 0 ? Math.max(...turnDirs) + 1 : 0;
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
