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

const CONCURRENCY_LIMIT = 50;

async function downloadS3Folder() {
    try {
        if (!process.env.AWS_ACCESS_KEY_ID) {
            throw new Error("AWS Credentials missing in .env");
        }

        console.log(`Listing objects in bucket ${config.bucket} with prefix '${config.prefix}'...`);

        let continuationToken = undefined;
        let allItems = [];

        // 1. List all objects first
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
                        allItems.push(item);
                    }
                }
            }

            continuationToken = response.NextContinuationToken;
        } while (continuationToken);

        if (allItems.length === 0) {
            console.log('No objects found.');
            return;
        }

        console.log(`Found ${allItems.length} files. Starting download with concurrency ${CONCURRENCY_LIMIT}...`);

        // 2. Download with concurrency limit
        const queue = [...allItems];
        let completedCount = 0;
        const total = allItems.length;

        const downloadWorker = async () => {
            while (queue.length > 0) {
                const item = queue.shift();
                if (!item) break;

                const localPath = path.join(downloadDir, item.Key);
                const dir = path.dirname(localPath);

                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                // console.log(`Downloading ${item.Key}...`);

                try {
                    const getCommand = new GetObjectCommand({
                        Bucket: config.bucket,
                        Key: item.Key
                    });

                    const getResponse = await client.send(getCommand);
                    await pipeline(getResponse.Body, fs.createWriteStream(localPath));

                    completedCount++;
                    if (completedCount % 10 === 0 || completedCount === total) {
                        process.stdout.write(`\rProgress: ${completedCount}/${total}`);
                    }
                } catch (e) {
                    console.error(`\nFailed to download ${item.Key}:`, e.message);
                }
            }
        };

        const workers = [];
        for (let i = 0; i < Math.min(CONCURRENCY_LIMIT, allItems.length); i++) {
            workers.push(downloadWorker());
        }

        await Promise.all(workers);

        console.log(`\n\nDownload complete! Files are in: ${downloadDir}`);

    } catch (err) {
        console.error('\nError listing/downloading from S3:', err);
    }
}

downloadS3Folder();
