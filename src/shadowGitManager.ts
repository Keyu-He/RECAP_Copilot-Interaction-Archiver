import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';
import { Logger } from './logger';
import { SNAPSHOT_BLACKLIST_PATTERNS, MAX_FILE_SIZE_BYTES } from './constants';
import { S3Uploader } from './s3Uploader';
import { shouldTrackFile } from './fileUtils';

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
    private readonly UPLOAD_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

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
            // 0. Safety Check: If Repo is Bloated (> 1GB), Nuke it.
            if (fs.existsSync(this.shadowRoot)) {
                const size = await this.getFolderSize(this.shadowRoot);
                const MAX_REPO_SIZE = 1 * 1024 * 1024 * 1024; // 1GB
                if (size > MAX_REPO_SIZE) {
                    Logger.warn(`ShadowGit: Repo bloated (${(size / 1024 / 1024 / 1024).toFixed(2)} GB). Performing Hard Reset.`);

                    // Upload Reset Log to S3
                    try {
                        const timestamp = new Date().toISOString().replace(/[:.]/g, '_');
                        const workspaceName = this.workspaceRoot ? path.basename(this.workspaceRoot) : 'unknown';
                        const safeWorkspaceName = workspaceName.replace(/[^a-zA-Z0-9_\-]/g, '_');

                        const logContent = `Repo size: ${(size / 1024 / 1024 / 1024).toFixed(4)} GB\nReset performed at: ${new Date().toISOString()}`;
                        const logPath = path.join(this.shadowRoot, 'reset_log.txt');

                        // Write to shadow root before deletion
                        fs.writeFileSync(logPath, logContent);

                        const config = vscode.workspace.getConfiguration('copilotArchiver');
                        const s3FolderPrefix = config.get<string>('s3.folderPrefix', 'copilot-snapshots');
                        const s3Key = `${s3FolderPrefix}/${safeWorkspaceName}/diagnostics/reset_${timestamp}.txt`;

                        await this.s3Uploader.uploadFile(logPath, s3Key);
                        Logger.info('ShadowGit: Reset log uploaded to S3.');
                    } catch (e) {
                        Logger.error(`ShadowGit: Failed to upload reset log: ${e}`);
                    }

                    fs.rmSync(this.shadowRoot, { recursive: true, force: true });
                }
            }

            // RECURSION GUARD:
            // Check if workspaceRoot seems to be inside another shadow root or is the shadow root itself
            if (this.workspaceRoot.includes('.archiver_shadow')) {
                Logger.warn(`ShadowGit: Potential recursion detected. Workspace root contains '.archiver_shadow'. Aborting initialization.`);
                return;
            }

            // 1. Create/Init Shadow Repo
            if (!fs.existsSync(this.shadowRoot)) {
                fs.mkdirSync(this.shadowRoot, { recursive: true });
                await this.runGitCommand(['init'], this.shadowRoot);
                // Configure user for this repo to avoid "Please tell me who you are" errors
                await this.runGitCommand(['config', 'user.email', 'archiver@copilot.local'], this.shadowRoot);
                await this.runGitCommand(['config', 'user.name', 'Copilot Archiver'], this.shadowRoot);

                // DATA SAFETY: Create a .gitignore inside the shadow repo as a second line of defense
                // This prevents git from adding blacklisted files even if they are accidentally copied here
                this.updateShadowGitignore();

                Logger.info('Initialized Shadow Git repository.');

                await this.populateShadowRepo();
            } else {
                // Ensure .gitignore exists and is up to date even for existing repos
                // This ensures the fix applies to users retrieving the update
                this.updateShadowGitignore();
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



    async handleFileSave(document: vscode.TextDocument) {
        if (!this.workspaceRoot || !this.shadowRoot) return;
        if (!document.uri.fsPath.startsWith(this.workspaceRoot)) return;
        if (document.fileName.includes('.git') || document.fileName.includes('.archiver_shadow')) return;

        const relativePath = path.relative(this.workspaceRoot, document.uri.fsPath);

        if (!shouldTrackFile(document.uri.fsPath, relativePath)) {
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
            // Skip files inside .archiver_shadow or .git
            if (uri.fsPath.includes('.archiver_shadow') || uri.fsPath.includes('.git')) continue;

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
            // Skip files inside .archiver_shadow or .git
            if (uri.fsPath.includes('.archiver_shadow') || uri.fsPath.includes('.git')) continue;

            const relativePath = path.relative(this.workspaceRoot, uri.fsPath);
            const shadowFilePath = path.join(this.shadowRoot, relativePath);

            try {
                const stats = fs.statSync(uri.fsPath);
                if (stats.isDirectory()) {
                    // Handle directory creation (recursive)
                    createdCount += await this.processDirectoryCreate(uri.fsPath);
                } else {
                    // Handle single file creation
                    if (shouldTrackFile(uri.fsPath, relativePath)) {
                        const shadowFileDir = path.dirname(shadowFilePath);
                        if (!fs.existsSync(shadowFileDir)) {
                            fs.mkdirSync(shadowFileDir, { recursive: true });
                        }
                        fs.copyFileSync(uri.fsPath, shadowFilePath);
                        createdCount++;
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
        // Skip .archiver_shadow or .git directories
        if (dirPath.includes('.archiver_shadow') || dirPath.includes('.git')) return 0;
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
                if (shouldTrackFile(uri.fsPath, relativePath)) {
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
            // Skip files inside .archiver_shadow or .git
            if (oldUri.fsPath.includes('.archiver_shadow') || oldUri.fsPath.includes('.git')) continue;
            if (newUri.fsPath.includes('.archiver_shadow') || newUri.fsPath.includes('.git')) continue;

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
                        if (shouldTrackFile(newUri.fsPath, newRelativePath)) {
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
    // Track when the first un-committed edit started per file
    private dirtyFirstEdit: Map<string, number> = new Map();
    private readonly DIRTY_DEBOUNCE_MS = 5000;
    private readonly DIRTY_MAX_INTERVAL_MS = 30000; // Force commit after 30s of continuous editing

    async handleFileChange(document: vscode.TextDocument) {
        if (!this.workspaceRoot || !this.shadowRoot) return;
        if (!document.uri.fsPath.startsWith(this.workspaceRoot)) return;
        // Skip files inside .archiver_shadow or .git
        if (document.uri.fsPath.includes('.archiver_shadow') || document.uri.fsPath.includes('.git')) return;
        // Skip large files, blacklisted, etc.
        const relativePath = path.relative(this.workspaceRoot, document.uri.fsPath);
        if (!shouldTrackFile(document.uri.fsPath, relativePath)) return;

        const fsPath = document.uri.fsPath;
        const now = Date.now();

        // Track when the first edit started (if not already tracked)
        if (!this.dirtyFirstEdit.has(fsPath)) {
            this.dirtyFirstEdit.set(fsPath, now);
        }

        // Clear existing timer for this file
        if (this.dirtyTimers.has(fsPath)) {
            clearTimeout(this.dirtyTimers.get(fsPath)!);
            this.dirtyTimers.delete(fsPath);
        }

        // If continuous editing exceeds max interval, commit immediately
        const firstEdit = this.dirtyFirstEdit.get(fsPath)!;
        const elapsed = now - firstEdit;
        const delay = elapsed >= this.DIRTY_MAX_INTERVAL_MS ? 0 : this.DIRTY_DEBOUNCE_MS;

        // Set new timer
        const timer = setTimeout(async () => {
            this.dirtyTimers.delete(fsPath); // Remove self
            this.dirtyFirstEdit.delete(fsPath); // Reset first-edit tracker

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

        }, delay);

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

        // Create bundle in system temp directory to avoid it being tracked by git
        const config = vscode.workspace.getConfiguration('copilotArchiver');
        const s3FolderPrefix = config.get<string>('s3.folderPrefix', 'copilot-snapshots');
        const workspaceName = this.workspaceRoot ? path.basename(this.workspaceRoot) : 'unknown_workspace';
        const safeWorkspaceName = workspaceName.replace(/[^a-zA-Z0-9_\-]/g, '_');
        const bundlePath = path.join(os.tmpdir(), `shadow_git_${safeWorkspaceName}.bundle`);

        try {
            // 1. Check for Changes (HEAD vs Last Uploaded HEAD)
            const currentHead = await this.runGitCommand(['rev-parse', 'HEAD'], this.shadowRoot);

            if (!force && currentHead === this.lastUploadedHead) {
                Logger.info('ShadowGit: Skipping sync (No changes since last upload).');
                this.isSyncing = false;
                return;
            }

            // 2. Create Bundle in temp directory (using absolute path)
            Logger.info(`ShadowGit: Creating bundle at ${bundlePath}...`);
            await this.runGitCommand(['bundle', 'create', bundlePath, '--all'], this.shadowRoot);

            // 3. Upload to S3
            Logger.info(`ShadowGit: Bundle created. Uploading to S3...`);

            const staticS3Key = `${s3FolderPrefix}/${safeWorkspaceName}/shadow_git/shadow_git.bundle`;

            await this.s3Uploader.uploadFile(
                bundlePath,
                staticS3Key
            );
            Logger.info('ShadowGit: Static bundle uploaded.');

            // 4. Daily Backup Check
            const lastDailyKey = `shadowGit.lastDailyUpload.${safeWorkspaceName}`;
            const lastDailyUpload = this.globalState.get<number>(lastDailyKey) || 0;
            const now = Date.now();
            const ONE_DAY_MS = 24 * 60 * 60 * 1000;

            if (now - lastDailyUpload > ONE_DAY_MS) {
                Logger.info('ShadowGit: Performing Daily Backup...');
                const timestamp = new Date().toISOString().replace(/[:.]/g, '_');
                const dailyBundleName = `history_${timestamp}.bundle`;
                const dailyS3Key = `${s3FolderPrefix}/${safeWorkspaceName}/shadow_git/${dailyBundleName}`;

                // Upload the SAME bundle file to the history location
                await this.s3Uploader.uploadFile(bundlePath, dailyS3Key);

                // Update timestamp
                await this.globalState.update(lastDailyKey, now);
                Logger.info(`ShadowGit: Daily backup uploaded as ${dailyBundleName}`);
            }

            // Update State
            this.lastUploadedHead = currentHead;
            this.lastUploadTime = Date.now();
            Logger.info('ShadowGit: Sync complete.');

        } catch (err) {
            Logger.error(`ShadowGit Sync Failed: ${err}`);
        } finally {
            // Always cleanup bundle from temp directory
            try {
                if (fs.existsSync(bundlePath)) {
                    fs.unlinkSync(bundlePath);
                    Logger.debug('ShadowGit: Cleaned up temp bundle.');
                }
            } catch (e) {
                Logger.warn(`ShadowGit: Failed to cleanup temp bundle: ${e}`);
            }
            this.isSyncing = false;
            // Handle pending triggers (occurred during upload)
            if (this.pendingSync) {
                this.pendingSync = false;
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
                if (!shouldTrackFile(file.fsPath, relativePath)) {
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

    private updateShadowGitignore() {
        if (!this.shadowRoot || !this.workspaceRoot) return;

        try {
            const gitignorePath = path.join(this.shadowRoot, '.gitignore');

            // Format patterns for .gitignore
            const formattedPatterns = SNAPSHOT_BLACKLIST_PATTERNS.map(p => {
                if (p.startsWith('.')) {
                    // Extension pattern: .json -> **/*.json
                    return `**/*${p}`;
                } else {
                    // Directory pattern: node_modules -> **/node_modules/**
                    return `**/${p}/**`;
                }
            });

            let gitignoreContent = '# Auto-generated blacklist patterns\n';
            gitignoreContent += formattedPatterns.join('\n') + '\n';

            // Append user's workspace .gitignore content if it exists
            const userGitignorePath = path.join(this.workspaceRoot, '.gitignore');
            if (fs.existsSync(userGitignorePath)) {
                try {
                    const userContent = fs.readFileSync(userGitignorePath, 'utf8');
                    gitignoreContent += '\n# User .gitignore content\n' + userContent + '\n';
                } catch (e) {
                    Logger.warn(`ShadowGit: Failed to read user .gitignore: ${e}`);
                }
            }

            fs.writeFileSync(gitignorePath, gitignoreContent);
            Logger.info('ShadowGit: Updated shadow .gitignore with safety patterns and user ignores.');
        } catch (err) {
            Logger.error(`ShadowGit: Failed to update .gitignore: ${err}`);
        }
    }

    private async getFolderSize(folderPath: string): Promise<number> {
        let totalSize = 0;
        try {
            const files = await fs.promises.readdir(folderPath, { withFileTypes: true });
            for (const file of files) {
                const filePath = path.join(folderPath, file.name);
                if (file.isDirectory()) {
                    totalSize += await this.getFolderSize(filePath);
                } else {
                    const stats = await fs.promises.stat(filePath);
                    totalSize += stats.size;
                }
            }
        } catch (e) {
            // Ignore errors for individual files/folders during size check
        }
        return totalSize;
    }
}
