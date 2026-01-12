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

    constructor(context: vscode.ExtensionContext) {
        this.s3Uploader = new S3Uploader(context.secrets);
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
            Logger.error(`Shadow Git initialization failed: ${err}`);
        }
    }

    async handleFileSave(document: vscode.TextDocument) {
        if (!this.workspaceRoot || !this.shadowRoot) return;

        // Only process files in the workspace
        if (!document.uri.fsPath.startsWith(this.workspaceRoot)) return;

        // Skip git-related files, etc.
        if (document.fileName.includes('.git') || document.fileName.includes('.archiver_shadow')) return;

        const relativePath = path.relative(this.workspaceRoot, document.uri.fsPath);

        // 1. Blacklist & Extension Check
        const segments = relativePath.split(/[/\\]/);
        const ext = path.extname(document.fileName).toLowerCase();
        if (segments.some(s => s.startsWith('.') || SNAPSHOT_BLACKLIST_PATTERNS.includes(s)) || SNAPSHOT_BLACKLIST_PATTERNS.includes(ext)) {
            return;
        }

        // 2. Size Check
        try {
            const stats = fs.statSync(document.uri.fsPath);
            if (stats.size > MAX_FILE_SIZE_BYTES) {
                Logger.warn(`ShadowGit: Skipping large file ${relativePath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
                return;
            }
        } catch (e) {
            return;
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

        } catch (err) {
            // It's possible `git commit` fails if there are no changes (clean tree). That's fine.
            const errMsg = String(err);
            if (!errMsg.includes('nothing to commit')) {
                Logger.error(`ShadowGit Commit Error: ${err}`);
            }
        }
    }

    async syncToS3() {
        if (!this.shadowRoot) return;

        Logger.info('ShadowGit: Starting Sync...');
        try {
            // 1. Create Bundle
            const timestamp = new Date().toISOString().replace(/:/g, '_');
            const bundleName = `history_${timestamp}.bundle`;
            const bundlePath = path.join(this.shadowRoot, bundleName);

            // Bundle all branches/tags (usually just master/main)
            await this.runGitCommand(['bundle', 'create', bundleName, '--all'], this.shadowRoot);

            if (!fs.existsSync(bundlePath)) {
                Logger.warn('ShadowGit: No bundle created (maybe empty repo?)');
                return;
            }

            const stats = fs.statSync(bundlePath);
            Logger.info(`ShadowGit: Bundle created (${(stats.size / 1024).toFixed(2)} KB). Uploading...`);

            // 2. Upload Bundle
            const config = vscode.workspace.getConfiguration('copilotArchiver');
            const s3FolderPrefix = config.get<string>('s3.folderPrefix', 'copilot-snapshots');

            // Construct S3 Key: <prefix>/<workspaceName>/shadow_git/<bundleName>
            // Backend handles <userId> prefix.
            // Workspace name extracted from workspaceRoot
            const workspaceName = this.workspaceRoot ? path.basename(this.workspaceRoot) : 'unknown_workspace';
            const safeWorkspaceName = workspaceName.replace(/[^a-zA-Z0-9_\-]/g, '_'); // Sanitize for S3

            // Upload using S3Uploader
            await this.s3Uploader.uploadFile(bundlePath, `${s3FolderPrefix}/${safeWorkspaceName}/shadow_git/${bundleName}`);

            // 3. Cleanup
            fs.unlinkSync(bundlePath);
            Logger.info('ShadowGit: Sync complete.');

        } catch (err) {
            Logger.error(`ShadowGit Sync Failed: ${err}`);
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
