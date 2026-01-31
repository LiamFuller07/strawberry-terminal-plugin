#!/usr/bin/env node
/**
 * Windows-MCP Bootstrap - MCP Server with Screenshot Streaming
 *
 * This follows the same architecture as TryCua MCP:
 * 1. Runs as a stdio MCP server
 * 2. Streams screenshots to /tmp/strawberry-vm-screenshots/
 * 3. Proxies tool calls to the Windows-MCP endpoint
 * 4. Works in both Strawberry Terminal and Claude Code CLI
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Configuration (aligned with TryCua)
// ============================================================================

const SCREENSHOTS_DIR = '/tmp/strawberry-vm-screenshots';
const VM_STATUS_FILE = '/tmp/bat-vm-status.json';
const MCP_EVENTS_FILE = '/tmp/bat-mcp-events.jsonl';
const DEFAULT_STREAM_INTERVAL_MS = 200; // 5 FPS like TryCua

const {
  WINDOWS_MCP_ENDPOINT,
  WINDOWS_MCP_VM_NAME,
  WINDOWS_MCP_LOCAL_DIR,
  CLAUDE_PLUGIN_ROOT,
  GCP_PROJECT_ID,
  GCP_ZONE,
} = process.env;

// VM identity
const vmId = `windows-${Date.now()}`;
const vmName = WINDOWS_MCP_VM_NAME || 'windows-vm';
let windowsEndpoint = WINDOWS_MCP_ENDPOINT || null;
let screenStreamInterval = null;
let lastScreenshot = null;

// Activation state - don't show in sidebar until a tool is called
let isActivated = false;

// ============================================================================
// File System Helpers (same as TryCua)
// ============================================================================

function ensureDirectories() {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
}

function saveVMScreenshot(imageB64, lastAction = 'streaming') {
  try {
    ensureDirectories();
    const screenshot = {
      vmId,
      vmName,
      timestamp: new Date().toISOString(),
      imageData: imageB64,
      lastAction,
      platform: 'windows',
      endpoint: windowsEndpoint,
    };
    fs.writeFileSync(
      path.join(SCREENSHOTS_DIR, `${vmId}.json`),
      JSON.stringify(screenshot, null, 2)
    );
    lastScreenshot = imageB64;
  } catch (e) {
    console.error('[windows-mcp] Failed to save screenshot:', e.message);
  }
}

function logEvent(event) {
  try {
    const line = JSON.stringify({
      ...event,
      timestamp: new Date().toISOString(),
      source: 'windows-mcp',
      vmId,
    }) + '\n';
    fs.appendFileSync(MCP_EVENTS_FILE, line);
  } catch (e) {
    // Ignore
  }
}

function updateVMStatus(status = 'ready') {
  try {
    let existingVms = [];
    if (fs.existsSync(VM_STATUS_FILE)) {
      try {
        const existing = JSON.parse(fs.readFileSync(VM_STATUS_FILE, 'utf-8'));
        existingVms = (existing.vms || []).filter(v => v.id !== vmId);
      } catch (e) {}
    }

    const statusData = {
      vms: [
        ...existingVms,
        {
          id: vmId,
          name: vmName,
          status,
          osType: 'windows',
          platform: 'gcp',
          endpoint: windowsEndpoint,
          zone: GCP_ZONE || 'europe-west1-b',
          project: GCP_PROJECT_ID || 'unknown',
        },
      ],
      lastUpdate: new Date().toISOString(),
    };

    fs.writeFileSync(VM_STATUS_FILE, JSON.stringify(statusData, null, 2));
  } catch (e) {}
}

// ============================================================================
// Windows-MCP HTTP Client
// ============================================================================

async function callWindowsEndpoint(tool, params = {}) {
  if (!windowsEndpoint) {
    throw new Error('WINDOWS_MCP_ENDPOINT not configured');
  }

  return new Promise((resolve, reject) => {
    const url = new URL(windowsEndpoint);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    // Windows-MCP uses simple REST endpoints
    const toolPath = `/${tool.toLowerCase().replace('-tool', '')}`;
    const method = Object.keys(params).length > 0 ? 'POST' : 'GET';
    const body = method === 'POST' ? JSON.stringify(params) : null;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: toolPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(body && { 'Content-Length': Buffer.byteLength(body) }),
      },
      timeout: 30000,
    };

    const req = httpModule.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          // Handle different response formats
          if (res.headers['content-type']?.includes('image')) {
            // Binary image response
            resolve({ type: 'image', data: Buffer.from(data, 'binary').toString('base64') });
          } else {
            const json = JSON.parse(data);
            resolve(json);
          }
        } catch (e) {
          // Plain text response
          resolve({ type: 'text', data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) req.write(body);
    req.end();
  });
}

async function getScreenshot() {
  try {
    const result = await callWindowsEndpoint('State-Tool');

    // Extract base64 image from various response formats
    if (result?.screenshot) return result.screenshot;
    if (result?.image) return result.image;
    if (result?.imageData) return result.imageData;
    if (result?.data && result.type === 'image') return result.data;

    // Check for base64 in content array
    if (result?.content) {
      for (const item of result.content) {
        if (item.type === 'image' && item.data) return item.data;
      }
    }

    return null;
  } catch (e) {
    console.error('[windows-mcp] Screenshot error:', e.message);
    return null;
  }
}

// ============================================================================
// Screenshot Streaming (same pattern as TryCua)
// ============================================================================

function startScreenStream(intervalMs = DEFAULT_STREAM_INTERVAL_MS) {
  if (screenStreamInterval) {
    clearInterval(screenStreamInterval);
  }

  console.error(`[windows-mcp] Starting screen stream at ${intervalMs}ms (${1000/intervalMs} FPS)`);
  updateVMStatus('streaming');
  logEvent({ type: 'stream_start', intervalMs });

  screenStreamInterval = setInterval(async () => {
    try {
      const screenshot = await getScreenshot();
      if (screenshot) {
        saveVMScreenshot(screenshot, 'streaming');
      }
    } catch (e) {
      // Continue streaming despite errors
    }
  }, intervalMs);

  return { success: true, vmId, vmName, intervalMs };
}

function stopScreenStream() {
  if (screenStreamInterval) {
    clearInterval(screenStreamInterval);
    screenStreamInterval = null;
    updateVMStatus('ready');
    logEvent({ type: 'stream_stop' });
    console.error('[windows-mcp] Screen stream stopped');
    return { success: true };
  }
  return { success: false, error: 'No active stream' };
}

// ============================================================================
// MCP Protocol Handler (stdio JSON-RPC)
// ============================================================================

const tools = [
  {
    name: 'start_screen_stream',
    description: 'Start streaming screenshots from Windows VM to the Strawberry sidebar. Screenshots appear at 5 FPS (200ms interval).',
    inputSchema: {
      type: 'object',
      properties: {
        interval_ms: { type: 'number', description: 'Interval in ms (default: 200)' },
      },
    },
  },
  {
    name: 'stop_screen_stream',
    description: 'Stop streaming screenshots from Windows VM',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_screenshot',
    description: 'Get a single screenshot from Windows VM',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'windows_click',
    description: 'Click at coordinates on Windows desktop',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'windows_type',
    description: 'Type text on Windows desktop',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['text'],
    },
  },
  {
    name: 'windows_key',
    description: 'Press keyboard shortcut on Windows (e.g., "ctrl+c", "alt+tab", "enter")',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key or shortcut to press' },
      },
      required: ['key'],
    },
  },
  {
    name: 'windows_scroll',
    description: 'Scroll on Windows desktop',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'number', default: 3 },
      },
      required: ['x', 'y', 'direction'],
    },
  },
];

async function handleToolCall(name, args) {
  // Activate VM in sidebar on first tool call
  if (!isActivated) {
    isActivated = true;
    console.error('[windows-mcp] First tool call - activating in sidebar');
    updateVMStatus('ready');
    logEvent({ type: 'vm_activated', vmId, vmName });
  }

  logEvent({ type: 'tool_call', tool: name, args });

  switch (name) {
    case 'start_screen_stream': {
      const result = startScreenStream(args?.interval_ms || DEFAULT_STREAM_INTERVAL_MS);
      return [{ type: 'text', text: JSON.stringify(result) }];
    }

    case 'stop_screen_stream': {
      const result = stopScreenStream();
      return [{ type: 'text', text: JSON.stringify(result) }];
    }

    case 'get_screenshot': {
      const screenshot = await getScreenshot();
      if (screenshot) {
        saveVMScreenshot(screenshot, 'manual_capture');
        return [
          { type: 'text', text: `Screenshot captured from ${vmName}` },
          { type: 'image', mimeType: 'image/png', data: screenshot },
        ];
      }
      return [{ type: 'text', text: 'Failed to capture screenshot' }];
    }

    case 'windows_click': {
      await callWindowsEndpoint('Click-Tool', args);
      const screenshot = await getScreenshot();
      if (screenshot) saveVMScreenshot(screenshot, `click(${args.x},${args.y})`);
      return [
        { type: 'text', text: `Clicked at (${args.x}, ${args.y})` },
        ...(screenshot ? [{ type: 'image', mimeType: 'image/png', data: screenshot }] : []),
      ];
    }

    case 'windows_type': {
      await callWindowsEndpoint('Type-Tool', args);
      const screenshot = await getScreenshot();
      if (screenshot) saveVMScreenshot(screenshot, `type("${args.text?.substring(0, 20)}...")`);
      return [
        { type: 'text', text: `Typed: "${args.text}"` },
        ...(screenshot ? [{ type: 'image', mimeType: 'image/png', data: screenshot }] : []),
      ];
    }

    case 'windows_key': {
      await callWindowsEndpoint('Shortcut-Tool', { shortcut: args.key });
      const screenshot = await getScreenshot();
      if (screenshot) saveVMScreenshot(screenshot, `key(${args.key})`);
      return [
        { type: 'text', text: `Pressed: ${args.key}` },
        ...(screenshot ? [{ type: 'image', mimeType: 'image/png', data: screenshot }] : []),
      ];
    }

    case 'windows_scroll': {
      await callWindowsEndpoint('Scroll-Tool', args);
      const screenshot = await getScreenshot();
      if (screenshot) saveVMScreenshot(screenshot, `scroll(${args.direction})`);
      return [
        { type: 'text', text: `Scrolled ${args.direction} at (${args.x}, ${args.y})` },
        ...(screenshot ? [{ type: 'image', mimeType: 'image/png', data: screenshot }] : []),
      ];
    }

    default:
      return [{ type: 'text', text: `Unknown tool: ${name}` }];
  }
}

function handleRequest(request) {
  const { method, params, id } = request;

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'windows-mcp', version: '1.0.0' },
      };

    case 'tools/list':
      return { tools };

    case 'tools/call':
      return handleToolCall(params.name, params.arguments || {}).then(content => ({ content }));

    case 'notifications/initialized':
      return null; // No response needed

    default:
      return { error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  console.error('[windows-mcp] Starting MCP server');
  console.error('[windows-mcp] Endpoint:', windowsEndpoint || 'NOT SET');
  console.error('[windows-mcp] VM Name:', vmName);
  console.error('[windows-mcp] VM ID:', vmId);

  ensureDirectories();
  // Don't update status or start streaming until a tool is called
  // This keeps the Windows VM hidden in sidebar until explicitly used
  logEvent({ type: 'server_start', endpoint: windowsEndpoint });

  // Validate endpoint is reachable (but don't show in sidebar)
  if (windowsEndpoint) {
    try {
      const screenshot = await getScreenshot();
      if (screenshot) {
        console.error('[windows-mcp] Endpoint reachable - ready for use');
        // Cache the screenshot but don't save to file (don't show in sidebar)
        lastScreenshot = screenshot;
      }
    } catch (e) {
      console.error('[windows-mcp] Could not connect to endpoint:', e.message);
    }
  }

  // Setup stdio JSON-RPC
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', async (line) => {
    try {
      const request = JSON.parse(line);
      const result = await handleRequest(request);

      if (result !== null && request.id !== undefined) {
        const response = {
          jsonrpc: '2.0',
          id: request.id,
          result,
        };
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (e) {
      if (line.trim()) {
        console.error('[windows-mcp] Parse error:', e.message);
      }
    }
  });

  rl.on('close', () => {
    stopScreenStream();
    process.exit(0);
  });
}

// Cleanup handlers
process.on('SIGINT', () => {
  stopScreenStream();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopScreenStream();
  process.exit(0);
});

main().catch((error) => {
  console.error('[windows-mcp] Fatal error:', error);
  process.exit(1);
});
