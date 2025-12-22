import * as vscode from 'vscode';
import { SnapshotManager } from './snapshotManager';
import { ChatSessionWatcher } from './chatSessionWatcher';
import { Logger } from './logger';
import { PasteWatcher } from './pasteWatcher';
import { LogWatcher } from './logWatcher';

export function activate(context: vscode.ExtensionContext) {
    Logger.initialize(context, 'Copilot Archiver');
    Logger.info('Copilot Interaction Archiver is now active');

    const snapshotManager = new SnapshotManager(context.secrets);
    const chatSessionWatcher = new ChatSessionWatcher(context, snapshotManager);
    const pasteWatcher = new PasteWatcher(context, snapshotManager);
    const logWatcher = new LogWatcher(context, snapshotManager);

    context.subscriptions.push(chatSessionWatcher);
    context.subscriptions.push(pasteWatcher);
    context.subscriptions.push(logWatcher);

    // Register Login Command
    context.subscriptions.push(vscode.commands.registerCommand('copilotArchiver.login', async () => {
        try {
            const config = vscode.workspace.getConfiguration('copilotArchiver');
            const backendUrl = config.get<string>('backendUrl');

            if (!backendUrl) {
                vscode.window.showErrorMessage('Copilot Archiver: Backend URL is not configured in settings.');
                return;
            }

            const andrewId = await vscode.window.showInputBox({
                prompt: 'Enter your Andrew ID',
                placeHolder: 'andrewId',
                ignoreFocusOut: true
            });
            if (!andrewId) return;

            const password = await vscode.window.showInputBox({
                prompt: 'Enter the Class Password',
                password: true,
                ignoreFocusOut: true
            });
            if (!password) return;

            // Call Login Endpoint
            const response = await fetch(`${backendUrl}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ andrewId, password })
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Login failed (${response.status}): ${errText}`);
            }

            const data = await response.json() as { token: string };
            if (data.token) {
                await context.secrets.store('archiver.jwt', data.token);
                vscode.window.showInformationMessage(`Copilot Archiver: Login successful as ${andrewId}`);
            } else {
                throw new Error('No token returned from server');
            }

        } catch (err: any) {
            Logger.error(`Login error: ${err}`);
            vscode.window.showErrorMessage(`Copilot Archiver Login Failed: ${err.message}`);
        }
    }));

    Logger.info('ChatSessionWatcher initialized and listening for changes.');

    // Proactive Login Check
    setTimeout(async () => {
        const token = await context.secrets.get('archiver.jwt');
        if (!token) {
            Logger.info('No token found on startup. Prompting for login...');
            vscode.commands.executeCommand('copilotArchiver.login');
        }
    }, 1000); // 1s delay to let VS Code settle
}

export function deactivate() { }
