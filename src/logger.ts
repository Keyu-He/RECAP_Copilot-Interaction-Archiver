import * as vscode from 'vscode';

export const outputChannel = vscode.window.createOutputChannel('Copilot Archiver');

export function log(message: string) {
    const ts = new Date().toISOString();
    outputChannel.appendLine(`[${ts}] ${message}`);
    console.log(message);
}

export function error(message: string) {
    const ts = new Date().toISOString();
    outputChannel.appendLine(`[${ts}] ERROR: ${message}`);
    console.error(message);
}


