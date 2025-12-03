# Copilot Interaction Archiver

Automatically archive your workspace at the end of each Copilot turn.

## Features

- **Automatic Snapshots**: Captures the state of your workspace after every Copilot interaction.
- **Chat History**: Saves the conversation history associated with each snapshot.
- **S3 Integration**: (Optional) Zips and uploads snapshots to Amazon S3.
- **Smart Tracking**: Uses a unique Chat ID (Session ID) to organize snapshots.

## Configuration

### S3 Storage (Optional)

To enable S3 uploads, configure the following settings in your `settings.json`:

```json
"copilotArchiver.s3.enabled": true,
"copilotArchiver.s3.bucket": "your-bucket-name",
"copilotArchiver.s3.region": "us-east-1",
"copilotArchiver.s3.accessKeyId": "YOUR_ACCESS_KEY",
"copilotArchiver.s3.secretAccessKey": "YOUR_SECRET_KEY",
"copilotArchiver.s3.folderPrefix": "copilot-snapshots"
```

> [!WARNING]
> **Security Notice**: Currently, AWS credentials are stored in plain text in VS Code settings.
> - **Do not commit** your `.vscode/settings.json` if it contains real credentials.
> - **Future Plan**: We plan to move credential storage to VS Code's secure `SecretStorage` API in a future update.

## Usage

The extension runs automatically when you open a workspace. It monitors the Copilot Chat log and triggers a snapshot whenever a turn is completed.

## Output Structure

Snapshots are stored in `.snapshots/`:

```
.snapshots/
  <chat_id>/
    <turn_index>/
      _snapshot_metadata.json
      <workspace_files>...
```
