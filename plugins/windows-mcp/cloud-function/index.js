/**
 * GCP Cloud Function: get-windows-credentials
 *
 * Returns Windows VM credentials from Secret Manager or Compute Engine metadata.
 * Deploy with: gcloud functions deploy get-windows-credentials --runtime nodejs20 --trigger-http --allow-unauthenticated=false
 *
 * Expected request body:
 * {
 *   "session_id": "strawberry-123456",
 *   "vm_id": "optional-specific-vm"
 * }
 *
 * Response:
 * {
 *   "host": "34.xx.xx.xx",
 *   "username": "strawberry",
 *   "password": "...",
 *   "port": 3389,
 *   "mcp_port": 8080,
 *   "vm_name": "windows-vm-1"
 * }
 */

const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const compute = require('@google-cloud/compute');

const secretClient = new SecretManagerServiceClient();
const instancesClient = new compute.InstancesClient();

// Configuration
const PROJECT_ID = process.env.GCP_PROJECT_ID || process.env.GCLOUD_PROJECT;
const ZONE = process.env.GCP_ZONE || 'us-central1-a';
const SECRET_NAME = process.env.WINDOWS_SECRET_NAME || 'windows-mcp-credentials';
const VM_LABEL_SELECTOR = process.env.VM_LABEL_SELECTOR || 'purpose=windows-mcp';

/**
 * Main Cloud Function handler
 */
exports.getWindowsCredentials = async (req, res) => {
  // CORS headers
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { session_id, vm_id } = req.body || {};

    console.log(`[get-windows-credentials] Request from session: ${session_id}`);

    // Strategy 1: Check if specific VM requested
    if (vm_id) {
      const credentials = await getVMCredentials(vm_id);
      if (credentials) {
        console.log(`[get-windows-credentials] Returning credentials for VM: ${vm_id}`);
        return res.status(200).json(credentials);
      }
    }

    // Strategy 2: Find available VM from pool
    const availableVM = await findAvailableVM();
    if (availableVM) {
      console.log(`[get-windows-credentials] Found available VM: ${availableVM.name}`);
      const credentials = await getVMCredentials(availableVM.name);

      // Mark VM as in-use
      await markVMInUse(availableVM.name, session_id);

      return res.status(200).json(credentials);
    }

    // Strategy 3: Fall back to Secret Manager static credentials
    const secretCredentials = await getSecretCredentials();
    if (secretCredentials) {
      console.log('[get-windows-credentials] Using Secret Manager credentials');
      return res.status(200).json(secretCredentials);
    }

    // No credentials available
    return res.status(503).json({
      error: 'No available Windows VMs',
      message: 'VM pool exhausted - no available VMs'
    });

  } catch (error) {
    console.error('[get-windows-credentials] Error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * Get credentials for a specific VM
 */
async function getVMCredentials(vmName) {
  try {
    const [instance] = await instancesClient.get({
      project: PROJECT_ID,
      zone: ZONE,
      instance: vmName,
    });

    if (!instance || instance.status !== 'RUNNING') {
      return null;
    }

    // Get external IP
    const networkInterface = instance.networkInterfaces?.[0];
    const accessConfig = networkInterface?.accessConfigs?.[0];
    const externalIP = accessConfig?.natIP;

    if (!externalIP) {
      console.warn(`[get-windows-credentials] VM ${vmName} has no external IP`);
      return null;
    }

    // Get credentials from instance metadata or Secret Manager
    const metadata = parseMetadata(instance.metadata?.items || []);
    const password = metadata['windows-password'] || await getPasswordFromSecret(vmName);

    return {
      host: externalIP,
      username: metadata['windows-username'] || 'strawberry',
      password: password,
      port: parseInt(metadata['rdp-port'] || '3389'),
      mcp_port: parseInt(metadata['mcp-port'] || '8080'),
      vm_name: vmName,
      zone: ZONE,
    };

  } catch (error) {
    console.error(`[get-windows-credentials] Error getting VM ${vmName}:`, error.message);
    return null;
  }
}

/**
 * Find an available VM from the pool
 */
async function findAvailableVM() {
  try {
    const [instances] = await instancesClient.list({
      project: PROJECT_ID,
      zone: ZONE,
      filter: `labels.${VM_LABEL_SELECTOR.replace('=', ':')} AND status=RUNNING`,
    });

    // Find VM not currently in use
    for (const instance of instances || []) {
      const metadata = parseMetadata(instance.metadata?.items || []);

      // Check if VM is available (not in-use or session expired)
      if (!metadata['in-use'] || isSessionExpired(metadata['in-use-since'])) {
        return instance;
      }
    }

    return null;
  } catch (error) {
    console.error('[get-windows-credentials] Error listing VMs:', error.message);
    return null;
  }
}

/**
 * Mark VM as in-use
 */
async function markVMInUse(vmName, sessionId) {
  try {
    const [instance] = await instancesClient.get({
      project: PROJECT_ID,
      zone: ZONE,
      instance: vmName,
    });

    const existingMetadata = instance.metadata?.items || [];
    const fingerprint = instance.metadata?.fingerprint;

    // Update metadata
    const newItems = existingMetadata.filter(
      item => !['in-use', 'in-use-since', 'session-id'].includes(item.key)
    );

    newItems.push(
      { key: 'in-use', value: 'true' },
      { key: 'in-use-since', value: new Date().toISOString() },
      { key: 'session-id', value: sessionId }
    );

    await instancesClient.setMetadata({
      project: PROJECT_ID,
      zone: ZONE,
      instance: vmName,
      metadataResource: {
        fingerprint,
        items: newItems,
      },
    });

    console.log(`[get-windows-credentials] Marked VM ${vmName} as in-use by session ${sessionId}`);
  } catch (error) {
    console.warn(`[get-windows-credentials] Failed to mark VM in-use:`, error.message);
  }
}

/**
 * Get credentials from Secret Manager
 */
async function getSecretCredentials() {
  try {
    const secretPath = `projects/${PROJECT_ID}/secrets/${SECRET_NAME}/versions/latest`;
    const [version] = await secretClient.accessSecretVersion({ name: secretPath });

    const payload = version.payload?.data?.toString('utf8');
    if (!payload) return null;

    return JSON.parse(payload);
  } catch (error) {
    console.warn('[get-windows-credentials] Secret Manager fallback failed:', error.message);
    return null;
  }
}

/**
 * Get password from per-VM secret
 */
async function getPasswordFromSecret(vmName) {
  try {
    const secretPath = `projects/${PROJECT_ID}/secrets/${vmName}-password/versions/latest`;
    const [version] = await secretClient.accessSecretVersion({ name: secretPath });
    return version.payload?.data?.toString('utf8');
  } catch (error) {
    console.warn(`[get-windows-credentials] No password secret for ${vmName}`);
    return null;
  }
}

/**
 * Parse GCP instance metadata to key-value object
 */
function parseMetadata(items) {
  const result = {};
  for (const item of items) {
    result[item.key] = item.value;
  }
  return result;
}

/**
 * Check if session has expired (default: 2 hours)
 */
function isSessionExpired(sinceISO) {
  if (!sinceISO) return true;

  const since = new Date(sinceISO);
  const now = new Date();
  const twoHours = 2 * 60 * 60 * 1000;

  return (now - since) > twoHours;
}

/**
 * Release VM (call when session ends)
 */
exports.releaseVM = async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  try {
    const { vm_name, session_id } = req.body || {};

    if (!vm_name) {
      return res.status(400).json({ error: 'vm_name required' });
    }

    const [instance] = await instancesClient.get({
      project: PROJECT_ID,
      zone: ZONE,
      instance: vm_name,
    });

    const existingMetadata = instance.metadata?.items || [];
    const fingerprint = instance.metadata?.fingerprint;

    // Clear in-use metadata
    const newItems = existingMetadata.filter(
      item => !['in-use', 'in-use-since', 'session-id'].includes(item.key)
    );

    await instancesClient.setMetadata({
      project: PROJECT_ID,
      zone: ZONE,
      instance: vm_name,
      metadataResource: {
        fingerprint,
        items: newItems,
      },
    });

    console.log(`[release-vm] Released VM ${vm_name} from session ${session_id}`);
    return res.status(200).json({ success: true, vm_name });

  } catch (error) {
    console.error('[release-vm] Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
