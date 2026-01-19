#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serverName = process.argv[2];
if (!serverName) {
  console.error('[strawberry] Missing server name argument.');
  process.exit(1);
}

const serverMap = {
  'strawberry-context': {
    packageDir: 'strawberry-context-mcp',
    entry: 'dist/index.js',
    pluginDir: 'strawberry-context',
    pluginEntry: 'dist/index.js',
  },
  'trycua': {
    packageDir: 'trycua-mcp',
    entry: 'dist/server.js',
    pluginDir: 'trycua',
    pluginEntry: 'dist/server.js',
  },
  'local-computer-use': {
    packageDir: 'terminal',
    entry: 'dist/local-computer-use/mcp-server.js',
    pluginDir: 'local-computer-use',
    pluginEntry: 'mcp-server.js',
  },
};

const config = serverMap[serverName];
if (!config) {
  console.error(`[strawberry] Unknown server: ${serverName}`);
  process.exit(1);
}

const candidates = [];
const addCandidate = (rootDir) => {
  if (!rootDir) return;
  candidates.push(path.join(rootDir, 'packages', config.packageDir, config.entry));
};

const addAppResources = (appPath) => {
  if (!appPath) return;
  const resourcesDir = path.join(appPath, 'Contents', 'Resources');
  addCandidate(resourcesDir);
  addCandidate(path.join(resourcesDir, '_up_', '_up_', '_up_'));
};

addCandidate(process.env.STRAWBERRY_ROOT);
addCandidate(process.env.STRAWBERRY_RESOURCE_DIR);

addAppResources('/Applications/Strawberry.app');

const home = process.env.HOME;
if (home) {
  addAppResources(path.join(home, 'Applications', 'Strawberry.app'));
}

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
const pluginEntry = path.join(pluginRoot, 'servers', config.pluginDir, config.pluginEntry);
const pluginNodeModules = path.join(pluginRoot, 'servers', config.pluginDir, 'node_modules');
if (fs.existsSync(pluginEntry) && fs.existsSync(pluginNodeModules)) {
  candidates.push(pluginEntry);
}

const target = candidates.find((candidate) => fs.existsSync(candidate));
if (!target) {
  console.error(
    `[strawberry] Unable to locate ${serverName} runtime. ` +
    'Install Strawberry.app or set STRAWBERRY_ROOT/STRAWBERRY_RESOURCE_DIR.'
  );
  process.exit(1);
}

await import(pathToFileURL(target).href);
