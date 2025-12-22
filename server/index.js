require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
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
const SHARED_PASSWORD = process.env.SHARED_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET; // CRITICAL: This must be set in .env

// --- Authentication Endpoint ---
app.post('/login', (req, res) => {
    const { andrewId, password } = req.body;

    if (!andrewId || !password) {
        return res.status(400).json({ error: 'Missing andrewId or password' });
    }

    if (password !== SHARED_PASSWORD) {
        return res.status(401).json({ error: 'Invalid password' });
    }

    // Issue Token: Valid for 180 days (Semester)
    const token = jwt.sign({ andrewId }, JWT_SECRET, { expiresIn: '180d' });
    res.json({ token });
});

// --- Authentication Middleware ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user; // { andrewId: 'keyuhe', ... }
        next();
    });
};

// --- Protected Upload Endpoint ---
app.post('/sign-upload', authenticateToken, async (req, res) => {
    try {
        const { key, contentType } = req.body;
        const andrewId = req.user.andrewId;

        if (!key) {
            return res.status(400).json({ error: 'Missing "key" in request body' });
        }

        // ENFORCED ISOLATION: Prefix key with andrewId
        // The extension might switch to sending relative paths like "chat_123/file.txt"
        // We will store it as: "studentA/chat_123/file.txt"
        const isolatedKey = `${andrewId}/${key}`;

        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: isolatedKey,
            ContentType: contentType || 'application/octet-stream'
        });

        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 }); // 5 minutes

        console.log(`Generated signed URL for: ${isolatedKey} (User: ${andrewId})`);
        res.json({ uploadUrl, key: isolatedKey }); // Return full key for debugging
    } catch (err) {
        console.error('Error generating signed URL:', err);
        res.status(500).json({ error: 'Failed to generate upload URL' });
    }
});

// Basic health check
app.get('/', (req, res) => {
    res.send('Copilot Archiver Backend (Auth Enabled) is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    if (!SHARED_PASSWORD || !JWT_SECRET) {
        console.error("❌ ERROR: SHARED_PASSWORD or JWT_SECRET is missing in .env!");
        console.error("   The server cannot secure logins without these. Exiting...");
        process.exit(1);
    }
    console.log(`Server running on port ${PORT}`);
    console.log(`Isolation Mode: Enabled (${process.env.S3_BUCKET_NAME})`);
});
