require('dotenv').config();
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

// Configuration from .env
const config = {
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    },
    bucket: process.env.S3_BUCKET_NAME || 'copilot-interaction-bucket',
    prefix: '' // Download everything by default
};

const CONCURRENCY_LIMIT = 200;
const MAX_RETRIES = 3;
const BASE_TIMEOUT_MS = 30_000; // 30s minimum
const TIMEOUT_PER_MB = 5_000;   // +5s per MB
const MAX_TIMEOUT_MS = 600_000; // 10 min cap

function getTimeout(sizeBytes) {
    const sizeMB = (sizeBytes || 0) / (1024 * 1024);
    return Math.min(Math.max(BASE_TIMEOUT_MS, BASE_TIMEOUT_MS + sizeMB * TIMEOUT_PER_MB), MAX_TIMEOUT_MS);
}

const client = new S3Client({
    ...config,
    requestHandler: new NodeHttpHandler({
        httpsAgent: new https.Agent({ maxSockets: CONCURRENCY_LIMIT }),
        connectionTimeout: 10_000,
    }),
});

function sanitizeKey(key) {
    // Replace characters that are invalid on Windows/some filesystems
    return key.replace(/:/g, '_').replace(/[<>"|?*]/g, '_');
}
const downloadDir = path.join(__dirname, '..', 'downloaded_snapshots');

// Async generator to yield items one by one from S3 pagination
// Async generator to yield items one by one from S3 pagination
async function* listObjectsGenerator() {
    let continuationToken = undefined;

    // console.log(`Listing objects in bucket ${config.bucket} with prefix '${config.prefix}'...`);

    do {
        const command = new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: config.prefix,
            ContinuationToken: continuationToken
        });

        const response = await client.send(command);

        if (response.Contents) {
            for (const item of response.Contents) {
                if (!item.Key.endsWith('/')) {
                    yield item;
                }
            }
        }

        continuationToken = response.NextContinuationToken;
    } while (continuationToken);
}

async function countTotalFiles() {
    console.log(`Calculating total files in bucket ${config.bucket}...`);
    let count = 0;
    let continuationToken = undefined;

    do {
        const command = new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: config.prefix,
            ContinuationToken: continuationToken
        });
        const response = await client.send(command);
        if (response.Contents) {
            count += response.Contents.filter(item => !item.Key.endsWith('/')).length;
        }
        continuationToken = response.NextContinuationToken;
        process.stdout.write(`\rFound ${count} files...`);
    } while (continuationToken);

    console.log(`\nTotal files to download: ${count}`);
    return count;
}

async function downloadS3Folder() {
    try {
        if (!process.env.AWS_ACCESS_KEY_ID) {
            throw new Error("AWS Credentials missing in .env");
        }

        const totalFiles = await countTotalFiles();
        if (totalFiles === 0) {
            console.log("No files found.");
            return;
        }

        console.log(`Starting download with concurrency ${CONCURRENCY_LIMIT}...`);

        let completedCount = 0;
        let failedCount = 0;
        const activeDownloads = new Set();

        // Use an async iterator to process items as they are listed, preventing memory buildup
        for await (const item of listObjectsGenerator()) {
            // If we've reached the concurrency limit, wait for at least one download to finish
            if (activeDownloads.size >= CONCURRENCY_LIMIT) {
                await Promise.race(activeDownloads);
            }

            // Create the download promise
            const downloadPromise = (async () => {
                const localPath = path.join(downloadDir, sanitizeKey(item.Key));
                const dir = path.dirname(localPath);

                try {
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }

                    const timeoutMs = getTimeout(item.Size);
                    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                        try {
                            const abortController = new AbortController();
                            const timeout = setTimeout(() => abortController.abort(), timeoutMs);
                            try {
                                const getCommand = new GetObjectCommand({
                                    Bucket: config.bucket,
                                    Key: item.Key
                                });
                                const getResponse = await client.send(getCommand, {
                                    abortSignal: abortController.signal
                                });
                                await pipeline(getResponse.Body, fs.createWriteStream(localPath), {
                                    signal: abortController.signal
                                });
                            } finally {
                                clearTimeout(timeout);
                            }
                            break;
                        } catch (retryErr) {
                            // Clean up partial file on failure
                            if (fs.existsSync(localPath)) {
                                try { fs.unlinkSync(localPath); } catch {}
                            }
                            if (attempt === MAX_RETRIES - 1) throw retryErr;
                            await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
                        }
                    }

                    completedCount++;
                    const percent = ((completedCount / totalFiles) * 100).toFixed(1);
                    process.stdout.write(`\rProgress: ${completedCount}/${totalFiles} (${percent}%) | Active: ${activeDownloads.size}   `);
                } catch (e) {
                    failedCount++;
                    console.error(`\nFailed to download ${item.Key} after ${MAX_RETRIES} attempts: ${e.message}`);
                }
            })();

            // Track the promise
            activeDownloads.add(downloadPromise);

            // Remove from set when done
            downloadPromise.finally(() => activeDownloads.delete(downloadPromise));
        }

        // Wait for remaining downloads
        await Promise.all(activeDownloads);

        console.log(`\n\nDownload complete! ${completedCount} downloaded, ${failedCount} failed. Files are in: ${downloadDir}`);

    } catch (err) {
        console.error('\nError downloading from S3:', err);
    }
}

downloadS3Folder();
