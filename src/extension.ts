import * as vscode from 'vscode';
import { SnapshotManager } from './snapshotManager';
import { ChatSessionWatcher } from './chatSessionWatcher';
import { Logger } from './logger';
import { PasteWatcher } from './pasteWatcher';
import { LogWatcher } from './logWatcher';

export function activate(context: vscode.ExtensionContext) {
    Logger.initialize(context, 'Copilot Archiver');
    Logger.info('Copilot Interaction Archiver is now active');

    const snapshotManager = new SnapshotManager();
    const chatSessionWatcher = new ChatSessionWatcher(context, snapshotManager);
    const pasteWatcher = new PasteWatcher(context, snapshotManager);
    const logWatcher = new LogWatcher(context, snapshotManager);

    context.subscriptions.push(chatSessionWatcher);
    context.subscriptions.push(pasteWatcher);
    context.subscriptions.push(logWatcher);

    Logger.info('ChatSessionWatcher initialized and listening for changes.');
}

export function deactivate() { }
