# Copilot Interaction Archiver

Automatically archives your workspace at the end of each GitHub Copilot conversation turn.

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
4. Snapshots will be saved to `./.snapshots/N/` after each conversation turn

## Commands

- `Copilot Archiver: Enable` - Enable automatic capture
- `Copilot Archiver: Disable` - Disable automatic capture
- `Copilot Archiver: Capture Now` - Manually capture a snapshot

## Configuration

- `copilotArchiver.enabled`: Enable/disable automatic capture (default: true)
- `copilotArchiver.outputPath`: Where to store archives (default: ".snapshots")
- `copilotArchiver.excludePatterns`: Files/folders to skip (default: [".git", "node_modules", ...])
- `copilotArchiver.logFileName`: Default Copilot chat log file name (default: "GitHub Copilot Chat.log")
- `copilotArchiver.logFilePatterns`: Glob patterns for Copilot logs (searched under VS Code logs directory)
- `copilotArchiver.jsonOutputEnabled`: Also emit Copilot JSON files (full and compact) like store_copilot_json.py
- `copilotArchiver.jsonOutputDir`: Directory for JSON outputs (default: `copilot_debug_messages` under workspace)

## How It Works

1. **File Watching**: Monitors the Copilot Chat log file under the VS Code logs directory
2. **Completion Detection**: Watches for `[debug] messages:`/`[debug] input:` lines indicating agent responses/completions.
3. **Snapshot Trigger**: When completion detected, immediately captures workspace snapshot
4. **Snapshot Capture**: Copies workspace to `.snapshots/N/`
5. **Metadata**: Creates `_snapshot_metadata.json` with timestamp and turn info

## Requirements

- VS Code 1.80.0 or higher
- GitHub Copilot extension installed
- Debug logging enabled for Copilot

## Known Limitations

- Requires debug log file to be present
- Large workspaces will take time to copy

## License

MIT
