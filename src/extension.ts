import * as vscode from 'vscode';
import { SnapshotManager } from './snapshotManager';
import { ChatSessionWatcher } from './chatSessionWatcher';

let outputChannel: vscode.OutputChannel;

export function log(message: string) {
    const timestamp = new Date().toISOString();
    outputChannel.appendLine(`[${timestamp}] ${message}`);
}

export function logError(message: string) {
    const timestamp = new Date().toISOString();
    outputChannel.appendLine(`[${timestamp}] ERROR: ${message}`);
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Copilot Archiver');
    log('Copilot Interaction Archiver is now active');

    // Generate or retrieve a unique chat ID for this session
    // vscode.env.sessionId is unique per window and persists across reloads
    const chatId = vscode.env.sessionId;
    log(`VS Code session ID: ${chatId}`);

    const snapshotManager = new SnapshotManager(chatId);
    const chatSessionWatcher = new ChatSessionWatcher(context, snapshotManager);

    context.subscriptions.push(chatSessionWatcher);

    log('ChatSessionWatcher initialized and listening for changes.');
}

export function deactivate() { }
