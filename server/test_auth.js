// test_auth.js
// Run with: node test_auth.js

// Default credentials from .env.example
require('dotenv').config();

const pkg = require('../package.json');
const BASE_URL = pkg.contributes.configuration.properties['copilotArchiver.backendUrl'].default;
const ANDREW_ID = 'test_student';
const PASSWORD = process.env.SHARED_PASSWORD;

async function test() {
    console.log(`\nTesting Copilot Archiver Backend at ${BASE_URL}`);
    console.log(`User: ${ANDREW_ID}, Password: ${PASSWORD}\n`);

    // 1. LOGIN
    console.log('1. Attempting Login...');
    let token;
    try {
        const res = await fetch(`${BASE_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ andrewId: ANDREW_ID, password: PASSWORD })
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Login failed (${res.status}): ${err}`);
        }

        const data = await res.json();
        token = data.token;
        console.log('Login Successful!');
        console.log(`   Token: ${token}\n`);
    } catch (err) {
        console.error('Login Error:', err.message);
        return;
    }

    // 2. SIGN UPLOAD
    console.log('2. Attempting to Get Upload URL...');
    try {
        const res = await fetch(`${BASE_URL}/sign-upload`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ key: 'test_chat/auth_test.txt' })
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Sign request failed (${res.status}): ${err}`);
        }

        const data = await res.json();
        console.log('Sign Successful!');
        console.log(`Final Key: ${data.key}`); // Should be andrewId/test_chat/auth_test.txt
        console.log(`Upload URL: ${data.uploadUrl}\n`);
    } catch (err) {
        console.error('Sign Error:', err.message);
    }
}

test();
