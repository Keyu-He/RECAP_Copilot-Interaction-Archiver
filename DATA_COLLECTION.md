# Data Collection Guide

This guide is for **administrators and researchers** who need to bulk download the collected interaction data from the S3 bucket.

## Overview
Student data is securely stored in your configured S3 bucket with the following structure:
```
s3://<bucket-name>/
    <userId>/
        interaction_snapshots/
            <timestamp>/
                repo/               <-- User files (only if manual capture)
                ccreq.md            <-- Code Request context (made by agent, if available)
                _meta.json       
        <chatId>/
            metadata.json           <-- Metadata (e.g. workspace path)
            chat_session.json       <-- Full chat history (includes user prompts and agent responses)
        <workspace_name>/
            shadow_git.bundle       <-- Shadow Git bundle to track file modifications
            history_<timestamp>.bundle  <-- Autosaved checkpoints of the Shadow Git bundle (e.g. every day)
```

We provide a utility script (`server/download_s3.js`) to download and organize this data locally.

## Prerequisites
*   **Node.js** (v18 or higher)
*   **AWS Credentials** with `AmazonS3ReadOnlyAccess` (or FullAccess) to the target bucket.

## Setup

1.  **Clone the Repository** (if you haven't already):
    ```bash
    git clone https://github.com/Keyu-He/copilot-interaction-archiver.git
    cd copilot-interaction-archiver
    ```

2.  **Install Dependencies**:
    ```bash
    cd server
    npm install
    ```

3.  **Configure Admin Credentials**:
    **Ask your instructor or project administrator for the Admin S3 Credentials, including the `AWS_SECRET_ACCESS_KEY`, `SHARED_PASSWORD`, and `JWT_SECRET`.**
    
    Once you have them, create a `.env` file in the `server/` directory:
    
    ```properties
    # server/.env
    AWS_ACCESS_KEY_ID=<YOUR-ACCESS-KEY-ID>
    AWS_SECRET_ACCESS_KEY=<YOUR-SECRET-ACCESS-KEY>
    AWS_REGION=us-east-1
    S3_BUCKET_NAME=<YOUR-S3-BUCKET-NAME>
    PORT=3000
    SHARED_PASSWORD=<YOUR-SHARED-PASSWORD>
    JWT_SECRET=<YOUR-JWT-SECRET>
    ```

## Downloading Data

Run the download script from the `server` directory:

```bash
node download_s3.js
```

### What Happens?
*   The script lists all objects in the bucket.
*   It downloads them to `../downloaded_snapshots/` (relative to the `server` folder).
*   It preserves the folder structure: `downloaded_snapshots/<userId>/<chatId>/...`

## Data Structure

After downloading, you will find:

```
downloaded_snapshots/
  <hashed_userId>/
    interaction_snapshots/
        <timestamp>/
            repo/
            ccreq.md
            _meta.json
    <chatId>/
        metadata.json
        chat_session.json | chat_session.jsonl
    <workspace_name>/
        shadow_git.bundle
        history_<timestamp>.bundle
```

### File Reference

#### `interaction_snapshots/<timestamp>/`

Each interaction snapshot is a directory named by its ISO timestamp (colons replaced with underscores, e.g. `2026-01-22T15_30_00.000Z`).

**`_meta.json`**
- Produced by: LogWatcher (triggered by Copilot Chat log file events)
- Contains:
  - `input_timestamp` — when the interaction was triggered
  - `capture_timestamp` — when the snapshot was taken
  - `contain_ccreq` — whether a ccreq.md file was captured
  - `interaction_type` — type of interaction, parsed from the `requestType` field in ccreq.md (see below). `unknown` if ccreq.md was not available.
  - `workspace_path` — absolute path to the user's workspace
- Notes:
  - This file accompanies `ccreq.md` to capture extra metadata that ccreq.md does not contain (e.g. workspace path, capture timing).
  - <!-- TODO: add more details -->

**`ccreq.md`**
- Produced by: GitHub Copilot Chat extension (debug output, level: info). Our LogWatcher tails the `GitHub Copilot Chat.log` file and captures `ccreq:` entries on success.
- Contains: The full code request context that Copilot's agent assembles before sending to the model. Includes system instructions, user message, editor context, workspace info, and tool definitions.
- Key field — `requestType` (in the `## Metadata` section):
  - `ChatResponses` — The agent response for GitHub Copilot Chat (the one we care about most). Used for advanced models with reasoning capabilities (e.g. gpt-5-mini). Includes fields like `reasoning` effort/summary.
  - `ProxyChatCompletions` — Inline code completions. Uses Copilot-specific proxy models (e.g. `copilot-nes-oct`). Does not have a `resolved model` field.
  - `ChatCompletions` — Internal intermediate tool calls made by Copilot Chat's agent (e.g. for context gathering). Uses standard models (e.g. `gpt-4o-mini`). Has a `resolved model` field.
- Notes:
  - <!-- TODO: add more details -->

**`repo/`**
- Produced by: Manual snapshot capture (via command palette)
- Contains: A copy of all workspace files at the time of capture (excluding blacklisted patterns like `node_modules`, `.git`, binary files, etc.)
- Notes:
  - Only present when `includeRepoFiles` is true (manual captures). Automatic interaction snapshots do not include repo files.
  - <!-- TODO: add more details -->

---

#### `<chatId>/`

Each chat session directory is named by its VS Code chat session UUID.

**`chat_session.json`** / **`chat_session.jsonl`**
- Produced by: VS Code Copilot extension (we watch and copy the file)
- Contains: Full chat history including user prompts, model responses, tool invocations, edit groups, model metadata, and usage stats.
- Format:
  - `.json` — single JSON object with top-level `requests` array. Used by older Copilot versions.
  - `.jsonl` — event-sourced incremental format. `kind:0` = initial state, `kind:1` = field update, `kind:2` = array update. Used by Copilot starting ~Feb 2026.
- Key fields: (from chat_session.json)
  - `requests[i].message.text` — user's prompt
  - `requests[i].response` — array of response parts (text, thinking, toolInvocation, textEditGroup)
  - `requests[i].modelId` — model identifier (e.g. `copilot/gpt-5.2`)
  - `requests[i].result.details` — resolved model name + pricing multiplier (e.g. `Claude Haiku 4.5 • 0.33x`)
  - `requests[i].result.metadata.usage` — token counts (prompt, completion)
  - `selectedModel.metadata.family` — model family for `copilot/auto` resolution
- Notes:
  - Three known schema versions exist (all report `version: 3`), differing in where `selectedModel` is located: top-level, inside `inputState`, or alongside `isImported`.
  - <!-- TODO: add more details -->

**`metadata.json`**
- Produced by: Our extension (ChatSessionWatcher)
- Contains:
  - `workspacePath` — absolute path to the user's workspace at collection time
- Notes:
  - Created once per chat session directory.
  - <!-- TODO: add more details -->

---

#### `<workspace_name>/`

Shadow git data, named by the workspace folder name.

**`shadow_git.bundle`**
- Produced by: Our extension (ShadowGitManager)
- Contains: A git bundle of the shadow repository that tracks all file modifications in the workspace. Each commit represents a file change event.
- Commit types:
  - `USER EDIT` — file was modified
  - `USER CREATE` — file was created
  - `USER DELETE` — file was deleted
  - `DIRTY SNAPSHOT` — periodic dirty state capture
  - `Initial Shadow Repo Commit` — first commit when shadow git is initialized
- Notes:
  - Commit messages do not reliably distinguish AI-generated edits from human edits. To identify AI-generated edits, shadow git commits should be analyzed alongside `chat_session.json`/`.jsonl` (which contains `textEditGroup` response parts) and/or `ccreq.md` files.
  - <!-- TODO: add more details -->

**`history_<timestamp>.bundle`**
- Produced by: Our extension (ShadowGitManager, periodic auto-save)
- Contains: A checkpoint of the shadow git bundle at the given timestamp. Acts as a backup in case the primary bundle is corrupted or overwritten.
- Notes:
  - This backup bundle is created every 24 hours (if the shadow_git.bundle is modified in the past 24 hours).
  - <!-- TODO: add more details -->
