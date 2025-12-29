# Copilot Interaction Archiver

**The Copilot Interaction Archiver** is a research tool designed to automatically capture and archive your interactions with GitHub Copilot. It creates a detailed timeline of your coding session, including chat logs and code snapshots.
**Note:** You must provide your CMU Andrew ID and Class Password to login to this extension.

## Prerequisites
*   **VS Code** (v1.80.0 or higher)
*   **Node.js** (v18 or higher)
*   **Git**

## Getting Started

### 1. Build and Install the Extension

If you haven't been provided with a `.vsix` file, you need to build it from source:

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/keyuhe/copilot-archiver.git
    cd copilot-archiver
    ```

2.  **Install dependencies and compile**:
    ```bash
    npm install
    npm run compile
    ```

3.  **Package the extension**:
    ```bash
    # Install vsce if you haven't already
    npm install -g @vscode/vsce
    
    # Create the package
    vsce package
    ```
    *This will generate a file named `copilot-archiver-0.6.4.vsix` in the directory.*

4.  **Install the VSIX**:
    *   Open **VS Code**.
    *   Go to the **Extensions** view (`Cmd+Shift+X` or `Ctrl+Shift+X`).
    *   Click the **...** (three dots) action menu in the top-right corner.
    *   Select **"Install from VSIX..."**.
    *   Select the generated `copilot-archiver-0.6.4.vsix` file.

### 2. Enable for Workspace Only
To ensure the archiver only runs on your homework assignments:
1.  In the **Extensions** view, find **Copilot Interaction Archiver**.
2.  Click the **Disable** button -> Select **Disable**.
3.  Open your homework folder (workspace).
4.  Go back to the extension entry.
5.  Click **Enable** -> Select **Enable (Workspace)**.

### 3. Log In
The extension requires authentication to securely upload your data.

1.  Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows) to open the Command Palette.
2.  Type and run: **`Copilot Archiver: Login`**.
3.  Enter your **Andrew ID** when prompted.
4.  Enter the **Class Password** provided by your instructor.

> **Note:** You only need to log in once every 6 months. If your session expires, the extension will prompt you to log in again.

### 4. Start Coding!
The extension works automatically in the background.

*   **Chat**: Open GitHub Copilot Chat and interact as usual.
*   **Snapshots**: The extension captures the state of your code *before* you ask a question and *after* Copilot generates a solution.
*   **Data**: Snapshots are uploaded securely in the background.

---

## Troubleshooting

### "You are not logged in" Error
If you see an error message saying "Snapshots are not being uploaded", simply run the **`Copilot Archiver: Login`** command again.

### Where is my data?
Your data is stored in two places:
1.  **Locally**: In your workspace under the `.snapshots` folder.
2.  **Server**: Securely uploaded to our server (S3) automatically.
