#!/usr/bin/env node
/**
 * vault-sync.js - GCP Vault Integration for Windows-MCP
 *
 * Fetches Windows VM credentials from GCP Secret Manager or Cloud Function
 * and sets environment variables for the bootstrap process.
 *
 * Authentication priority:
 * 1. GOOGLE_APPLICATION_CREDENTIALS (service account JSON)
 * 2. Application Default Credentials (ADC)
 * 3. gcloud CLI fallback
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

// Configuration
const CACHE_FILE = path.join(process.env.HOME || '/tmp', '.strawberry', 'vault-cache.json');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Get Google Cloud access token using multiple fallback methods
 */
async function getGoogleAccessToken() {
  // Method 1: Try ADC via metadata server (for GCP environments)
  try {
    const metadataToken = await fetchMetadataToken();
    if (metadataToken) {
      console.info('[vault-sync] Using GCP metadata service token');
      return metadataToken;
    }
  } catch (e) {
    // Not running on GCP, continue to next method
  }

  // Method 2: Try gcloud CLI
  try {
    const gcloudToken = await getGcloudToken();
    if (gcloudToken) {
      console.info('[vault-sync] Using gcloud CLI token');
      return gcloudToken;
    }
  } catch (e) {
    console.warn('[vault-sync] gcloud auth failed:', e.message);
  }

  // Method 3: Try service account file
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      const saToken = await getServiceAccountToken();
      if (saToken) {
        console.info('[vault-sync] Using service account token');
        return saToken;
      }
    } catch (e) {
      console.warn('[vault-sync] Service account auth failed:', e.message);
    }
  }

  throw new Error('Failed to obtain Google Cloud access token. Run: gcloud auth login');
}

/**
 * Fetch token from GCP metadata server (works on GCE, Cloud Run, etc.)
 */
function fetchMetadataToken() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'metadata.google.internal',
      path: '/computeMetadata/v1/instance/service-accounts/default/token',
      headers: { 'Metadata-Flavor': 'Google' },
      timeout: 2000,
    };

    const req = http.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.access_token);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Metadata server timeout'));
    });
  });
}

/**
 * Get token using gcloud CLI
 */
function getGcloudToken() {
  return new Promise((resolve, reject) => {
    const proc = spawn('gcloud', ['auth', 'print-access-token'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => stdout += data);
    proc.stderr.on('data', (data) => stderr += data);

    proc.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || 'gcloud auth failed'));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`gcloud not found: ${err.message}`));
    });
  });
}

/**
 * Get token using service account JSON file
 */
async function getServiceAccountToken() {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyFile || !fs.existsSync(keyFile)) {
    throw new Error('Service account key file not found');
  }

  const key = JSON.parse(fs.readFileSync(keyFile, 'utf-8'));
  const jwt = createJWT(key);

  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString();

    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            resolve(json.access_token);
          } else {
            reject(new Error(json.error_description || 'Token exchange failed'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Create JWT for service account authentication
 */
async function createJWT(key) {
  const crypto = await import('crypto');

  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(payload)}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(key.private_key, 'base64url');

  return `${unsigned}.${signature}`;
}

/**
 * Fetch credentials from Cloud Function or Secret Manager
 */
async function fetchVaultCredentials(vaultUrl, token, options = {}) {
  const { vmId, sessionId } = options;

  return new Promise((resolve, reject) => {
    const url = new URL(vaultUrl);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const body = JSON.stringify({
      session_id: sessionId || `strawberry-${Date.now()}`,
      vm_id: vmId,
    });

    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = httpModule.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Invalid JSON response from vault'));
          }
        } else if (res.statusCode === 503) {
          reject(new Error('VM pool exhausted - no available VMs'));
        } else {
          reject(new Error(`Vault returned ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Load credentials from local cache
 */
function loadCachedCredentials() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;

    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    const age = Date.now() - cache.timestamp;

    if (age < CACHE_TTL_MS) {
      console.info('[vault-sync] Using cached credentials (age: ' + Math.round(age / 1000) + 's)');
      return cache.credentials;
    }

    console.info('[vault-sync] Cache expired, fetching fresh credentials');
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Save credentials to local cache
 */
function saveCachedCredentials(credentials) {
  try {
    const cacheDir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      timestamp: Date.now(),
      credentials,
    }), 'utf-8');
  } catch (e) {
    console.warn('[vault-sync] Failed to cache credentials:', e.message);
  }
}

/**
 * Set environment variables from credentials
 */
function setEnvironmentVariables(creds) {
  if (creds.host && creds.mcp_port) {
    process.env.WINDOWS_MCP_ENDPOINT = `http://${creds.host}:${creds.mcp_port}`;
    console.info('[vault-sync] Set WINDOWS_MCP_ENDPOINT =', process.env.WINDOWS_MCP_ENDPOINT);
  }

  if (creds.password) {
    process.env.WINDOWS_MCP_PASSWORD = creds.password;
    console.info('[vault-sync] Set WINDOWS_MCP_PASSWORD = [REDACTED]');
  }

  if (creds.port || creds.rdp_port) {
    process.env.WINDOWS_MCP_PORT = String(creds.port || creds.rdp_port);
    console.info('[vault-sync] Set WINDOWS_MCP_PORT =', process.env.WINDOWS_MCP_PORT);
  }

  if (creds.username) {
    process.env.WINDOWS_MCP_USERNAME = creds.username;
    console.info('[vault-sync] Set WINDOWS_MCP_USERNAME =', creds.username);
  }

  if (creds.host) {
    process.env.WINDOWS_MCP_HOST = creds.host;
    console.info('[vault-sync] Set WINDOWS_MCP_HOST =', creds.host);
  }

  return {
    endpoint: process.env.WINDOWS_MCP_ENDPOINT,
    host: creds.host,
    username: creds.username,
    rdpPort: creds.port || creds.rdp_port || 3389,
    mcpPort: creds.mcp_port || 8080,
  };
}

/**
 * Retry wrapper with exponential backoff
 */
async function withRetry(fn, maxRetries = MAX_RETRIES) {
  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      console.warn(`[vault-sync] Attempt ${i + 1}/${maxRetries} failed:`, e.message);

      if (i < maxRetries - 1) {
        const delay = RETRY_DELAY_MS * Math.pow(2, i);
        console.info(`[vault-sync] Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}

/**
 * Main sync function
 */
export async function syncVaultCredentials(options = {}) {
  const vaultUrl = process.env.WINDOWS_MCP_VAULT_URL;

  if (!vaultUrl) {
    console.info('[vault-sync] No WINDOWS_MCP_VAULT_URL configured, skipping vault sync');
    return null;
  }

  console.info('[vault-sync] Fetching credentials from vault:', vaultUrl);

  // Check cache first (unless force refresh)
  if (!options.forceRefresh) {
    const cached = loadCachedCredentials();
    if (cached) {
      return setEnvironmentVariables(cached);
    }
  }

  // Get GCP access token
  const token = await withRetry(() => getGoogleAccessToken());

  // Fetch credentials from vault
  const credentials = await withRetry(() =>
    fetchVaultCredentials(vaultUrl, token, options)
  );

  // Cache for future use
  saveCachedCredentials(credentials);

  // Set environment variables
  return setEnvironmentVariables(credentials);
}

/**
 * CLI entry point
 */
async function main() {
  try {
    const result = await syncVaultCredentials({
      vmId: process.env.WINDOWS_MCP_VM_ID,
      forceRefresh: process.argv.includes('--force'),
    });

    if (result) {
      console.info('[vault-sync] Successfully synced credentials');
      console.info('[vault-sync] Endpoint:', result.endpoint);
      console.info('[vault-sync] Host:', result.host);
      console.info('[vault-sync] RDP Port:', result.rdpPort);
      console.info('[vault-sync] MCP Port:', result.mcpPort);
    } else {
      console.info('[vault-sync] No vault configured, using manual endpoint');
    }

    process.exit(0);
  } catch (error) {
    console.error('[vault-sync] Failed to sync credentials:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (process.argv[1] === import.meta.url.slice(7) || process.argv[1].endsWith('vault-sync.js')) {
  main();
}

export { getGoogleAccessToken, fetchVaultCredentials, setEnvironmentVariables };
