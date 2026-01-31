#!/usr/bin/env node
/**
 * tunnel-manager.js - IAP/SSH Tunnel Management for Windows-MCP
 *
 * Creates and manages tunnels to Windows VMs in GCP:
 * - IAP TCP tunneling (gcloud compute start-iap-tunnel)
 * - SSH port forwarding (ssh -L)
 * - Cloudflare Tunnel (cloudflared)
 *
 * The tunnel maps a remote Windows MCP port to localhost,
 * allowing the plugin to connect via http://localhost:LOCAL_PORT
 */

import { spawn } from 'child_process';
import net from 'net';
import fs from 'fs';
import path from 'path';

// Configuration
const DEFAULT_LOCAL_PORT = 7788;
const TUNNEL_HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
const STATE_FILE = path.join(process.env.HOME || '/tmp', '.strawberry', 'tunnel-state.json');

let activeTunnel = null;
let healthCheckInterval = null;

/**
 * Find an available local port
 */
async function findAvailablePort(startPort = DEFAULT_LOCAL_PORT) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.listen(startPort, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(findAvailablePort(startPort + 1));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Start IAP tunnel using gcloud
 */
async function startIAPTunnel(options) {
  const {
    vmName,
    zone,
    project,
    remotePort = 8080,
    localPort = DEFAULT_LOCAL_PORT,
  } = options;

  const actualLocalPort = await findAvailablePort(localPort);

  console.info(`[tunnel-manager] Starting IAP tunnel: localhost:${actualLocalPort} -> ${vmName}:${remotePort}`);

  const args = [
    'compute', 'start-iap-tunnel',
    vmName,
    String(remotePort),
    '--local-host-port', `localhost:${actualLocalPort}`,
    '--zone', zone,
  ];

  if (project) {
    args.push('--project', project);
  }

  const proc = spawn('gcloud', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  let ready = false;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!ready) {
        proc.kill();
        reject(new Error('IAP tunnel timeout - failed to establish connection'));
      }
    }, 60000); // 60 second timeout

    proc.stdout.on('data', (data) => {
      const output = data.toString();
      console.info('[tunnel-manager] IAP:', output.trim());

      // IAP tunnel outputs "Listening on port [PORT]" when ready
      if (output.includes('Listening on port') || output.includes('tunnel is running')) {
        ready = true;
        clearTimeout(timeout);

        activeTunnel = {
          type: 'iap',
          process: proc,
          localPort: actualLocalPort,
          remotePort,
          vmName,
          zone,
          startedAt: new Date().toISOString(),
        };

        saveTunnelState();
        startHealthCheck();

        resolve({
          localPort: actualLocalPort,
          endpoint: `http://localhost:${actualLocalPort}`,
          type: 'iap',
        });
      }
    });

    proc.stderr.on('data', (data) => {
      const output = data.toString();
      console.warn('[tunnel-manager] IAP stderr:', output.trim());

      // Some IAP messages come through stderr
      if (output.includes('Listening') || output.includes('tunnel')) {
        ready = true;
        clearTimeout(timeout);

        activeTunnel = {
          type: 'iap',
          process: proc,
          localPort: actualLocalPort,
          remotePort,
          vmName,
          zone,
          startedAt: new Date().toISOString(),
        };

        saveTunnelState();
        startHealthCheck();

        resolve({
          localPort: actualLocalPort,
          endpoint: `http://localhost:${actualLocalPort}`,
          type: 'iap',
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start gcloud: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (!ready) {
        clearTimeout(timeout);
        reject(new Error(`IAP tunnel exited with code ${code}`));
      } else {
        console.warn('[tunnel-manager] IAP tunnel closed');
        activeTunnel = null;
        stopHealthCheck();
      }
    });
  });
}

/**
 * Start SSH tunnel
 */
async function startSSHTunnel(options) {
  const {
    host,
    username = 'strawberry',
    remotePort = 8080,
    localPort = DEFAULT_LOCAL_PORT,
    sshPort = 22,
    identityFile,
  } = options;

  const actualLocalPort = await findAvailablePort(localPort);

  console.info(`[tunnel-manager] Starting SSH tunnel: localhost:${actualLocalPort} -> ${host}:${remotePort}`);

  const args = [
    '-N', // No remote command
    '-L', `${actualLocalPort}:localhost:${remotePort}`,
    '-p', String(sshPort),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
  ];

  if (identityFile) {
    args.push('-i', identityFile);
  }

  args.push(`${username}@${host}`);

  const proc = spawn('ssh', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  return new Promise((resolve, reject) => {
    // SSH doesn't output much on success, so we wait a bit and check
    const checkTimeout = setTimeout(async () => {
      // Try to connect to the local port
      const isReady = await checkPortOpen(actualLocalPort);

      if (isReady) {
        activeTunnel = {
          type: 'ssh',
          process: proc,
          localPort: actualLocalPort,
          remotePort,
          host,
          startedAt: new Date().toISOString(),
        };

        saveTunnelState();
        startHealthCheck();

        resolve({
          localPort: actualLocalPort,
          endpoint: `http://localhost:${actualLocalPort}`,
          type: 'ssh',
        });
      } else {
        proc.kill();
        reject(new Error('SSH tunnel failed to establish'));
      }
    }, 3000);

    proc.stderr.on('data', (data) => {
      const output = data.toString();
      console.warn('[tunnel-manager] SSH stderr:', output.trim());

      if (output.includes('Permission denied') || output.includes('Connection refused')) {
        clearTimeout(checkTimeout);
        proc.kill();
        reject(new Error(`SSH error: ${output.trim()}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(checkTimeout);
      reject(new Error(`Failed to start ssh: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (activeTunnel?.process === proc) {
        console.warn('[tunnel-manager] SSH tunnel closed');
        activeTunnel = null;
        stopHealthCheck();
      }
    });
  });
}

/**
 * Start Cloudflare tunnel
 */
async function startCloudflareTunnel(options) {
  const {
    tunnelName,
    hostname,
    localPort = DEFAULT_LOCAL_PORT,
  } = options;

  const actualLocalPort = await findAvailablePort(localPort);

  console.info(`[tunnel-manager] Starting Cloudflare tunnel: ${hostname} -> localhost:${actualLocalPort}`);

  const args = [
    'tunnel', 'run',
    '--url', `http://localhost:${actualLocalPort}`,
    tunnelName,
  ];

  const proc = spawn('cloudflared', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    let ready = false;

    const timeout = setTimeout(() => {
      if (!ready) {
        proc.kill();
        reject(new Error('Cloudflare tunnel timeout'));
      }
    }, 30000);

    proc.stdout.on('data', (data) => {
      const output = data.toString();
      console.info('[tunnel-manager] Cloudflare:', output.trim());

      if (output.includes('Registered tunnel') || output.includes('Connection registered')) {
        ready = true;
        clearTimeout(timeout);

        activeTunnel = {
          type: 'cloudflare',
          process: proc,
          localPort: actualLocalPort,
          hostname,
          tunnelName,
          startedAt: new Date().toISOString(),
        };

        saveTunnelState();

        resolve({
          localPort: actualLocalPort,
          endpoint: `https://${hostname}`,
          type: 'cloudflare',
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start cloudflared: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (!ready) {
        clearTimeout(timeout);
        reject(new Error(`Cloudflare tunnel exited with code ${code}`));
      }
    });
  });
}

/**
 * Check if a port is open
 */
function checkPortOpen(port, host = '127.0.0.1', timeout = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();

    socket.setTimeout(timeout);

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

/**
 * Start periodic health check
 */
function startHealthCheck() {
  stopHealthCheck();

  healthCheckInterval = setInterval(async () => {
    if (!activeTunnel) {
      stopHealthCheck();
      return;
    }

    const isOpen = await checkPortOpen(activeTunnel.localPort);
    if (!isOpen) {
      console.warn('[tunnel-manager] Health check failed - tunnel may be down');
      // Could add auto-reconnect logic here
    }
  }, TUNNEL_HEALTH_CHECK_INTERVAL);
}

/**
 * Stop health check
 */
function stopHealthCheck() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

/**
 * Save tunnel state to file
 */
function saveTunnelState() {
  if (!activeTunnel) return;

  try {
    const stateDir = path.dirname(STATE_FILE);
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }

    const state = {
      type: activeTunnel.type,
      localPort: activeTunnel.localPort,
      remotePort: activeTunnel.remotePort,
      endpoint: `http://localhost:${activeTunnel.localPort}`,
      startedAt: activeTunnel.startedAt,
      vmName: activeTunnel.vmName,
      host: activeTunnel.host,
    };

    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('[tunnel-manager] Failed to save state:', e.message);
  }
}

/**
 * Load tunnel state from file
 */
function loadTunnelState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch (e) {
    return null;
  }
}

/**
 * Stop active tunnel
 */
function stopTunnel() {
  if (activeTunnel?.process) {
    console.info('[tunnel-manager] Stopping tunnel');
    activeTunnel.process.kill();
    activeTunnel = null;
  }

  stopHealthCheck();

  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
  } catch (e) {
    // Ignore
  }
}

/**
 * Get current tunnel status
 */
function getTunnelStatus() {
  if (!activeTunnel) {
    const savedState = loadTunnelState();
    return {
      active: false,
      savedState,
    };
  }

  return {
    active: true,
    type: activeTunnel.type,
    localPort: activeTunnel.localPort,
    endpoint: `http://localhost:${activeTunnel.localPort}`,
    startedAt: activeTunnel.startedAt,
  };
}

/**
 * Create tunnel based on credentials
 */
async function createTunnel(credentials) {
  const {
    host,
    vm_name,
    zone,
    mcp_port = 8080,
    tunnel_type = 'auto',
    username,
    project,
  } = credentials;

  // Auto-detect tunnel type
  let tunnelType = tunnel_type;
  if (tunnelType === 'auto') {
    // If we have zone and vm_name, use IAP
    if (zone && vm_name) {
      tunnelType = 'iap';
    } else if (host) {
      tunnelType = 'ssh';
    } else {
      throw new Error('Cannot determine tunnel type - need zone+vm_name or host');
    }
  }

  console.info(`[tunnel-manager] Creating ${tunnelType} tunnel to ${vm_name || host}`);

  switch (tunnelType) {
    case 'iap':
      return startIAPTunnel({
        vmName: vm_name,
        zone,
        project,
        remotePort: mcp_port,
      });

    case 'ssh':
      return startSSHTunnel({
        host,
        username,
        remotePort: mcp_port,
      });

    case 'cloudflare':
      return startCloudflareTunnel({
        tunnelName: credentials.tunnel_name,
        hostname: credentials.tunnel_hostname,
      });

    case 'direct':
      // No tunnel needed - direct connection
      return {
        localPort: null,
        endpoint: `http://${host}:${mcp_port}`,
        type: 'direct',
      };

    default:
      throw new Error(`Unknown tunnel type: ${tunnelType}`);
  }
}

/**
 * CLI entry point
 */
async function main() {
  const command = process.argv[2];

  switch (command) {
    case 'start':
      // Start tunnel with env var credentials
      const credentials = {
        vm_name: process.env.WINDOWS_MCP_VM_NAME,
        zone: process.env.GCP_ZONE || 'us-central1-a',
        project: process.env.GCP_PROJECT_ID,
        host: process.env.WINDOWS_MCP_HOST,
        mcp_port: parseInt(process.env.WINDOWS_MCP_PORT || '8080'),
        tunnel_type: process.env.TUNNEL_TYPE || 'auto',
      };

      try {
        const result = await createTunnel(credentials);
        console.info('[tunnel-manager] Tunnel ready:', result.endpoint);
        process.env.WINDOWS_MCP_ENDPOINT = result.endpoint;

        // Keep process alive
        process.stdin.resume();
      } catch (error) {
        console.error('[tunnel-manager] Failed to start tunnel:', error.message);
        process.exit(1);
      }
      break;

    case 'stop':
      stopTunnel();
      console.info('[tunnel-manager] Tunnel stopped');
      process.exit(0);
      break;

    case 'status':
      const status = getTunnelStatus();
      console.info(JSON.stringify(status, null, 2));
      process.exit(0);
      break;

    default:
      console.info('Usage: tunnel-manager.js <start|stop|status>');
      process.exit(1);
  }
}

// Handle cleanup on exit
process.on('SIGINT', () => {
  stopTunnel();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopTunnel();
  process.exit(0);
});

// Run CLI if executed directly
if (process.argv[1]?.endsWith('tunnel-manager.js')) {
  main();
}

export {
  createTunnel,
  startIAPTunnel,
  startSSHTunnel,
  startCloudflareTunnel,
  stopTunnel,
  getTunnelStatus,
  checkPortOpen,
};
