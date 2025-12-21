# Deploying Copilot Archiver Backend to AWS EC2

This guide walks you through setting up a free-tier EC2 instance to host your backend server.

## 1. Launch EC2 Instance
1.  Log in to AWS Console > **EC2** > **Launch Instance**.
2.  **Name**: `Copilot-Archiver-Server`.
3.  **OS**: Amazon Linux 2023 AMI (Free tier eligible).
4.  **Instance Type**: `t2.micro` or `t3.micro` (Free tier eligible).
5.  **Key Pair**: Create new > Download the `.pem` file (e.g., `archiver-key.pem`).
6.  **Network Settings**:
    -   Check "Allow SSH traffic from Anywhere" (or My IP).
    -   Check "Allow HTTP traffic from the internet".
    -   Check "Allow HTTPS traffic from the internet".
7.  **Launch Instance**.

## 2. Configure Security Group
1.  Go to **Instances** > Click your instance > **Security** tab > Click the **Security Group**.
2.  **Edit inbound rules** > Add Rule:
    -   Type: Custom TCP
    -   Port range: `3000`
    -   Source: `0.0.0.0/0` (Anywhere)
3.  Save rules.

## 3. Connect to Instance
Open your terminal on your local machine:
```bash
chmod 400 archiver-key.pem
ssh -i "archiver-key.pem" ec2-user@<YOUR-EC2-PUBLIC-IP>
```

## 4. Install Environment
Run these commands on the EC2 instance:
```bash
# Update system
sudo dnf update -y

# Install Node.js 18
sudo dnf install nodejs -y

# Install Git
sudo dnf install git -y
```

## 5. Deploy Code
You can either clone your repo or copy the files.
**Option A (Git Clone):**
```bash
git clone https://github.com/keyuhe/copilot-archiver.git
type "yes" (if prompted)
cd copilot-archiver/server
```

**Option B (SCP - simpler for testing):**
On your *local machine*:
```bash
scp -i "archiver-key.pem" -r ./server ec2-user@<EC2-IP>:~/server
```

## 6. Configure & Run
On the EC2 instance:
```bash
cd server
npm install

# Create .env file with your real keys
nano .env
# Paste:
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...
# AWS_REGION=us-east-1
# S3_BUCKET_NAME=copilot-interaction-bucket
# PORT=3000
# (Press Ctrl+O, Enter, Ctrl+X to save)

# Start Server
node index.js
```

## 7. Keep it Running (PM2)
To keep the server running after you disconnect:
```bash
sudo npm install -g pm2
pm2 start index.js --name "archiver-backend"
pm2 save
pm2 startup
```

## 8. Final Step
Your backend URL is: `http://<YOUR-EC2-PUBLIC-IP>:3000`
Update your VS Code Config:
```json
"copilotArchiver.backendUrl": "http://<YOUR-EC2-PUBLIC-IP>:3000"
```
