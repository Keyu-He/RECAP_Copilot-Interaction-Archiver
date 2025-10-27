# Installation and Usage Guide

## Prerequisites

- VS Code 1.80.0 or higher
- Node.js 18.x or higher
- GitHub Copilot extension installed

## Installation Steps

### 1. Install Dependencies

```bash
cd copilot-snapshot-extension
npm install
```

### 2. Compile TypeScript

```bash
npm run compile
```

### 3. Test the Extension (Development)

**Option A: Launch Extension Development Host**
1. Open the `copilot-snapshot-extension` folder in VS Code
2. Press `F5` to launch the Extension Development Host
3. In the new window, open your workspace (e.g., `/Users/keyuhe/RECAP/tic-tac-toe_repro/workspace1-copilot-keyu`)
4. Start using Copilot - snapshots will be captured automatically

**Option B: Package and Install**
```bash
# Install vsce (VS Code Extension Manager) if not already installed
npm install -g @vscode/vsce

# Package the extension
vsce package

# This creates copilot-snapshot-0.1.0.vsix
# Install it via VS Code: Extensions > ... > Install from VSIX
```

## Configuration

After installation, configure the extension in VS Code settings:

```json
{
  "copilotSnapshot.enabled": true,
  "copilotSnapshot.outputPath": "snapshots",
  "copilotSnapshot.quietPeriodMs": 7000,
  "copilotSnapshot.excludePatterns": [
    ".git",
    "node_modules",
    "__pycache__",
    ".DS_Store",
    "*.pyc",
    "GitHub Copilot Chat.log",
    "snapshots"
  ]
}
```

## Usage Workflow

### 1. Enable Copilot Debug Logging

The extension requires the GitHub Copilot Chat log file. This is usually enabled when running Copilot in VS Code.

### 2. Start a Copilot Session

1. Open a workspace in VS Code
2. Enable the extension (it should auto-enable on startup)
3. Start chatting with Copilot
4. After each turn completes (quiet period detected), a snapshot is captured

### 3. View Snapshots

Snapshots are stored in your workspace at:
```
your-workspace/
  snapshots/
    turn_0/
      index.html
      script.js
      _snapshot_metadata.json
    turn_1/
      ...
```

### 4. Post-Process with Python Script

After your Copilot session:

```bash
cd /Users/keyuhe/RECAP/copilot-analyses
python store_copilot_json.py /path/to/your/workspace
```

This will:
- Extract conversation from log file
- Create compact JSON with turns
- Link snapshots to turns in the JSON output

## Verification

Check that everything works:

1. **Extension is running**: Look for "Copilot Snapshot extension is now active" in Output > Extension Host
2. **Log file detected**: Check Output panel for "Watching for Copilot log at: ..."
3. **Snapshots created**: Verify `snapshots/turn_0/` appears after first conversation turn
4. **Metadata exists**: Check `_snapshot_metadata.json` in snapshot directories
5. **Python script links snapshots**: Run Python script and verify compact JSON includes `code_snapshot` fields

## Troubleshooting

**No snapshots created?**
- Check if `GitHub Copilot Chat.log` exists in workspace
- Verify extension is enabled: Run "Copilot Snapshot: Enable" command
- Check Output panel (View > Output > select "Copilot Snapshot")

**Snapshots captured too early/late?**
- Adjust `copilotSnapshot.quietPeriodMs` (increase for slower responses)

**Large workspace takes too long?**
- Add more patterns to `copilotSnapshot.excludePatterns`
- Consider excluding large directories

**Python script doesn't link snapshots?**
- Verify snapshots exist in `workspace/snapshots/turn_N/`
- Check that `_snapshot_metadata.json` files are present
- Ensure snapshot directories match `turn_N` naming pattern
