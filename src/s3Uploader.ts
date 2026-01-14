import * as vscode from 'vscode';
import * as fs from 'fs';
import { Logger } from './logger';

export class S3Uploader {
    constructor(private secretStorage: vscode.SecretStorage) { }

    async uploadFile(filePath: string, s3Key: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('copilotArchiver');
        const backendUrl = config.get<string>('backendUrl');

        if (!backendUrl) return;

        try {
            // Get JWT Token
            const token = await this.secretStorage.get('archiver.jwt');
            if (!token) {
                Logger.warn("Upload skipped: No Login Token found.");
                const selection = await vscode.window.showErrorMessage(
                    "Copilot Archiver: You are not logged in. Snapshots are not being uploaded.",
                    "Login"
                );
                if (selection === "Login") {
                    vscode.commands.executeCommand('copilotArchiver.login');
                }
                return;
            }

            // 1. Get Presigned URL
            const response = await fetch(`${backendUrl}/sign-upload`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ key: s3Key })
            });

            if (!response.ok) {
                if (response.status === 401 || response.status === 403) {
                    await this.secretStorage.delete('archiver.jwt');
                    const selection = await vscode.window.showErrorMessage(
                        "Copilot Archiver: Login session expired. Please login again.",
                        "Login"
                    );
                    if (selection === "Login") {
                        vscode.commands.executeCommand('copilotArchiver.login');
                    }
                    return;
                }
                throw new Error(`Backend returned ${response.status}: ${response.statusText}`);
            }

            const data = await response.json() as { uploadUrl: string };
            const uploadUrl = data.uploadUrl;

            // 2. Upload to S3
            const fileContent = fs.readFileSync(filePath);
            const uploadResponse = await fetch(uploadUrl, {
                method: 'PUT',
                body: fileContent
            });

            if (!uploadResponse.ok) {
                throw new Error(`S3 Upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
            }

        } catch (err) {
            Logger.error(`Error uploading to S3 via Backend: ${err}`);
            throw err;
        }
    }
}
