# Deploying Copilot Archiver Backend to AWS EC2

This guide walks through setting up an EC2 instance to host the backend server.

## Prerequisites: AWS Setup

## 1. Create an S3 Bucket
1.  Go to **S3** > **Create bucket**.
2.  **Bucket name**: `copilot-interaction-bucket`.
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

## 2. Get Access Keys
**If you are on a personal account (Root/Admin):**
1.  Go to **IAM** > **Users** > **Create user** (`archiver-backend-user`).
2.  Attach policy `AmazonS3FullAccess`.
3.  Create Access Keys for this user.

**If you are on a Student/Restricted Account (Error: "Access denied"):**
1.  You likely cannot create new users. Use your **current** user.
2.  Click your username in the top-right corner > **Security credentials**.
3.  Scroll down to **Access keys**.
4.  Click **Create access key**.
    *   *Note: If this is also blocked, check your logical "Lab" dashboard (e.g., AWS Academy, Vocareum) for the `AWS Details` button to get your pre-generated keys.*


## 3. Launch EC2 Instance
1.  **Name**: `Copilot-Archiver-Server`.
2.  **OS**: Amazon Linux 2023 AMI (Free tier eligible).
3.  **Instance Type**: `t3.micro` or `t3.small` (Free tier eligible).
4.  **Key Pair**: Create new > Download the `.pem` file (e.g., `archiver-key.pem`).
5.  **Network Settings**:
    -   Check "Allow SSH traffic from Anywhere" (or My IP).
    -   Check "Allow HTTP traffic from the internet".
    -   Check "Allow HTTPS traffic from the internet".
7.  **Launch Instance**.

## 4. Configure Security Group
1.  Go to **Instances** > Click your instance > **Security** tab > Click the **Security Group**.
2.  **Edit inbound rules** > Add Rule:
    -   Type: Custom TCP
    -   Port range: `3000`
    -   Source: `0.0.0.0/0` (Anywhere)
3.  Save rules.

## 5. Connect to Instance
Open your terminal on your local machine:
```bash
chmod 400 archiver-key.pem
ssh -i "archiver-key.pem" ec2-user@<YOUR-EC2-PUBLIC-IP>
```

## 6. Install Environment
Run these commands on the EC2 instance:
```bash
# Update system
sudo dnf update -y

# Install Node.js 18
sudo dnf install nodejs -y

# Install Git
sudo dnf install git -y
```

## 7. Deploy Code
Git clone the repository:
```bash
git clone git@github.com:<user_name>/Copilot-Interaction-Archiver.git
type "yes" (if prompted)
cd Copilot-Interaction-Archiver/server
```


## 8. Configure & Run
On the EC2 instance:
```bash
cd server
npm install

# Create .env file with your real keys
nano .env
# Paste:
"""
AWS_ACCESS_KEY_ID=<YOUR-ACCESS-KEY-ID>
AWS_SECRET_ACCESS_KEY=<YOUR-SECRET-ACCESS-KEY>
AWS_REGION=us-east-1
S3_BUCKET_NAME=<YOUR-S3-BUCKET-NAME>
PORT=3000
SHARED_PASSWORD=<YOUR-SHARED-PASSWORD>
JWT_SECRET=<YOUR-JWT-SECRET>
"""
# (Press Ctrl+O, Enter, Ctrl+X to save)

# Start Server
node index.js
```

## 9. Keep it Running (PM2)
To keep the server running after disconnecting, use PM2:
```bash
sudo npm install -g pm2
pm2 start index.js --name "archiver-backend"
pm2 save
pm2 startup
```

## 10. Final Step
The backend URL is: `http://<YOUR-EC2-PUBLIC-IP>:3000`
Update the backend URL in package.json to make it default to point to the EC2 instance:
```json
"copilotArchiver.backendUrl": "http://<YOUR-EC2-PUBLIC-IP>:3000"
```
