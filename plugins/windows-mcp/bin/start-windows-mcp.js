#!/usr/bin/env node
import { readFileSync } from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const rdpFile = process.argv[2];
const xfreerdpPath = process.env.XFREERDP_PATH || 'xfreerdp';
const remoteDir = process.env.WINDOWS_MCP_REMOTE_DIR || 'C:\\WindowsMCP';
const command = process.env.WINDOWS_MCP_REMOTE_CMD || `cmd.exe /k "cd ${remoteDir} && uvx windows-mcp"`;

if (!rdpFile) {
  console.error('[windows-mcp] No RDP file provided. Pass the path to the RDP file as the first argument.');
  process.exit(1);
}

const normalizeLine = (line) => line.trim();
const lines = readFileSync(rdpFile, 'utf-8').split(/\r?\n/).map(normalizeLine).filter(Boolean);
const data = {};
for (const line of lines) {
  const idx = line.indexOf(':s:');
  if (idx === -1) continue;
  const key = line.slice(0, idx).trim().toLowerCase();
  const value = line.slice(idx + 3).trim();
  data[key] = value;
}

const host = data['full address'] || data['gatewayhostname'];
if (!host) {
  console.error('[windows-mcp] Could not parse host from RDP file');
  process.exit(1);
}

const args = [
  `/v:${host}`,
  '/cert:ignore',
  '--dynamic-resolution',
  `/shell:${command}`,
];

if (data['username']) {
  args.push(`/u:${data['username']}`);
}
if (data['domain']) {
  args.push(`/d:${data['domain']}`);
}
if (process.env.WINDOWS_MCP_PASSWORD) {
  args.push(`/p:${process.env.WINDOWS_MCP_PASSWORD}`);
}
if (process.env.WINDOWS_MCP_PORT) {
  args[0] = `/v:${host}:${process.env.WINDOWS_MCP_PORT}`;
}

console.info('[windows-mcp] Starting xfreerdp to auto-launch MCP:', xfreerdpPath, args.join(' '));
const proc = spawn(xfreerdpPath, args, { stdio: 'inherit' });
proc.on('exit', (code) => {
  console.info('[windows-mcp] xfreerdp exited with', code);
});
proc.on('error', (error) => {
  console.error('[windows-mcp] Failed to spawn xfreerdp:', error.message);
});
