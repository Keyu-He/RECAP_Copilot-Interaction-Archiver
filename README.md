# Copilot Interaction Archiver

Automatically archives your workspace at the end of each GitHub Copilot conversation turn.

## Features

- **Automatic Detection**: Monitors the GitHub Copilot Chat log file in the VS Code logs directory
- **Turn-based Archives**: Captures code state after each conversation turn completes
- **Smart Detection**: Detects completion via `ccreq` `| success | <model_name> |` pattern in log
- **Configurable**: Exclude patterns, output paths, and timing all customizable

## Installation

### From Source

1. Clone this repository
2. Run `npm install` in the extension directory
3. Run `npm run compile`
4. In VS Code, press F5 to launch Extension Development Host
5. Or package with `vsce package` and install the .vsix file

### Quick Start

1. Open a workspace where you use GitHub Copilot
2. Enable debug logging for Copilot (creates `GitHub Copilot Chat.log`)
3. The extension will automatically start watching
4. Snapshots will be saved to `./.snapshots/turn_N/` after each conversation turn

## Commands

- `Copilot Archiver: Enable` - Enable automatic capture
- `Copilot Archiver: Disable` - Disable automatic capture
- `Copilot Archiver: Capture Now` - Manually capture a snapshot

## Configuration

- `copilotArchiver.enabled`: Enable/disable automatic capture (default: true)
- `copilotArchiver.outputPath`: Where to store archives (default: ".snapshots")
- `copilotArchiver.quietPeriodMs`: Wait time for turn completion (default: 7000ms)
- `copilotArchiver.excludePatterns`: Files/folders to skip (default: [".git", "node_modules", ...])
- `copilotArchiver.logFileName`: Default Copilot chat log file name (default: "GitHub Copilot Chat.log")
- `copilotArchiver.logFilePatterns`: Glob patterns for Copilot logs (searched under VS Code logs directory)
- `copilotArchiver.jsonOutputEnabled`: Also emit Copilot JSON files (full and compact) like store_copilot_json.py
- `copilotArchiver.jsonOutputDir`: Directory for JSON outputs (default: `copilot_debug_messages` under workspace)

## How It Works

1. **File Watching**: Monitors the Copilot Chat log file under the VS Code logs directory
2. **Completion Detection**: Watches for `ccreq` `| success | <model_name> |` pattern in log
   - Example: `2025-10-24 18:29:06.810 [info] ccreq:7fb741a0 | success | gpt-5-mini | 27308ms | [panel/editAgent]`
3. **JSON Writer**: Continuously aggregates `[debug] messages:`/`[debug] input:` lines and writes JSON outputs matching `store_copilot_json.py`
4. **Snapshot Trigger**: When completion detected, immediately captures workspace snapshot
5. **Snapshot Capture**: Copies workspace to `.snapshots/turn_N/`
6. **Metadata**: Creates `_snapshot_metadata.json` with timestamp and file counts

## Use with Python Analysis Script

This extension works in tandem with `store_copilot_json.py`:

1. Extension captures snapshots during conversation
2. Python script post-processes log file to create compact JSON
3. Python script links snapshots to turns in the JSON output

```bash
python store_copilot_json.py /path/to/workspace
```

## Requirements

- VS Code 1.80.0 or higher
- GitHub Copilot extension installed
- Debug logging enabled for Copilot

## Known Limitations

- Requires debug log file to be present
- May capture mid-turn if assistant responses are very spaced out
- Large workspaces will take time to copy

## License

MIT
