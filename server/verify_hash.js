const crypto = require('crypto');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.log("--- Copilot Archiver Hash Verifier ---");
console.log("This script regenerates the hash using the same logic as the extension.");
console.log("Logic: SHA256(AndrewID)\n");

rl.question('Enter Andrew ID: ', (andrewId) => {
    // Match extension.ts logic exactly (AndrewID only)
    const hashedId = crypto.createHash('sha256').update(andrewId).digest('hex');

    console.log(`\nOriginal: [${andrewId}]`);
    console.log(`Generated Hash: ${hashedId}`);

    rl.close();
});
