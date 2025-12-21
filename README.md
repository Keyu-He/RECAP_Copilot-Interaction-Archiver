# Copilot Interaction Archiver

Automatically archive your workspace at the end of each Copilot turn.

## Features

- **Automatic Snapshots**: Captures the state of your workspace after every Copilot interaction.
- **Chat History**: Saves the conversation history associated with each snapshot.
- **S3 Integration**: (Optional) Zips and uploads snapshots to Amazon S3.
- **Smart Tracking**: Uses a unique Chat ID (Session ID) to organize snapshots.


# Installation and Usage Guide

## Prerequisites

- VS Code 1.80.0 or higher
- Node.js 18.x or higher
- GitHub Copilot extension installed

## Installation Steps

### 1. Install Dependencies

```bash
cd Copilot-Interaction-Archiver
npm install
```

### 2. Compile TypeScript

```bash
npm run compile
```

### 3. Test the Extension (Development)

**Option A: Launch Extension Development Host**
1. Open the `Copilot-Interaction-Archiver` folder in VS Code
2. Press `F5` to launch the Extension Development Host
3. In the new window, open your workspace (e.g., `RECAP/tic-tac-toe_repro/workspace1-copilot`)
4. Start using Copilot - snapshots will be captured automatically

**Option B: Package and Install**
```bash
# Install vsce (VS Code Extension Manager) if not already installed
npm install -g @vscode/vsce

# Package the extension
vsce package

# This creates copilot-archiver-<version>.vsix
# Install it via VS Code: Extensions > ... > Install from VSIX
```


## Usage Workflow

### 1. Enable Copilot Debug Logging

The extension requires the GitHub Copilot Chat log file. This is usually enabled when running Copilot in VS Code.

### 2. Start a Copilot Session

1. Open a workspace in VS Code
2. Enable the extension (it should auto-enable on startup)
3. Start chatting with Copilot
4. Snapshots are captured during and after each turn automatically

### 3. View Snapshots

Snapshots are stored in your workspace at:
```
your-workspace/
  .snapshots/
    0/
      index.html
      script.js
      _snapshot_metadata.json
    1/
      ...
    copilot_debug_messages/           # JSON outputs of the session
      your-workspace-compact.json
      your-workspace-incremental.jsonl
      your-workspace.json
```

## Configuration

### S3 Synchronization

This extension supports secure uploading of snapshots to a centralized S3 bucket.

#### For Users
You only need to configure the connection to the archive server.
1.  Obtain the **Backend URL** from your administrator.
2.  Open your **User Settings (JSON)** (`Cmd+Shift+P` > "Open User Settings (JSON)").
3.  Add the following:
    ```json
    "copilotArchiver.s3.enabled": true,
    "copilotArchiver.backendUrl": "http://<ADMINISTRATOR_PROVIDED_IP>:3000"
    ```

#### For Administrators
To set up the backend server (required for handling S3 uploads securely), please refer to the **[Server Deployment Guide](DEPLOY.md)**.

## Output Structure

The extension creates a detailed archive of your interaction:

### Local Structure (`.snapshots/`)
```
.snapshots/
  <chat_id>/
    codebase_snapshots/
      <timestamp>/            # Full copy of workspace files
    <turn_index>_<phase>/     # Metadata folder (e.g., 1_input, 1_output)
      GitHubCopilotChat.log   # Full chat log copy
      summary.json            # Link to codebase snapshot & turn summary
      metadata.json           # Raw turn data
      <chat_id>.json          # Full session JSON
    debug/
      <chat_id>/
        _debug_changes.jsonl  # Granular change log
```

### S3 Structure
The S3 bucket mirrors the local structure exactly, but files are uploaded individually to allow granular access:
`s3://<bucket>/<prefix>/<chat_id>/...`
- **Codebase Snapshots**: `<chat_id>/codebase_snapshots/<timestamp>/...`
- **Turn Metadata**: `<chat_id>/<turn_index>_<phase>/...`
- **Debug Logs**: `<chat_id>/debug/_debug_changes.jsonl` (Overwritten on update)

### Local
Snapshots are also stored locally in your workspace under `.snapshots/`.


