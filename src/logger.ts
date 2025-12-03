import * as vscode from 'vscode';

export const outputChannel = vscode.window.createOutputChannel('Copilot Archiver');

export function log(...message: any[]) {
    const ts = new Date().toISOString();
    outputChannel.appendLine(`[${ts}] ${message.join(' ')}`);
    console.log(...message);
}

export function error(...message: any[]) {
    const ts = new Date().toISOString();
    outputChannel.appendLine(`[${ts}] ERROR: ${message.join(' ')}`);
    console.error(...message);
}


