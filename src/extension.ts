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
        const token = await context.secrets.get('archiver.jwt');
        const user = context.globalState.get<string>('archiver.user_display');

        const items: vscode.QuickPickItem[] = [];

        if (token && user) {
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
        } else {
            items.push({
                label: '$(sign-in) Log In',
                description: 'Connect to Archiver Backend',
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
        } else if (selection.label.includes('Hashed ID:') || selection.label.includes('ID:')) {
            const finalId = computeBackendId(user || '');
            vscode.env.clipboard.writeText(finalId);
            vscode.window.showInformationMessage('User ID copied to clipboard.');
        } else if (selection.label.includes('Capture Repo Snapshot')) {
            // Manually trigger snapshot
            // We need access to snapshotManager here. It is defined later in activate.
            // Move this registration AFTER snapshotManager init? Or use command if available.
            vscode.commands.executeCommand('copilotArchiver.captureNow'); // We need to implement this command or expose it
        } else if (selection.label.includes('Log Out')) {
            vscode.commands.executeCommand('copilotArchiver.logout');
        } else if (selection.label.includes('Log In')) {
            vscode.commands.executeCommand('copilotArchiver.login');
        }
    }));

    const updateStatusBar = async () => {
        if (!statusBarItem) return;
        const token = await context.secrets.get('archiver.jwt');
        const user = context.globalState.get<string>('archiver.user_display');

        if (token) {
            statusBarItem.text = `$(check) Archiver: ${user}`;
            statusBarItem.backgroundColor = undefined;
            statusBarItem.tooltip = 'Copilot Archiver Active. Click to open Menu.';
            statusBarItem.command = 'copilotArchiver.showMenu';
        } else {
            statusBarItem.text = '$(alert) Archiver: Login Required';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            statusBarItem.tooltip = 'Click to Login to Copilot Archiver';
            statusBarItem.command = 'copilotArchiver.login';
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

    // Periodic Sync (Every 1 minute)
    const SYNC_INTERVAL_MS = 1 * 60 * 1000;
    const syncTimer = setInterval(async () => {
        await shadowGitManager.syncToS3();
    }, SYNC_INTERVAL_MS);

    context.subscriptions.push({ dispose: () => clearInterval(syncTimer) });


    context.subscriptions.push(vscode.commands.registerCommand('copilotArchiver.captureNow', async () => {
        const timestamp = new Date().toISOString();
        Logger.info(`Manual snapshot trigger at ${timestamp}`);
        // Manual capture: Include Repo Files = true
        await snapshotManager.captureRepoSnapshot(timestamp, undefined, true);

        // Also trigger Shadow Git Sync
        await shadowGitManager.syncToS3();

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

    // Proactive Login Check
    setTimeout(async () => {
        const token = await context.secrets.get('archiver.jwt');
        if (!token) {
            Logger.info('No token found on startup. Prompting for login...');
            vscode.commands.executeCommand('copilotArchiver.login');
        }
    }, 1000); // 1s delay to let VS Code settle

    // Listen for Configuration Changes to update Status Bar
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('github.copilot.chat.logLevel')) {
            updateStatusBar();
        }
    }));
}

export function deactivate() { }
