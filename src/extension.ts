import * as vscode from 'vscode';
import { outputChannel, log } from './logger';
import { LogWatcher } from './logWatcher';
import { SnapshotManager } from './snapshotManager';

let logWatcher: LogWatcher | undefined;
let snapshotManager: SnapshotManager | undefined;

export function activate(context: vscode.ExtensionContext) {
    log('Copilot Interaction Archiver is now active');

    // Initialize snapshot manager
    snapshotManager = new SnapshotManager();

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('copilotArchiver.enable', () => {
            vscode.workspace.getConfiguration('copilotArchiver').update('enabled', true, vscode.ConfigurationTarget.Workspace);
            vscode.window.showInformationMessage('Copilot Archiver enabled');
            outputChannel.show(true);
            startWatching();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('copilotArchiver.disable', () => {
            vscode.workspace.getConfiguration('copilotArchiver').update('enabled', false, vscode.ConfigurationTarget.Workspace);
            vscode.window.showInformationMessage('Copilot Archiver disabled');
            stopWatching();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('copilotArchiver.captureNow', async () => {
            if (!snapshotManager) {
                vscode.window.showErrorMessage('Snapshot manager not initialized');
                return;
            }
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('No workspace folder open');
                return;
            }
            try {
                await snapshotManager.captureSnapshot(workspaceFolder.uri.fsPath);
                vscode.window.showInformationMessage('Snapshot captured successfully');
                outputChannel.show(true);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to capture snapshot: ${error}`);
            }
        })
    );

    // Start watching if enabled
    const config = vscode.workspace.getConfiguration('copilotArchiver');
    if (config.get<boolean>('enabled', true)) {
        startWatching();
    }

    // Watch for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('copilotArchiver.enabled')) {
                const enabled = vscode.workspace.getConfiguration('copilotArchiver').get<boolean>('enabled', true);
                if (enabled) {
                    startWatching();
                } else {
                    stopWatching();
                }
            }
        })
    );
}

function startWatching() {
    if (logWatcher) {
        return; // Already watching
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showWarningMessage('No workspace folder open. Cannot start Copilot Snapshot watching.');
        return;
    }

    if (!snapshotManager) {
        vscode.window.showErrorMessage('Snapshot manager not initialized');
        return;
    }

    try {
        logWatcher = new LogWatcher(workspaceFolder.uri.fsPath, snapshotManager);
        logWatcher.start();
        console.log('Started watching Copilot log file');
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to start watching: ${error}`);
    }
}

function stopWatching() {
    if (logWatcher) {
        logWatcher.stop();
        logWatcher = undefined;
        console.log('Stopped watching Copilot log file');
    }
}

export function deactivate() {
    stopWatching();
}
