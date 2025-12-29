import * as vscode from 'vscode';
import { SnapshotManager } from './snapshotManager';
import { ChatSessionWatcher } from './chatSessionWatcher';
import { Logger } from './logger';
import { PasteWatcher } from './pasteWatcher';
import { LogWatcher } from './logWatcher';

export async function activate(context: vscode.ExtensionContext) {
    Logger.initialize(context, 'Copilot Archiver');
    Logger.info('Copilot Interaction Archiver is now active');

    // 1. Strict Dependency Check: GitHub Copilot Chat
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
