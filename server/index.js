require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
app.use(cors());
app.use(express.json());

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;

app.post('/sign-upload', async (req, res) => {
    try {
        const { key, contentType } = req.body;

        if (!key) {
            return res.status(400).json({ error: 'Missing "key" in request body' });
        }

        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            ContentType: contentType || 'application/octet-stream'
        });

        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 }); // 5 minutes

        console.log(`Generated signed URL for: ${key}`);
        res.json({ uploadUrl, key });
    } catch (err) {
        console.error('Error generating signed URL:', err);
        res.status(500).json({ error: 'Failed to generate upload URL' });
    }
});

// Basic health check
app.get('/', (req, res) => {
    res.send('Copilot Archiver Backend is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
