import * as vscode from 'vscode';
import { SnapshotManager } from './snapshotManager';
import { ChatSessionWatcher } from './chatSessionWatcher';
import { Logger } from './logger';
import { PasteWatcher } from './pasteWatcher';
import { LogWatcher } from './logWatcher';
import { ShadowGitManager } from './shadowGitManager';

// Helper for Hashing (or not)
function computeBackendId(rawId: string): string {
    if (rawId.startsWith('test_') || rawId.endsWith('_test')) {
        return rawId;
    }
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(rawId).digest('hex');
}

// Helper for Debug Mode Instruction
async function promptForDebugMode() {
    const choice = await vscode.window.showInformationMessage(
        'To archive conversations, GitHub Copilot Chat must be in "Debug" mode. \n\nIn the next menu, please \n1. Select "GitHub Copilot Chat" \n2. Click the double checkmark (Set Default) in the debug cell. \n\nNote: you should select "debug" in the "GitHub Copilot Chat" dropdown, not the first shown dropdown.',
        { modal: true },
        'Open Menu'
    );

    if (choice === 'Open Menu') {
        vscode.window.showInformationMessage('Step: Select "GitHub Copilot Chat" -> Click Double Checkmark (Set Default) in the debug cell.');
        await vscode.commands.executeCommand('workbench.action.setLogLevel', 'GitHub Copilot Chat');
    }
}

export async function activate(context: vscode.ExtensionContext) {
    Logger.initialize(context, 'Copilot Archiver');
    Logger.info('Copilot Interaction Archiver is now active');

    // Per-Workspace Permission Check
    const isAuthorized = context.workspaceState.get<boolean>('archiver.isAuthorized');

    // Status Bar Item
    let statusBarItem: vscode.StatusBarItem | undefined;

    // Register Activation Commands Early (so they work even if disabled)
    context.subscriptions.push(vscode.commands.registerCommand('copilotArchiver.enableWorkspace', async () => {
        await context.workspaceState.update('archiver.isAuthorized', true);
        const selection = await vscode.window.showInformationMessage(
            'Copilot Archiver enabled for this workspace. Please Reload the Window to activate.',
            'Reload Window'
        );
        if (selection === 'Reload Window') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('copilotArchiver.disableWorkspace', async () => {
        await context.workspaceState.update('archiver.isAuthorized', false);
        const selection = await vscode.window.showInformationMessage(
            'Copilot Archiver disabled for this workspace. Please Reload the Window to prevent further capturing.',
            'Reload Window'
        );
        if (selection === 'Reload Window') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    }));

    // Status Bar Menu
    context.subscriptions.push(vscode.commands.registerCommand('copilotArchiver.showMenu', async () => {
        const cfg = vscode.workspace.getConfiguration('copilotArchiver');
        const localMode = cfg.get<boolean>('localMode', false);
        const token = await context.secrets.get('archiver.jwt');
        const user = context.globalState.get<string>('archiver.user_display');

        const items: vscode.QuickPickItem[] = [];

        if (localMode) {
            items.push({
                label: '$(file-directory) Mode: Local Only',
                description: 'Captures stay on this machine (no upload)',
                detail: 'Data is saved in .snapshots/ and .archiver_shadow/',
                alwaysShow: true
            });
            items.push({
                label: '$(cloud-upload) Capture Repo Snapshot',
                description: 'Save a snapshot to .snapshots/',
                alwaysShow: true
            });
            items.push({
                label: '$(sign-in) Switch to Upload Mode',
                description: 'Enable backend upload (requires login)',
                alwaysShow: true
            });
        } else if (token && user) {
            // Compute ID for display
            const finalId = computeBackendId(user);
            const isHashed = finalId !== user;
            const label = isHashed ? `$(key) Hashed ID: ${finalId.substring(0, 16)}...` : `$(key) ID: ${finalId}`;
            const desc = isHashed ? 'Anonymized Identifier' : 'Raw Identifier (test account)';

            items.push({
                label: `$(account) User: ${user}`,
                description: 'Active Account',
                detail: 'Click to copy Andrew ID',
                alwaysShow: true
            });
            items.push({
                label: label,
                description: desc,
                detail: 'Click to copy full ID',
                alwaysShow: true
            });
            items.push({
                label: '$(cloud-upload) Capture Repo Snapshot',
                description: 'Force a snapshot of the current workspace',
                alwaysShow: true
            });
            items.push({
                label: '$(sign-out) Log Out',
                description: 'Clear credentials',
                alwaysShow: true
            });
            items.push({
                label: '$(file-directory) Switch to Local Only Mode',
                description: 'Stop uploading; keep capturing locally',
                alwaysShow: true
            });
        } else {
            items.push({
                label: '$(sign-in) Log In (Upload Mode)',
                description: 'Connect to Archiver Backend',
                alwaysShow: true
            });
            items.push({
                label: '$(file-directory) Use Local Only',
                description: 'Skip login; capture locally without upload',
                alwaysShow: true
            });
        }

        // // Check Debug Logging
        // const config = vscode.workspace.getConfiguration('github.copilot.advanced');
        // const levels = config.get<any>('debug.overrideLogLevels') || {};
        // if (levels['GitHub.copilot-chat'] !== 'debug') {
        //     items.unshift({
        //         label: '$(warning) Warning: Copilot Debug Logging Off',
        //         description: 'Required for full data capture',
        //         detail: 'Click to Enable Debug Logging',
        //         alwaysShow: true,
        //         picked: true
        //     });
        // } else {
        //     items.push({
        //         label: '$(check) Copilot Debug Logging: On',
        //         description: 'Capture agentIntent enabled',
        //         alwaysShow: true
        //     });
        // }

        const selection = await vscode.window.showQuickPick(items, {
            placeHolder: 'Copilot Archiver Menu'
        });

        if (!selection) return;

        if (selection.label.includes('User:')) {
            vscode.env.clipboard.writeText(user || '');
            vscode.window.showInformationMessage('Andrew ID copied to clipboard.');
        } else if (selection.label.includes('Hashed ID:') ||
                   (selection.label.includes('ID:') && !selection.label.includes('Mode:'))) {
            const finalId = computeBackendId(user || '');
            vscode.env.clipboard.writeText(finalId);
            vscode.window.showInformationMessage('User ID copied to clipboard.');
        } else if (selection.label.includes('Capture Repo Snapshot')) {
            vscode.commands.executeCommand('copilotArchiver.captureNow');
        } else if (selection.label.includes('Log Out')) {
            vscode.commands.executeCommand('copilotArchiver.logout');
        } else if (selection.label.includes('Log In') || selection.label.includes('Switch to Upload Mode')) {
            // Login resets localMode on success.
            vscode.commands.executeCommand('copilotArchiver.login');
        } else if (selection.label.includes('Use Local Only') || selection.label.includes('Switch to Local Only')) {
            await cfg.update('localMode', true, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('Copilot Archiver: Local Only mode enabled. Captures will stay on this machine.');
            updateStatusBar();
        }
    }));

    const updateStatusBar = async () => {
        if (!statusBarItem) return;
        const cfg = vscode.workspace.getConfiguration('copilotArchiver');
        const localMode = cfg.get<boolean>('localMode', false);
        const token = await context.secrets.get('archiver.jwt');
        const user = context.globalState.get<string>('archiver.user_display');

        if (localMode) {
            statusBarItem.text = '$(file-directory) Archiver: Local Only';
            statusBarItem.backgroundColor = undefined;
            statusBarItem.tooltip = 'Local Only mode — captures stay on this machine. Click to open Menu.';
            statusBarItem.command = 'copilotArchiver.showMenu';
        } else if (token) {
            statusBarItem.text = `$(check) Archiver: ${user}`;
            statusBarItem.backgroundColor = undefined;
            statusBarItem.tooltip = 'Copilot Archiver Active. Click to open Menu.';
            statusBarItem.command = 'copilotArchiver.showMenu';
        } else {
            statusBarItem.text = '$(alert) Archiver: Setup Required';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            statusBarItem.tooltip = 'Click to choose Upload Mode or Local Only.';
            statusBarItem.command = 'copilotArchiver.showMenu';
        }
        statusBarItem.show();
    };

    if (isAuthorized === undefined) {
        // First time in this workspace: Ask permission
        const selection = await vscode.window.showInformationMessage(
            'Enable Copilot Interaction Archiver for this workspace?',
            { modal: true },
            'Yes', 'No'
        );

        if (selection === 'Yes') {
            await context.workspaceState.update('archiver.isAuthorized', true);
            Logger.info('User enabled Archiver for this workspace.');
            // Initialize Status Bar
            statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
            context.subscriptions.push(statusBarItem);
            updateStatusBar();
        } else if (selection === 'No') {
            await context.workspaceState.update('archiver.isAuthorized', false);
            Logger.info('User disabled Archiver for this workspace.');
            return; // Exit
        } else {
            // Dismissed (undefined)
            Logger.info('User dismissed permission prompt. Archiver will not activate this session, but prompt will reappear next time.');
            return; // Exit without saving state
        }
    } else if (isAuthorized === false) {
        Logger.info('Archiver is disabled for this workspace (per user preference).');
        return; // Exit
    } else {
        // Authorized: Init Status Bar
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        context.subscriptions.push(statusBarItem);
        updateStatusBar();
    }

    // Enforce Workspace Requirement
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        Logger.warn('No workspace folder open. Copilot Archiver will not activate.');
        vscode.window.showErrorMessage('Copilot Archiver: Please open a Folder/Workspace to enable automatic archiving.');
        return;
    }

    // Strict Dependency Check: GitHub Copilot Chat
    const copilotExtension = vscode.extensions.getExtension('GitHub.copilot-chat');
    if (!copilotExtension) {
        Logger.error('GitHub Copilot Chat extension is not installed.');
        vscode.window.showErrorMessage(
            'Copilot Interaction Archiver requires "GitHub Copilot Chat" to be installed. The extension will not activate.'
        );
        return; // Halt activation
    }

    if (!copilotExtension.isActive) {
        Logger.info('Activating GitHub Copilot Chat dependency...');
        try {
            await copilotExtension.activate();
            Logger.info('GitHub Copilot Chat activated.');
        } catch (err) {
            Logger.error(`Failed to activate GitHub Copilot Chat: ${err}`);
            vscode.window.showErrorMessage('Failed to activate GitHub Copilot Chat. Copilot Archiver cannot start.');
            return;
        }
    }

    // Register Enable Debug Command
    context.subscriptions.push(vscode.commands.registerCommand('copilotArchiver.enableCopilotDebug', async () => {
        promptForDebugMode();
    }));

    const snapshotManager = new SnapshotManager(context.secrets);
    const chatSessionWatcher = new ChatSessionWatcher(context, snapshotManager);
    const pasteWatcher = new PasteWatcher(context, snapshotManager);
    const logWatcher = new LogWatcher(context, snapshotManager);

    context.subscriptions.push(chatSessionWatcher);
    context.subscriptions.push(pasteWatcher);
    context.subscriptions.push(logWatcher);

    // Initialize Shadow Git Manager
    const shadowGitManager = new ShadowGitManager(context);

    // Listen for Save Events
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
        await shadowGitManager.handleFileSave(doc);
    }));

    // Listen for Delete Events
    context.subscriptions.push(vscode.workspace.onDidDeleteFiles(async (event) => {
        await shadowGitManager.handleFileDelete(event);
    }));

    // Listen for Create Events
    context.subscriptions.push(vscode.workspace.onDidCreateFiles(async (event) => {
        await shadowGitManager.handleFileCreate(event);
    }));

    // Listen for Rename Events
    context.subscriptions.push(vscode.workspace.onDidRenameFiles(async (event) => {
        await shadowGitManager.handleFileRename(event);
    }));

    // Listen for Text Changes (Dirty Capture)
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async (event) => {
        await shadowGitManager.handleFileChange(event.document);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('copilotArchiver.captureNow', async () => {
        const timestamp = new Date().toISOString();
        Logger.info(`Manual snapshot trigger at ${timestamp}`);
        // Manual capture: Include Repo Files = true
        await snapshotManager.captureRepoSnapshot(timestamp, undefined, true);

        // Also trigger Shadow Git Sync (Force=true)
        await shadowGitManager.syncToS3(true);

        vscode.window.showInformationMessage('Copilot Archiver: Manual Snapshot Captured & Shadow Git Synced.');
    }));

    // Register Login Command
    context.subscriptions.push(vscode.commands.registerCommand('copilotArchiver.login', async () => {
        try {
            const config = vscode.workspace.getConfiguration('copilotArchiver');
            const backendUrl = config.get<string>('backendUrl');

            if (!backendUrl) {
                vscode.window.showErrorMessage('Copilot Archiver: Backend URL is not configured in settings.');
                return;
            }

            let andrewId = '';
            let confirmed = false;

            // 1. Enter and Confirm Andrew ID
            while (!confirmed) {
                const input = await vscode.window.showInputBox({
                    prompt: 'Enter your Andrew ID',
                    placeHolder: 'andrewId',
                    value: andrewId, // Pre-fill if editing
                    ignoreFocusOut: true
                });
                if (!input) return; // User cancelled

                andrewId = input;

                const selection = await vscode.window.showQuickPick(
                    [`Confirm: ${andrewId}`, 'Edit / Re-enter'],
                    { placeHolder: `Is "${andrewId}" correct?`, ignoreFocusOut: true }
                );

                if (!selection) return; // User cancelled
                if (selection.startsWith('Confirm')) {
                    confirmed = true;
                }
            }

            // 2. Enter Password
            const password = await vscode.window.showInputBox({
                prompt: 'Enter the Class Password',
                password: true,
                ignoreFocusOut: true
            });
            if (!password) return;

            // 3. Prepare User ID (Hash unless test account)
            const userId = computeBackendId(andrewId);
            const isHashed = userId !== andrewId;

            if (isHashed) {
                Logger.info(`Logging in with hashed ID: ${userId.substring(0, 8)}...`);
            } else {
                Logger.info(`Logging in with raw test ID: ${userId}`);
            }

            // 4. Call Login Endpoint
            const response = await fetch(`${backendUrl}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: userId, password })
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Login failed (${response.status}): ${errText}`);
            }

            const data = await response.json() as { token: string };
            if (data.token) {
                await context.secrets.store('archiver.jwt', data.token);
                // Store raw ID in globalState for display only
                await context.globalState.update('archiver.user_display', andrewId);

                // Logging in implies upload mode; clear any prior localMode override.
                await vscode.workspace.getConfiguration('copilotArchiver')
                    .update('localMode', false, vscode.ConfigurationTarget.Global);

                vscode.window.showInformationMessage(`Copilot Archiver: Login successful as ${andrewId}`);
                updateStatusBar();

                // Show this EVERY time after login
                promptForDebugMode();
            } else {
                throw new Error('No token returned from server');
            }

        } catch (err: any) {
            Logger.error(`Login error: ${err}`);
            vscode.window.showErrorMessage(`Copilot Archiver Login Failed: ${err.message}`);
        }
    }));

    // Register Logout Command
    context.subscriptions.push(vscode.commands.registerCommand('copilotArchiver.logout', async () => {
        try {
            await context.secrets.delete('archiver.jwt');
            await context.globalState.update('archiver.user_display', undefined);
            Logger.info('User logged out.');
            vscode.window.showInformationMessage('Copilot Archiver: Logged out successfully.');
            updateStatusBar();
        } catch (err) {
            Logger.error(`Logout failed: ${err}`);
        }
    }));

    // // Register Storage Toggle Commands
    // context.subscriptions.push(vscode.commands.registerCommand('copilotArchiver.enableLocalStorage', async () => {
    //     await vscode.workspace.getConfiguration('copilotArchiver').update('storeLocally', true, vscode.ConfigurationTarget.Global);
    //     vscode.window.showInformationMessage('Copilot Archiver: Local Storage Enabled (Snapshots saved to .snapshots and uploaded to S3)');
    // }));

    // context.subscriptions.push(vscode.commands.registerCommand('copilotArchiver.disableLocalStorage', async () => {
    //     await vscode.workspace.getConfiguration('copilotArchiver').update('storeLocally', false, vscode.ConfigurationTarget.Global);
    //     vscode.window.showInformationMessage('Copilot Archiver: Local Storage Disabled (Snapshots are uploaded to S3 directly)');
    // }));

    Logger.info('ChatSessionWatcher initialized and listening for changes.');

    // First-run mode selection. Skipped if the user is already in local mode
    // or already logged in (token present); otherwise a one-time modal lets
    // them pick Upload (login) or Local Only. Dismissal leaves the status
    // bar in "Setup Required" — they can choose later from the menu.
    setTimeout(async () => {
        const cfg = vscode.workspace.getConfiguration('copilotArchiver');
        if (cfg.get<boolean>('localMode', false)) {
            Logger.info('Copilot Archiver running in Local Only mode.');
            return;
        }
        const token = await context.secrets.get('archiver.jwt');
        if (token) return;

        const choice = await vscode.window.showInformationMessage(
            'Copilot Archiver: choose how to use this extension.',
            {
                modal: true,
                detail:
                    'Upload Mode: connects to a backend and uploads captures. Requires login credentials provided by your instructor or research team (e.g., a CMU Andrew ID + class password).\n\n' +
                    'Local Only: no login, no uploads. All captures stay on this machine inside .snapshots/ and .archiver_shadow/.'
            },
            'Upload Mode (Login)', 'Local Only'
        );

        if (choice === 'Upload Mode (Login)') {
            vscode.commands.executeCommand('copilotArchiver.login');
        } else if (choice === 'Local Only') {
            await cfg.update('localMode', true, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                'Copilot Archiver: Local Only mode enabled. Captures will stay on this machine.'
            );
            updateStatusBar();
        } else {
            Logger.info('User dismissed mode selection.');
        }
    }, 1000); // delay to let VS Code finish activating

    // Listen for Configuration Changes to update Status Bar
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('github.copilot.chat.logLevel') ||
            e.affectsConfiguration('copilotArchiver.localMode')) {
            updateStatusBar();
        }
    }));
}

export function deactivate() { }
