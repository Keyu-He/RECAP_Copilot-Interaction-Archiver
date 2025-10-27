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
