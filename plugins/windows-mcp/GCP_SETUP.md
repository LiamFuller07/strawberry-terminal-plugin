# GCP Windows-MCP Setup Guide

This guide explains how to configure the Windows-MCP plugin to connect to Windows VMs in Google Cloud Platform.

## Architecture Overview

```
┌─────────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│  Strawberry CLI     │────▶│  Cloud Function      │────▶│  Secret Manager │
│  (bootstrap.mjs)    │     │  get-windows-creds   │     │  VM credentials │
└─────────────────────┘     └──────────────────────┘     └─────────────────┘
         │                            │
         │                            ▼
         │                  ┌──────────────────────┐
         │                  │  Compute Engine      │
         │                  │  VM Pool (Windows)   │
         │                  └──────────────────────┘
         │                            │
         ▼                            ▼
┌─────────────────────┐     ┌──────────────────────┐
│  tunnel-manager.js  │◀────│  IAP TCP Tunnel      │
│  (localhost:7788)   │     │  or SSH Tunnel       │
└─────────────────────┘     └──────────────────────┘
         │
         ▼
┌─────────────────────┐
│  Windows-MCP        │
│  (State/Click/Type) │
└─────────────────────┘
```

## Prerequisites

1. **Google Cloud Project** with billing enabled
2. **gcloud CLI** installed and authenticated
3. **Windows VM** with Windows-MCP running (uvx windows-mcp)
4. **IAP API** enabled (for IAP tunneling)

## Quick Start

### 1. Deploy the Cloud Function

```bash
cd plugins/windows-mcp/cloud-function

# Install dependencies
npm install

# Deploy to GCP
gcloud functions deploy get-windows-credentials \
  --gen2 \
  --runtime=nodejs20 \
  --region=us-central1 \
  --source=. \
  --entry-point=getWindowsCredentials \
  --trigger-http \
  --no-allow-unauthenticated \
  --set-env-vars="GCP_PROJECT_ID=your-project-id,GCP_ZONE=us-central1-a"
```

### 2. Store Credentials in Secret Manager

```bash
# Create a secret with VM credentials
echo '{
  "host": "10.128.0.2",
  "username": "strawberry",
  "password": "your-secure-password",
  "port": 3389,
  "mcp_port": 8080
}' | gcloud secrets create windows-mcp-credentials \
  --data-file=- \
  --project=your-project-id
```

### 3. Configure Environment Variables

Set these environment variables before running Strawberry:

```bash
# Required for GCP vault integration
export WINDOWS_MCP_VAULT_URL="https://us-central1-your-project.cloudfunctions.net/get-windows-credentials"
export GCP_PROJECT_ID="your-project-id"
export GCP_ZONE="us-central1-a"

# Optional
export TUNNEL_TYPE="iap"  # or "ssh", "direct", "auto"
export WINDOWS_MCP_VM_NAME="windows-vm-1"  # specific VM to use
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

### 4. Run Strawberry

The plugin will automatically:
1. Fetch credentials from the Cloud Function
2. Create an IAP tunnel to the Windows VM
3. Connect to Windows-MCP at localhost:7788

## Configuration Options

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WINDOWS_MCP_VAULT_URL` | Cloud Function URL for credentials | - |
| `GCP_PROJECT_ID` | Google Cloud project ID | - |
| `GCP_ZONE` | VM zone | us-central1-a |
| `TUNNEL_TYPE` | Tunnel type: auto/iap/ssh/direct | auto |
| `WINDOWS_MCP_VM_NAME` | Specific VM name to use | - |
| `WINDOWS_MCP_ENDPOINT` | Direct endpoint (bypasses vault) | - |
| `GOOGLE_APPLICATION_CREDENTIALS` | Service account key file | ADC |

### Tunnel Types

- **auto**: Automatically detect best tunnel (IAP if zone/vm_name, SSH if host)
- **iap**: Use IAP TCP tunneling (recommended for GCP VMs)
- **ssh**: Use SSH port forwarding
- **direct**: No tunnel, connect directly to host:port
- **cloudflare**: Use Cloudflare Tunnel

## Windows VM Setup

### 1. Create Windows VM

```bash
gcloud compute instances create windows-mcp-vm \
  --project=your-project-id \
  --zone=us-central1-a \
  --machine-type=n1-standard-2 \
  --image-family=windows-2022 \
  --image-project=windows-cloud \
  --boot-disk-size=50GB \
  --labels=purpose=windows-mcp \
  --metadata=enable-osconfig=TRUE
```

### 2. Install Windows-MCP on VM

RDP into the VM and run:

```powershell
# Install Python and uv
winget install Python.Python.3.12
pip install uv

# Run Windows-MCP
uvx windows-mcp --port 8080
```

### 3. Configure Firewall Rules

For IAP tunneling, no external firewall rules needed. For direct access:

```bash
gcloud compute firewall-rules create allow-windows-mcp \
  --project=your-project-id \
  --direction=INGRESS \
  --priority=1000 \
  --network=default \
  --action=ALLOW \
  --rules=tcp:8080 \
  --source-ranges=35.235.240.0/20 \
  --target-tags=windows-mcp
```

## VM Pool Management

The Cloud Function supports a VM pool for multi-user scenarios:

1. **Label VMs**: Add `purpose=windows-mcp` label to pool VMs
2. **Automatic Assignment**: Function assigns available VMs to sessions
3. **Session Tracking**: VMs are marked in-use via metadata
4. **Auto Release**: Sessions expire after 2 hours

### Scaling the Pool

```bash
# Create multiple VMs
for i in {1..3}; do
  gcloud compute instances create windows-mcp-vm-$i \
    --project=your-project-id \
    --zone=us-central1-a \
    --machine-type=n1-standard-2 \
    --image-family=windows-2022 \
    --image-project=windows-cloud \
    --labels=purpose=windows-mcp
done
```

## Troubleshooting

### "Failed to obtain Google Cloud access token"

1. Run `gcloud auth login` to authenticate
2. Or set `GOOGLE_APPLICATION_CREDENTIALS` to a service account key

### "IAP tunnel timeout"

1. Ensure IAP API is enabled: `gcloud services enable iap.googleapis.com`
2. Check IAP permissions: `roles/iap.tunnelResourceAccessor`
3. Verify VM is running: `gcloud compute instances list`

### "VM pool exhausted"

1. Add more VMs to the pool
2. Check for stuck sessions in VM metadata
3. Manually release VMs via the Cloud Function

### Checking Tunnel Status

```bash
node bin/tunnel-manager.js status
```

### Manual Vault Sync

```bash
WINDOWS_MCP_VAULT_URL="https://..." node bin/vault-sync.js
```

## Security Best Practices

1. **Use IAP tunneling** instead of exposing VMs publicly
2. **Rotate credentials** regularly via Secret Manager
3. **Use service accounts** instead of user credentials
4. **Enable audit logging** for Cloud Functions
5. **Restrict IAP access** to specific users/groups

## File Structure

```
plugins/windows-mcp/
├── .mcp.json                    # MCP server configuration
├── GCP_SETUP.md                 # This guide
├── bin/
│   ├── vault-sync.js            # GCP credential fetcher
│   ├── tunnel-manager.js        # IAP/SSH tunnel manager
│   └── start-windows-mcp.js     # RDP launcher helper
├── cloud-function/
│   ├── index.js                 # Cloud Function code
│   └── package.json             # Function dependencies
├── servers/windows-mcp/
│   └── bootstrap.mjs            # Main bootstrap orchestrator
└── windows-mcp/                 # Bundled Windows-MCP Python package
```
