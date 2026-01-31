#!/usr/bin/env node
/**
 * Windows-MCP Streaming Wrapper
 *
 * This MCP server wraps the Windows-MCP endpoint and adds:
 * 1. Screenshot streaming (like TryCua's 200ms interval)
 * 2. Sidebar integration via /tmp/strawberry-vm-screenshots/
 * 3. strawberry_sync compatible events
 *
 * Works with both Strawberry Terminal and Claude Code CLI.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

// Configuration
const SCREENSHOTS_DIR = '/tmp/strawberry-vm-screenshots';
const VM_STATUS_FILE = '/tmp/bat-vm-status.json';
const MCP_EVENTS_FILE = '/tmp/bat-mcp-events.jsonl';
const DEFAULT_STREAM_INTERVAL_MS = 200; // 5 FPS like TryCua

// State
let screenStreamInterval = null;
let windowsEndpoint = process.env.WINDOWS_MCP_ENDPOINT || 'http://35.210.46.85:8080';
const vmId = 'windows-mcp-' + Date.now();
const vmName = process.env.WINDOWS_MCP_VM_NAME || 'savelli-marketing-job';

/**
 * Ensure directories exist
 */
function ensureDirectories() {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
}

/**
 * Save screenshot to file (same format as TryCua)
 */
function saveScreenshot(imageB64, lastAction = 'streaming') {
  try {
    ensureDirectories();
    const screenshot = {
      vmId,
      vmName,
      timestamp: new Date().toISOString(),
      imageData: imageB64,
      lastAction,
      platform: 'windows',
    };
    fs.writeFileSync(
      path.join(SCREENSHOTS_DIR, `${vmId}.json`),
      JSON.stringify(screenshot, null, 2)
    );
  } catch (e) {
    console.error('[windows-mcp] Failed to save screenshot:', e.message);
  }
}

/**
 * Log event (same format as TryCua)
 */
function logEvent(event) {
  try {
    const line = JSON.stringify({
      ...event,
      timestamp: new Date().toISOString(),
      source: 'windows-mcp',
    }) + '\n';
    fs.appendFileSync(MCP_EVENTS_FILE, line);
  } catch (e) {
    // Ignore
  }
}

/**
 * Update VM status file
 */
function updateVMStatus(status = 'ready') {
  try {
    const statusData = {
      vms: [{
        id: vmId,
        name: vmName,
        status,
        osType: 'windows',
        platform: 'gcp',
        endpoint: windowsEndpoint,
      }],
      lastUpdate: new Date().toISOString(),
    };

    // Merge with existing status if present
    if (fs.existsSync(VM_STATUS_FILE)) {
      try {
        const existing = JSON.parse(fs.readFileSync(VM_STATUS_FILE, 'utf-8'));
        const otherVms = (existing.vms || []).filter(v => v.id !== vmId);
        statusData.vms = [...otherVms, ...statusData.vms];
      } catch (e) {
        // Ignore parse errors
      }
    }

    fs.writeFileSync(VM_STATUS_FILE, JSON.stringify(statusData, null, 2));
  } catch (e) {
    // Ignore
  }
}

/**
 * Call Windows-MCP endpoint
 */
async function callWindowsMCP(tool, params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(windowsEndpoint);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: tool,
        arguments: params,
      },
      id: Date.now(),
    });

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    };

    const req = httpModule.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(json.error.message || 'MCP call failed'));
          } else {
            resolve(json.result);
          }
        } catch (e) {
          reject(new Error('Invalid JSON response'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Get screenshot from Windows-MCP State-Tool
 */
async function getWindowsScreenshot() {
  try {
    const result = await callWindowsMCP('State-Tool', {});

    // State-Tool returns screenshot in various formats
    if (result?.content) {
      for (const item of result.content) {
        if (item.type === 'image' && item.data) {
          return item.data; // Base64 image
        }
        if (item.type === 'text' && item.text?.includes('base64')) {
          // Extract base64 from text if embedded
          const match = item.text.match(/data:image\/[^;]+;base64,([^"]+)/);
          if (match) return match[1];
        }
      }
    }

    return null;
  } catch (e) {
    console.error('[windows-mcp] Screenshot failed:', e.message);
    return null;
  }
}

/**
 * Start screenshot streaming
 */
function startScreenStream(intervalMs = DEFAULT_STREAM_INTERVAL_MS) {
  if (screenStreamInterval) {
    clearInterval(screenStreamInterval);
  }

  console.error(`[windows-mcp] Starting screen stream at ${intervalMs}ms interval`);
  updateVMStatus('streaming');
  logEvent({ type: 'stream_start', vmId, intervalMs });

  screenStreamInterval = setInterval(async () => {
    try {
      const screenshot = await getWindowsScreenshot();
      if (screenshot) {
        saveScreenshot(screenshot, 'streaming');
      }
    } catch (e) {
      console.error('[windows-mcp] Stream error:', e.message);
    }
  }, intervalMs);

  return { success: true, vmId, intervalMs };
}

/**
 * Stop screenshot streaming
 */
function stopScreenStream() {
  if (screenStreamInterval) {
    clearInterval(screenStreamInterval);
    screenStreamInterval = null;
    console.error('[windows-mcp] Screen stream stopped');
    updateVMStatus('ready');
    logEvent({ type: 'stream_stop', vmId });
    return { success: true };
  }
  return { success: false, error: 'No active stream' };
}

/**
 * Proxy tool call to Windows-MCP and save screenshot
 */
async function proxyToolCall(tool, params, actionDescription) {
  const result = await callWindowsMCP(tool, params);

  // After action, capture and save screenshot
  const screenshot = await getWindowsScreenshot();
  if (screenshot) {
    saveScreenshot(screenshot, actionDescription);
  }

  logEvent({ type: 'tool_call', tool, params, vmId });

  return result;
}

/**
 * Create MCP Server
 */
const server = new Server(
  {
    name: 'windows-mcp-wrapper',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * List available tools
 */
server.setRequestHandler('tools/list', async () => {
  return {
    tools: [
      // Streaming tools (like TryCua)
      {
        name: 'start_screen_stream',
        description: 'Start streaming screenshots from Windows VM to the Strawberry sidebar (200ms interval, 5 FPS)',
        inputSchema: {
          type: 'object',
          properties: {
            interval_ms: {
              type: 'number',
              description: 'Interval between screenshots in ms (default: 200)',
            },
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
        description: 'Get a single screenshot from the Windows VM',
        inputSchema: { type: 'object', properties: {} },
      },
      // Windows-MCP proxy tools
      {
        name: 'State-Tool',
        description: 'Get current state/screenshot of the Windows desktop',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'Click-Tool',
        description: 'Click at coordinates on the Windows desktop',
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
        name: 'Type-Tool',
        description: 'Type text on the Windows desktop',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to type' },
          },
          required: ['text'],
        },
      },
      {
        name: 'Shortcut-Tool',
        description: 'Press keyboard shortcut on Windows',
        inputSchema: {
          type: 'object',
          properties: {
            shortcut: { type: 'string', description: 'Shortcut like "ctrl+c", "alt+tab"' },
          },
          required: ['shortcut'],
        },
      },
      {
        name: 'Scroll-Tool',
        description: 'Scroll on the Windows desktop',
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X coordinate' },
            y: { type: 'number', description: 'Y coordinate' },
            direction: { type: 'string', enum: ['up', 'down'], default: 'down' },
            amount: { type: 'number', description: 'Scroll amount in pixels', default: 100 },
          },
          required: ['x', 'y'],
        },
      },
    ],
  };
});

/**
 * Handle tool calls
 */
server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'start_screen_stream': {
        const result = startScreenStream(args?.interval_ms || DEFAULT_STREAM_INTERVAL_MS);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }

      case 'stop_screen_stream': {
        const result = stopScreenStream();
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }

      case 'get_screenshot': {
        const screenshot = await getWindowsScreenshot();
        if (screenshot) {
          saveScreenshot(screenshot, 'manual');
          return {
            content: [
              { type: 'text', text: 'Screenshot captured and saved to sidebar' },
              { type: 'image', mimeType: 'image/png', data: screenshot },
            ],
          };
        }
        return {
          content: [{ type: 'text', text: 'Failed to capture screenshot' }],
          isError: true,
        };
      }

      case 'State-Tool': {
        const result = await proxyToolCall('State-Tool', args, 'state');
        return result;
      }

      case 'Click-Tool': {
        const result = await proxyToolCall('Click-Tool', args, `click at (${args.x}, ${args.y})`);
        return result;
      }

      case 'Type-Tool': {
        const result = await proxyToolCall('Type-Tool', args, `typed "${args.text?.substring(0, 20)}..."`);
        return result;
      }

      case 'Shortcut-Tool': {
        const result = await proxyToolCall('Shortcut-Tool', args, `shortcut ${args.shortcut}`);
        return result;
      }

      case 'Scroll-Tool': {
        const result = await proxyToolCall('Scroll-Tool', args, `scroll ${args.direction}`);
        return result;
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

/**
 * Start the server
 */
async function main() {
  console.error('[windows-mcp] Starting MCP wrapper server');
  console.error('[windows-mcp] Endpoint:', windowsEndpoint);
  console.error('[windows-mcp] VM ID:', vmId);
  console.error('[windows-mcp] VM Name:', vmName);

  ensureDirectories();
  updateVMStatus('ready');
  logEvent({ type: 'server_start', vmId, vmName, endpoint: windowsEndpoint });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[windows-mcp] Server running');
}

// Cleanup on exit
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
