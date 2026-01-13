import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { Logger } from './logger';
import { SNAPSHOT_BLACKLIST_PATTERNS, MAX_FILE_SIZE_BYTES } from './constants';
import { S3Uploader } from './s3Uploader';

export class ShadowGitManager {
    private shadowRoot: string | undefined;
    private workspaceRoot: string | undefined;

    // State flag to distinguish Agent vs User edits
    public isAgentActing: boolean = false;
    private s3Uploader: S3Uploader;
    private globalState: vscode.Memento;

    // Debounce & State Tracking
    private lastUploadedHead: string = '';
    private lastUploadTime: number = 0;
    private uploadTimer: NodeJS.Timeout | undefined;
    private isSyncing: boolean = false;
    private pendingSync: boolean = false;
    private readonly UPLOAD_COOLDOWN_MS = 60000; // 1 minute

    constructor(context: vscode.ExtensionContext) {
        this.s3Uploader = new S3Uploader(context.secrets);
        this.globalState = context.globalState;
        this.initialize();
    }

    private async initialize() {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            return;
        }

        this.workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        this.shadowRoot = path.join(this.workspaceRoot, '.archiver_shadow');

        try {
            // 1. Create/Init Shadow Repo
            if (!fs.existsSync(this.shadowRoot)) {
                fs.mkdirSync(this.shadowRoot, { recursive: true });
                await this.runGitCommand(['init'], this.shadowRoot);
                // Configure user for this repo to avoid "Please tell me who you are" errors
                await this.runGitCommand(['config', 'user.email', 'archiver@copilot.local'], this.shadowRoot);
                await this.runGitCommand(['config', 'user.name', 'Copilot Archiver'], this.shadowRoot);
                Logger.info('Initialized Shadow Git repository.');

                await this.populateShadowRepo();
            }

            // 2. Hide from VS Code Source Control
            const config = vscode.workspace.getConfiguration('git');
            const ignoredRepos = config.get<string[]>('ignoredRepositories') || [];
            if (!ignoredRepos.includes('.archiver_shadow')) {
                // Update workspace settings to avoid polluting user's global settings
                await config.update('ignoredRepositories', [...ignoredRepos, '.archiver_shadow'], vscode.ConfigurationTarget.Workspace);
                Logger.info('Added .archiver_shadow to git.ignoredRepositories.');
            }

            // 3. Add to .gitignore
            const gitignorePath = path.join(this.workspaceRoot, '.gitignore');
            let content = '';
            if (fs.existsSync(gitignorePath)) {
                content = fs.readFileSync(gitignorePath, 'utf8');
            }

            const entriesToAdd: string[] = [];
            if (!content.includes('.archiver_shadow')) entriesToAdd.push('.archiver_shadow/');
            if (!content.includes('.snapshots')) entriesToAdd.push('.snapshots/');

            if (entriesToAdd.length > 0) {
                const append = (content.length > 0 && !content.endsWith('\n') ? '\n' : '') + entriesToAdd.join('\n') + '\n';
                fs.appendFileSync(gitignorePath, append);
                Logger.info('Added .archiver_shadow and .snapshots to .gitignore.');
            }

        } catch (err) {
            Logger.error(`ShadowGit initialization failed: ${err}`);
        }
    }

    /**
     * Checks if a file should be tracked based on blacklist and size.
     */
    private shouldTrackFile(uri: vscode.Uri, relativePath: string): boolean {
        // 1. Blacklist & Extension Check
        const segments = relativePath.split(/[/\\]/);
        const ext = path.extname(uri.fsPath).toLowerCase();
        if (segments.some(s => s.startsWith('.') || SNAPSHOT_BLACKLIST_PATTERNS.includes(s)) || SNAPSHOT_BLACKLIST_PATTERNS.includes(ext)) {
            return false;
        }

        // 2. Size Check
        try {
            const stats = fs.statSync(uri.fsPath);
            if (stats.size > MAX_FILE_SIZE_BYTES) {
                Logger.warn(`ShadowGit: Skipping large file ${relativePath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
                return false;
            }
        } catch (e) {
            return false;
        }

        return true;
    }

    async handleFileSave(document: vscode.TextDocument) {
        if (!this.workspaceRoot || !this.shadowRoot) return;
        if (!document.uri.fsPath.startsWith(this.workspaceRoot)) return;
        if (document.fileName.includes('.git') || document.fileName.includes('.archiver_shadow')) return;

        const relativePath = path.relative(this.workspaceRoot, document.uri.fsPath);

        if (!this.shouldTrackFile(document.uri, relativePath)) {
            return;
        }

        // Clear any pending dirty timer, as we are about to save the real file
        if (this.dirtyTimers.has(document.uri.fsPath)) {
            clearTimeout(this.dirtyTimers.get(document.uri.fsPath)!);
            this.dirtyTimers.delete(document.uri.fsPath);
        }

        try {
            // Copy file to shadow repo
            const shadowFilePath = path.join(this.shadowRoot, relativePath);
            const shadowFileDir = path.dirname(shadowFilePath);

            if (!fs.existsSync(shadowFileDir)) {
                fs.mkdirSync(shadowFileDir, { recursive: true });
            }

            // Use copyFileSync to ensure exact content
            fs.copyFileSync(document.uri.fsPath, shadowFilePath);

            // Commit
            await this.runGitCommand(['add', '.'], this.shadowRoot);

            const msg = this.isAgentActing ? `AGENT UPDATE: ${relativePath}` : `USER EDIT: ${relativePath}`;
            await this.runGitCommand(['commit', '-m', msg], this.shadowRoot);

            Logger.debug(`ShadowGit: Committed ${relativePath} (${this.isAgentActing ? 'Agent' : 'User'})`);

            // Trigger Debounced Sync
            this.triggerThrottledSync();

        } catch (err) {
            // It's possible `git commit` fails if there are no changes (clean tree). That's fine.
            const errMsg = String(err);
            if (!errMsg.includes('nothing to commit')) {
                Logger.error(`ShadowGit Commit Error: ${err}`);
            }
        }
    }

    async handleFileDelete(event: vscode.FileDeleteEvent) {
        if (!this.workspaceRoot || !this.shadowRoot) return;

        let deletedCount = 0;

        for (const uri of event.files) {
            // Only handle files inside the workspace
            if (!uri.fsPath.startsWith(this.workspaceRoot)) continue;

            const relativePath = path.relative(this.workspaceRoot, uri.fsPath);
            const shadowFilePath = path.join(this.shadowRoot, relativePath);

            // If it exists in shadow repo, delete it
            if (fs.existsSync(shadowFilePath)) {
                try {
                    const stats = fs.statSync(shadowFilePath);
                    if (stats.isDirectory()) {
                        // Recursively count files before deleting
                        const countFiles = (dir: string): number => {
                            let c = 0;
                            const entries = fs.readdirSync(dir, { withFileTypes: true });
                            for (const entry of entries) {
                                const fullPath = path.join(dir, entry.name);
                                if (entry.isDirectory()) {
                                    c += countFiles(fullPath);
                                } else {
                                    c++;
                                }
                            }
                            return c;
                        };
                        deletedCount += countFiles(shadowFilePath);
                        fs.rmSync(shadowFilePath, { recursive: true, force: true });
                    } else {
                        fs.unlinkSync(shadowFilePath);
                        deletedCount++;
                    }
                } catch (e) {
                    Logger.error(`ShadowGit: Failed to delete shadow file ${relativePath}: ${e}`);
                }
            }
        }

        if (deletedCount > 0) {
            try {
                await this.runGitCommand(['add', '.'], this.shadowRoot);
                const msg = this.isAgentActing
                    ? `AGENT DELETE: ${deletedCount} files`
                    : `USER DELETE: ${deletedCount} files`;
                await this.runGitCommand(['commit', '-m', msg], this.shadowRoot);
                Logger.debug(`ShadowGit: Committed deletions (${deletedCount} files)`);
                this.triggerThrottledSync();
            } catch (err) {
                const errMsg = String(err);
                if (!errMsg.includes('nothing to commit')) {
                    Logger.error(`ShadowGit Delete Commit Error: ${err}`);
                }
            }
        }
    }

    async handleFileCreate(event: vscode.FileCreateEvent) {
        if (!this.workspaceRoot || !this.shadowRoot) return;

        let createdCount = 0;

        for (const uri of event.files) {
            if (!uri.fsPath.startsWith(this.workspaceRoot)) continue;

            const relativePath = path.relative(this.workspaceRoot, uri.fsPath);
            const shadowFilePath = path.join(this.shadowRoot, relativePath);

            try {
                // If it's a directory
                if (fs.statSync(uri.fsPath).isDirectory()) {
                    // Check if empty
                    if (fs.readdirSync(uri.fsPath).length === 0) {
                        // Recursive handling for directories
                        createdCount += await this.processDirectoryCreate(uri.fsPath);
                    } else {
                        // Single file
                        if (this.shouldTrackFile(uri, relativePath)) {
                            const shadowFileDir = path.dirname(shadowFilePath);
                            if (!fs.existsSync(shadowFileDir)) {
                                fs.mkdirSync(shadowFileDir, { recursive: true });
                            }
                            fs.copyFileSync(uri.fsPath, shadowFilePath);
                            createdCount++;
                        }
                    }
                }
            } catch (err) {
                Logger.error(`ShadowGit: Failed to create shadow item ${relativePath}: ${err}`);
            }
        }

        if (createdCount > 0) {
            try {
                await this.runGitCommand(['add', '.'], this.shadowRoot);
                const msg = this.isAgentActing
                    ? `AGENT CREATE: ${createdCount} files`
                    : `USER CREATE: ${createdCount} files`;
                await this.runGitCommand(['commit', '-m', msg], this.shadowRoot);
                Logger.debug(`ShadowGit: Committed creation (${createdCount} files)`);
                this.triggerThrottledSync();
            } catch (err) {
                const errMsg = String(err);
                if (!errMsg.includes('nothing to commit')) {
                    Logger.error(`ShadowGit Create Commit Error: ${err}`);
                }
            }
        }
    }

    // Helper to recursively add a directory
    private async processDirectoryCreate(dirPath: string): Promise<number> {
        if (!this.workspaceRoot || !this.shadowRoot) return 0;
        let count = 0;

        const entries = fs.readdirSync(dirPath, { withFileTypes: true });

        // 1. Handle Empty Directory
        if (entries.length === 0) {
            const relativePath = path.relative(this.workspaceRoot, dirPath);
            const shadowDirPath = path.join(this.shadowRoot, relativePath);
            if (!fs.existsSync(shadowDirPath)) {
                fs.mkdirSync(shadowDirPath, { recursive: true });
            }
            fs.writeFileSync(path.join(shadowDirPath, '.gitkeep'), '');
            return 1;
        }

        // 2. Recurse
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                count += await this.processDirectoryCreate(fullPath);
            } else {
                const relativePath = path.relative(this.workspaceRoot, fullPath);
                const uri = vscode.Uri.file(fullPath);
                if (this.shouldTrackFile(uri, relativePath)) {
                    const shadowFilePath = path.join(this.shadowRoot, relativePath);
                    const shadowFileDir = path.dirname(shadowFilePath);
                    if (!fs.existsSync(shadowFileDir)) {
                        fs.mkdirSync(shadowFileDir, { recursive: true });
                    }
                    fs.copyFileSync(fullPath, shadowFilePath);
                    count++;
                }
            }
        }
        return count;
    }

    async handleFileRename(event: vscode.FileRenameEvent) {
        if (!this.workspaceRoot || !this.shadowRoot) return;

        let renamedCount = 0;

        for (const { oldUri, newUri } of event.files) {
            if (!oldUri.fsPath.startsWith(this.workspaceRoot) || !newUri.fsPath.startsWith(this.workspaceRoot)) continue;

            const oldRelativePath = path.relative(this.workspaceRoot, oldUri.fsPath);
            const newRelativePath = path.relative(this.workspaceRoot, newUri.fsPath);

            const oldshadowPath = path.join(this.shadowRoot, oldRelativePath);
            const newShadowPath = path.join(this.shadowRoot, newRelativePath);

            if (fs.existsSync(oldshadowPath)) {
                // Case 1: Source existed in shadow repo -> Rename it
                try {
                    const newShadowDir = path.dirname(newShadowPath);
                    if (!fs.existsSync(newShadowDir)) {
                        fs.mkdirSync(newShadowDir, { recursive: true });
                    }

                    fs.renameSync(oldshadowPath, newShadowPath);
                    renamedCount++;
                } catch (err) {
                    Logger.error(`ShadowGit: Failed to move file ${oldRelativePath} -> ${newRelativePath}: ${err}`);
                }
            } else {
                // Case 2: Source didn't exist in shadow (maybe untracked/ignored) -> Treat as new create
                try {
                    if (fs.statSync(newUri.fsPath).isDirectory()) {
                        renamedCount += await this.processDirectoryCreate(newUri.fsPath);
                    } else {
                        if (this.shouldTrackFile(newUri, newRelativePath)) {
                            const newShadowDir = path.dirname(newShadowPath);
                            if (!fs.existsSync(newShadowDir)) {
                                fs.mkdirSync(newShadowDir, { recursive: true });
                            }
                            fs.copyFileSync(newUri.fsPath, newShadowPath);
                            renamedCount++;
                        }
                    }
                } catch (e) { /* ignore */ }
            }
        }

        if (renamedCount > 0) {
            try {
                await this.runGitCommand(['add', '.'], this.shadowRoot);
                const msg = this.isAgentActing
                    ? `AGENT RENAME: ${renamedCount} files`
                    : `USER RENAME: ${renamedCount} files`;
                await this.runGitCommand(['commit', '-m', msg], this.shadowRoot);
                Logger.debug(`ShadowGit: Committed rename (${renamedCount} files)`);
                this.triggerThrottledSync();
            } catch (err) {
                const errMsg = String(err);
                if (!errMsg.includes('nothing to commit')) {
                    Logger.error(`ShadowGit Rename Commit Error: ${err}`);
                }
            }
        }
    }

    // Debounce timer map for dirty files: fsPath -> Timer
    private dirtyTimers: Map<string, NodeJS.Timeout> = new Map();
    private readonly DIRTY_DEBOUNCE_MS = 5000;

    async handleFileChange(document: vscode.TextDocument) {
        if (!this.workspaceRoot || !this.shadowRoot) return;
        if (!document.uri.fsPath.startsWith(this.workspaceRoot)) return;
        // Skip large files, blacklisted, etc.
        const relativePath = path.relative(this.workspaceRoot, document.uri.fsPath);
        if (!this.shouldTrackFile(document.uri, relativePath)) return;

        const fsPath = document.uri.fsPath;

        // Clear existing timer for this file
        if (this.dirtyTimers.has(fsPath)) {
            clearTimeout(this.dirtyTimers.get(fsPath)!);
            this.dirtyTimers.delete(fsPath);
        }

        // Set new timer
        const timer = setTimeout(async () => {
            this.dirtyTimers.delete(fsPath); // Remove self

            // Re-check validity just in case
            if (!fs.existsSync(this.shadowRoot!)) return;

            try {
                const shadowFilePath = path.join(this.shadowRoot!, relativePath);
                const shadowFileDir = path.dirname(shadowFilePath);

                if (!fs.existsSync(shadowFileDir)) {
                    fs.mkdirSync(shadowFileDir, { recursive: true });
                }

                // Write DIRTY content (from memory)
                fs.writeFileSync(shadowFilePath, document.getText());

                // Commit
                await this.runGitCommand(['add', '.'], this.shadowRoot!);
                const msg = `DIRTY SNAPSHOT: ${relativePath}`;
                await this.runGitCommand(['commit', '-m', msg], this.shadowRoot!);

                Logger.debug(`ShadowGit: Committed dirty snapshot for ${relativePath}`);
                this.triggerThrottledSync();

            } catch (err) {
                const errMsg = String(err);
                if (!errMsg.includes('nothing to commit')) {
                    Logger.error(`ShadowGit Dirty Commit Error: ${err}`);
                }
            }

        }, this.DIRTY_DEBOUNCE_MS);

        this.dirtyTimers.set(fsPath, timer);
    }

    private triggerThrottledSync() {
        // If a sync is already scheduled, we don't need to do anything.
        // It will pick up the latest state when it runs.
        if (this.uploadTimer) return;

        const now = Date.now();
        const timeSinceLast = now - this.lastUploadTime;

        if (timeSinceLast >= this.UPLOAD_COOLDOWN_MS) {
            Logger.debug('ShadowGit: Cooldown passed. Triggering sync immediately.');
            this.syncToS3();
        } else {
            const delay = this.UPLOAD_COOLDOWN_MS - timeSinceLast;
            Logger.debug(`ShadowGit: Throttling sync. Scheduled in ${delay}ms`);
            this.uploadTimer = setTimeout(() => {
                this.syncToS3();
            }, delay);
        }
    }

    async syncToS3(force: boolean = false) {
        if (!this.shadowRoot) return;

        // Prevent concurrent uploads
        if (this.isSyncing) {
            Logger.debug('ShadowGit: Sync already in progress. Marking pending.');
            this.pendingSync = true;
            return;
        }

        this.isSyncing = true;
        this.pendingSync = false;
        // Clear timer if this run was triggered by one
        if (this.uploadTimer) {
            clearTimeout(this.uploadTimer);
            this.uploadTimer = undefined;
        }

        Logger.info('ShadowGit: Starting Sync Check...');
        try {
            // 1. Check for Changes (HEAD vs Last Uploaded HEAD)
            const currentHead = await this.runGitCommand(['rev-parse', 'HEAD'], this.shadowRoot);

            if (!force && currentHead === this.lastUploadedHead) {
                Logger.info('ShadowGit: Skipping sync (No changes since last upload).');
                return;
            }

            // 2. Create Bundle
            // We use a temp name first
            const timestamp = new Date().toISOString().replace(/:/g, '_');
            const tempBundleName = `temp_${timestamp}.bundle`;
            const bundlePath = path.join(this.shadowRoot, tempBundleName);

            // Bundle all branches/tags
            await this.runGitCommand(['bundle', 'create', tempBundleName, '--all'], this.shadowRoot);

            if (!fs.existsSync(bundlePath)) {
                Logger.warn('ShadowGit: No bundle created (maybe empty repo?)');
                return;
            }

            const stats = fs.statSync(bundlePath);
            Logger.info(`ShadowGit: Bundle created (${(stats.size / 1024).toFixed(2)} KB). Uploading...`);

            // 3. Upload Static Bundle (Always triggers on valid change)
            const config = vscode.workspace.getConfiguration('copilotArchiver');
            const s3FolderPrefix = config.get<string>('s3.folderPrefix', 'copilot-snapshots');
            const workspaceName = this.workspaceRoot ? path.basename(this.workspaceRoot) : 'unknown_workspace';
            const safeWorkspaceName = workspaceName.replace(/[^a-zA-Z0-9_\-]/g, '_');

            const staticS3Key = `${s3FolderPrefix}/${safeWorkspaceName}/shadow_git/shadow_git.bundle`;

            await this.s3Uploader.uploadFile(bundlePath, staticS3Key);
            Logger.info('ShadowGit: Static bundle uploaded.');

            // 4. Daily Backup Check
            const lastDailyKey = `shadowGit.lastDailyUpload.${safeWorkspaceName}`;
            const lastDailyUpload = this.globalState.get<number>(lastDailyKey) || 0;
            const now = Date.now();
            const ONE_DAY_MS = 24 * 60 * 60 * 1000;

            if (now - lastDailyUpload > ONE_DAY_MS) {
                Logger.info('ShadowGit: Performing Daily Backup...');
                const dailyBundleName = `history_${timestamp}.bundle`;
                const dailyS3Key = `${s3FolderPrefix}/${safeWorkspaceName}/shadow_git/${dailyBundleName}`;

                // Upload the SAME bundle file to the history location
                await this.s3Uploader.uploadFile(bundlePath, dailyS3Key);

                // Update timestamp
                await this.globalState.update(lastDailyKey, now);
                Logger.info(`ShadowGit: Daily backup uploaded as ${dailyBundleName}`);
            }

            // 5. Cleanup
            fs.unlinkSync(bundlePath);

            // Update State
            this.lastUploadedHead = currentHead;
            this.lastUploadTime = Date.now(); // Update timestamp only on success
            Logger.info('ShadowGit: Sync complete.');

        } catch (err) {
            Logger.error(`ShadowGit Sync Failed: ${err}`);
        } finally {
            this.isSyncing = false;
            // Handle pending triggers (occurred during upload)
            if (this.pendingSync) {
                this.triggerThrottledSync();
            }
        }
    }

    async populateShadowRepo() {
        if (!this.workspaceRoot || !this.shadowRoot) return;
        Logger.info('ShadowGit: Populating initial repo...');

        try {
            // Optimization: Exclude hidden files (starting with .) directly in the search
            // We still need to exclude node_modules broadly
            const excludePattern = '{**/node_modules/**,**/.*/**}';
            const files = await vscode.workspace.findFiles('**/*', excludePattern);

            let count = 0;
            for (const file of files) {
                const relativePath = vscode.workspace.asRelativePath(file);

                // We trust finding 'exclude' for .git etc, but double check our custom logic
                if (!this.shouldTrackFile(file, relativePath)) {
                    continue;
                }

                try {
                    const shadowFilePath = path.join(this.shadowRoot, relativePath);
                    const shadowFileDir = path.dirname(shadowFilePath);

                    if (!fs.existsSync(shadowFileDir)) {
                        fs.mkdirSync(shadowFileDir, { recursive: true });
                    }
                    fs.copyFileSync(file.fsPath, shadowFilePath);
                    count++;
                } catch (err) {
                    Logger.error(`ShadowGit: Failed to copy file ${relativePath}: ${err}`);
                }
            }

            if (count > 0) {
                await this.runGitCommand(['add', '.'], this.shadowRoot);
                await this.runGitCommand(['commit', '-m', 'Initial Shadow Repo Commit'], this.shadowRoot);
                Logger.info(`ShadowGit: Initial commit complete (${count} files).`);

                // Trigger sync immediately to backup this initial state
                this.triggerThrottledSync();
            } else {
                Logger.info('ShadowGit: No files to commit in initial scan.');
            }

        } catch (err) {
            Logger.error(`ShadowGit population failed: ${err}`);
        }
    }

    private runGitCommand(args: string[], cwd: string): Promise<string> {
        return new Promise((resolve, reject) => {
            cp.execFile('git', args, { cwd: cwd }, (err, stdout, stderr) => {
                if (err) {
                    reject(new Error(`${stderr} (Exit Code: ${err.code})`));
                } else {
                    resolve(stdout.trim());
                }
            });
        });
    }
}
