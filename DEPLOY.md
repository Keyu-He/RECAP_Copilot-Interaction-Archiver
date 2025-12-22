# Deploying Copilot Archiver Backend to AWS EC2

This guide walks you through setting up a free-tier EC2 instance to host your backend server.

## 0. Prerequisites: AWS Setup

### 1. Create an S3 Bucket
1.  Go to **S3** > **Create bucket**.
2.  **Bucket name**: `copilot-interaction-bucket-XXX` (Must be unique).
3.  **Region**: `us-east-1` (or your preferred region).
4.  **Block Public Access**: Keep **checked** (Blocked). Our server uses secure presigned URLs, so the bucket itself does NOT need to be public.
5.  Click **Create bucket**.
6.  *Enable CORS (Optional but Recommended)*:
    -   Go to **Permissions** > **Cross-origin resource sharing (CORS)** > **Edit**.
    -   Paste:
        ```json
        [
            {
                "AllowedHeaders": ["*"],
                "AllowedMethods": ["PUT", "POST", "GET"],
                "AllowedOrigins": ["*"],
                "ExposeHeaders": []
            }
        ]
        ```

### 2. Create IAM User (for the Server)
1.  Go to **IAM** > **Users** > **Create user**.
2.  **User name**: `archiver-backend-user`.
3.  **Permissions**:
    -   Select **Attach policies directly**.
    -   Search for `AmazonS3FullAccess` (Or create a custom policy restricted to your bucket).
    -   Select it and click **Next** > **Create user**.
4.  **Create Access Keys**:
    -   Click the new user > **Security credentials** tab.
    -   Scroll to **Access keys** > **Create access key**.
    -   Select **Command Line Interface (CLI)** > Check confirmation > **Next**.
    -   **Copy** the `Access Key ID` and `Secret Access Key`. (Save them safely, you won't see them again!).

---

## 1. Launch EC2 Instance
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
git clone git@github.com:Keyu-He/Copilot-Interaction-Archiver.git
type "yes" (if prompted)
cd Copilot-Interaction-Archiver/server
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
