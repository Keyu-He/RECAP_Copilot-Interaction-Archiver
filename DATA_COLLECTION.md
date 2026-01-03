# Data Collection Guide

This guide is for **administrators and researchers** who need to bulk download the collected interaction data from the S3 bucket.

## Overview
Student data is securely stored in your configured S3 bucket with the following structure:
```
s3://<bucket-name>/
    <userId>/
        repo_snapshots/
            <timestamp>/
        <chatId>/
            metadata.json
            chat_session.json
```

We provide a utility script (`server/download_s3.js`) to download and organize this data locally.

## Prerequisites
*   **Node.js** (v18 or higher)
*   **AWS Credentials** with `AmazonS3ReadOnlyAccess` (or FullAccess) to the target bucket.

## Setup

1.  **Clone the Repository** (if you haven't already):
    ```bash
    git clone https://github.com/keyuhe/copilot-archiver.git
    cd copilot-archiver
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
  <student_andrew_id>/
    copilot_snapshots/
        repo_snapshots/
            <timestamp1>/              <-- Code snapshot
            <timestamp2>/
        <chat_session_id>/
            metadata.json                <-- Metadata for the chat session
            chat_session.json            <-- Full chat history
```
