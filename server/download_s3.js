require('dotenv').config();
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
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

const client = new S3Client(config);
const downloadDir = path.join(__dirname, '..', 'downloaded_snapshots');

const CONCURRENCY_LIMIT = 100;

// Async generator to yield items one by one from S3 pagination
async function* listObjectsGenerator() {
    let continuationToken = undefined;

    console.log(`Listing objects in bucket ${config.bucket} with prefix '${config.prefix}'...`);

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

async function downloadS3Folder() {
    try {
        if (!process.env.AWS_ACCESS_KEY_ID) {
            throw new Error("AWS Credentials missing in .env");
        }

        console.log(`Starting download with concurrency ${CONCURRENCY_LIMIT}...`);

        let completedCount = 0;
        const activeDownloads = new Set();

        // Use an async iterator to process items as they are listed, preventing memory buildup
        for await (const item of listObjectsGenerator()) {
            // If we've reached the concurrency limit, wait for at least one download to finish
            if (activeDownloads.size >= CONCURRENCY_LIMIT) {
                await Promise.race(activeDownloads);
            }

            // Create the download promise
            const downloadPromise = (async () => {
                const localPath = path.join(downloadDir, item.Key);
                const dir = path.dirname(localPath);

                try {
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }

                    const getCommand = new GetObjectCommand({
                        Bucket: config.bucket,
                        Key: item.Key
                    });

                    const getResponse = await client.send(getCommand);
                    await pipeline(getResponse.Body, fs.createWriteStream(localPath));

                    completedCount++;
                    if (completedCount % 10 === 0) {
                        process.stdout.write(`\rFiles Downloaded: ${completedCount} (Active: ${activeDownloads.size})`);
                    }
                } catch (e) {
                    console.error(`\nFailed to download ${item.Key}:`, e.message);
                }
            })();

            // Track the promise
            activeDownloads.add(downloadPromise);

            // Remove from set when done
            downloadPromise.finally(() => activeDownloads.delete(downloadPromise));
        }

        // Wait for remaining downloads
        await Promise.all(activeDownloads);

        console.log(`\n\nDownload complete! Total files: ${completedCount}. Files are in: ${downloadDir}`);

    } catch (err) {
        console.error('\nError downloading from S3:', err);
    }
}

downloadS3Folder();
