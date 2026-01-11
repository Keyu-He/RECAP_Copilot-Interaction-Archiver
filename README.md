# Copilot Interaction Archiver

**The Copilot Interaction Archiver** is a research tool designed to automatically capture and archive your interactions with GitHub Copilot. It creates a detailed timeline of your coding session, including chat logs and code snapshots.
**Note:** You must provide your CMU Andrew ID and Class Password to login to this extension.

## Prerequisites
*   **VS Code** (v1.80.0 or higher)
*   **Node.js** (v18 or higher)
*   **Git**

## Usage Guide

### 1. Installation
1.  Obtain the `.vsix` file from your instructor or build it from source (see below).
2.  Open VS Code.
3.  Go to Extensions -> `...` (Views and More Actions) -> **Install from VSIX...**
4.  Select the file.

### 2. Activation for Workspace
When you open a folder/workspace for the first time, you will see a notification:
> "Enable Copilot Interaction Archiver for this workspace?"

![Placeholder: Screenshot of the Enable Workspace Modal Prompt]

1.  Click **Yes**.
2.  This ensures the archiver only runs on approved homework assignments.

*If you missed the prompt or need to re-enable it:*
- Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).
- Run: **`Copilot Archiver: Enable for this Workspace`**.

### 3. Log In
1.  Open Command Palette.
2.  Run: **`Copilot Archiver: Login`**.
3.  Enter your **Andrew ID**.
4.  Enter the **Class Password**.

![Placeholder: GIF of the Login Flow]

### 4. Enable Debug Logging (Critical)
For the extension to capture your interactions, **GitHub Copilot Chat must be in Debug mode**.

1.  Open Command Palette.
2.  Run: **`Copilot Archiver: Enable Copilot Debug Logging`**.
3.  A modal will appear explaining the steps. Click **Open Menu**.
4.  In the menu that appears at the top:
    - Select **"GitHub Copilot Chat"** (Make sure it is exactly this name, not just "GitHub Copilot").
    - Click the **Double Checkmark (Set as Default)** icon next to "Debug".

![Placeholder: GIF showing how to select GitHub Copilot Chat and set Log Level to Debug]

> **Why?** Without this, we cannot see the detailed "Thought Process" or "Code Edits" from Copilot.

### 5. Coding
- Work as normal.
- The status bar item `$(check) Archiver: <YourID>` indicates everything is working.
- Click the status bar item to open the **Archiver Menu**.

---

## Data Privacy & Storage
Your data is stored securely:
- **Local**: Inside `.snapshots/` in your workspace (safe to delete if needed, but useful for verification).
- **Cloud**: Uploaded to a private, secure S3 bucket managed by the course staff.

---

## Build from Source (Advanced)
If you need to build the extension yourself:
1.  Clone repo: `git clone ...`
2.  `npm install`
3.  `npm run compile`
4.  `vsce package`
