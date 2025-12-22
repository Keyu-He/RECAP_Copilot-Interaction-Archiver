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

async function downloadS3Folder() {
    try {
        if (!process.env.AWS_ACCESS_KEY_ID) {
            throw new Error("AWS Credentials missing in .env");
        }

        console.log(`Listing objects in bucket ${config.bucket} with prefix '${config.prefix}'...`);

        let continuationToken = undefined;
        do {
            const command = new ListObjectsV2Command({
                Bucket: config.bucket,
                Prefix: config.prefix,
                ContinuationToken: continuationToken
            });

            const response = await client.send(command);

            if (!response.Contents || response.Contents.length === 0) {
                console.log('No objects found.');
                return;
            }

            for (const item of response.Contents) {
                if (item.Key.endsWith('/')) continue; // Skip folders

                const localPath = path.join(downloadDir, item.Key);
                const dir = path.dirname(localPath);

                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                console.log(`Downloading ${item.Key}...`);

                const getCommand = new GetObjectCommand({
                    Bucket: config.bucket,
                    Key: item.Key
                });

                const getResponse = await client.send(getCommand);
                await pipeline(getResponse.Body, fs.createWriteStream(localPath));
            }

            continuationToken = response.NextContinuationToken;
        } while (continuationToken);

        console.log(`\nDownload complete! Files are in: ${downloadDir}`);

    } catch (err) {
        console.error('Error downloading from S3:', err);
    }
}

downloadS3Folder();
