import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import WebSocket from 'ws';
import { Computer, OSType as CuaOSType } from '@trycua/computer';
import sharp from 'sharp';
import { VM_SIZE_SPECS, } from './types.js';
const API_BASE = process.env.CUA_API_BASE || 'https://api.cua.ai';
const MAX_IMAGE_WIDTH = 1200; // Max width for screenshots to avoid API limits
// Moltbot Master integration for VPS registration
const MOLTBOT_MASTER_URL = process.env.MOLTBOT_MASTER_URL || 'https://moltbot-master.liam-939.workers.dev';
const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds
/**
 * Resize screenshot buffer to fit within API limits
 */
async function resizeScreenshot(buffer) {
    try {
        const metadata = await sharp(buffer).metadata();
        if (metadata.width && metadata.width > MAX_IMAGE_WIDTH) {
            return await sharp(buffer)
                .resize(MAX_IMAGE_WIDTH, undefined, { fit: 'inside' })
                .png({ quality: 80 })
                .toBuffer();
        }
        return buffer;
    }
    catch (e) {
        // If resize fails, return original
        console.error('[VMManager] Screenshot resize failed:', e);
        return buffer;
    }
}
/**
 * VMManager - Manages Real Windows/macOS/Linux VMs via TryCua Cloud
 *
 * Uses TryCua Cloud API to provision VMs, then connects via SDK.
 * Each VM is a real cloud-hosted machine controlled via WebSocket.
 */
export class VMManager extends EventEmitter {
    vms = new Map();
    heartbeatTimers = new Map();
    maxVms;
    apiKey;
    enableMasterRegistration;
    constructor(maxVms = 5) {
        super();
        this.maxVms = maxVms;
        this.apiKey = process.env.CUA_API_KEY || process.env.TRYCUA_API_KEY || '';
        this.enableMasterRegistration = process.env.MOLTBOT_MASTER_REGISTRATION !== 'false';
        if (!this.apiKey) {
            console.error('[VMManager] Warning: No CUA_API_KEY - VM operations will fail');
            console.error('[VMManager] Get your API key at https://cua.ai');
        }
    }
    /**
     * Register a VM with Moltbot Master for orchestration
     */
    async registerWithMaster(vm) {
        if (!this.enableMasterRegistration)
            return;
        try {
            const response = await fetch(`${MOLTBOT_MASTER_URL}/vps/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: vm.id,
                    name: vm.name,
                    endpoint: `vm://${vm.id}`, // Virtual endpoint for MCP-based VMs
                    capabilities: ['browser', 'compute', 'screenshot', vm.osType],
                }),
            });
            if (response.ok) {
                console.log(`[VMManager] Registered VM ${vm.name} with Moltbot Master`);
                this.emit('master_registered', { vmId: vm.id, name: vm.name });
            }
            else {
                console.error(`[VMManager] Failed to register with Master: ${response.status}`);
            }
        }
        catch (error) {
            console.error(`[VMManager] Master registration error:`, error);
        }
    }
    /**
     * Send heartbeat to Moltbot Master
     */
    async sendHeartbeat(vmId) {
        if (!this.enableMasterRegistration)
            return;
        const vm = this.get(vmId);
        if (!vm)
            return;
        try {
            await fetch(`${MOLTBOT_MASTER_URL}/vps/heartbeat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: vm.id,
                    status: vm.status === 'working' ? 'busy' : 'online',
                    currentTask: vm.currentTask,
                }),
            });
        }
        catch (error) {
            // Silently fail - heartbeat is best-effort
            console.error(`[VMManager] Heartbeat error for ${vmId}:`, error);
        }
    }
    /**
     * Start periodic heartbeat for a VM
     */
    startHeartbeat(vmId) {
        if (!this.enableMasterRegistration)
            return;
        // Clear existing heartbeat if any
        if (this.heartbeatTimers.has(vmId)) {
            clearInterval(this.heartbeatTimers.get(vmId));
        }
        // Send immediate heartbeat
        this.sendHeartbeat(vmId);
        // Set up periodic heartbeat
        const timer = setInterval(() => this.sendHeartbeat(vmId), HEARTBEAT_INTERVAL_MS);
        this.heartbeatTimers.set(vmId, timer);
    }
    /**
     * Stop heartbeat for a VM
     */
    stopHeartbeat(vmId) {
        const timer = this.heartbeatTimers.get(vmId);
        if (timer) {
            clearInterval(timer);
            this.heartbeatTimers.delete(vmId);
        }
    }
    /**
     * Bootstrap a Linux VM for coding tasks
     * Installs Claude Code CLI and plugins via terminal commands
     */
    async bootstrapForCoding(vmId, anthropicApiKey) {
        const entry = this.vms.get(vmId);
        if (!entry) {
            throw new Error(`VM ${vmId} not found`);
        }
        const { computer, meta: vm } = entry;
        if (!computer || !computer.interface) {
            throw new Error(`VM ${vmId} interface not ready`);
        }
        if (vm.osType !== 'linux') {
            return { success: false, message: 'Bootstrap currently only supports Linux VMs' };
        }
        const apiKey = anthropicApiKey || process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            return { success: false, message: 'ANTHROPIC_API_KEY required for bootstrap' };
        }
        console.log(`[VMManager] Bootstrapping VM ${vmId} for coding...`);
        vm.status = 'working';
        vm.currentTask = 'Installing Claude Code';
        this.emit('vm_status', { vmId, status: 'bootstrapping' });
        const iface = computer.interface;
        try {
            // Open terminal
            await iface.pressKey('ctrl+alt+t');
            await this.delay(2000);
            // Install Node.js and Claude Code
            const setupCommands = [
                // Install Node.js if not present
                'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs',
                // Install Claude Code
                'npm install -g @anthropic-ai/claude-code@latest || npm install -g claude-code@latest',
                // Set API key
                `echo "export ANTHROPIC_API_KEY=${apiKey}" >> ~/.bashrc`,
                `export ANTHROPIC_API_KEY=${apiKey}`,
                // Create config
                'mkdir -p ~/.config/claude && echo \'{"model":"claude-sonnet-4-20250514"}\' > ~/.config/claude/config.json',
                // Configure git
                `git config --global user.name "Moltbot VPS ${vmId.slice(0, 8)}"`,
                `git config --global user.email "moltbot-${vmId.slice(0, 8)}@swarm.local"`,
            ];
            for (const cmd of setupCommands) {
                await iface.typeText(cmd);
                await iface.pressKey('Return');
                await this.delay(3000); // Wait for command to complete
            }
            // Register with Master
            const registerCmd = `curl -s -X POST "${MOLTBOT_MASTER_URL}/vps/register" -H "Content-Type: application/json" -d '{"id":"${vmId}","name":"VPS-${vmId.slice(0, 8)}","endpoint":"trycua","capabilities":["claude-code","git","coding"]}'`;
            await iface.typeText(registerCmd);
            await iface.pressKey('Return');
            await this.delay(2000);
            // Close terminal
            await iface.pressKey('ctrl+d');
            vm.status = 'ready';
            vm.currentTask = undefined;
            vm.tags.push('claude-code', 'coding-ready');
            console.log(`[VMManager] VM ${vmId} bootstrapped for coding`);
            this.emit('vm_bootstrapped', { vmId });
            return { success: true, message: 'VM bootstrapped with Claude Code CLI' };
        }
        catch (error) {
            vm.status = 'error';
            return { success: false, message: `Bootstrap failed: ${error}` };
        }
    }
    /**
     * Map our OSType to TryCua's OSType enum
     */
    mapOSType(osType) {
        switch (osType) {
            case 'windows':
                return CuaOSType.WINDOWS;
            case 'linux':
                return CuaOSType.LINUX;
            case 'macos':
            default:
                return CuaOSType.MACOS;
        }
    }
    /**
     * Provision a VM via TryCua Cloud API
     * This creates the actual cloud VM before we can connect to it
     */
    async provisionVM(osType, region = 'north-america', size = 'small') {
        const response = await fetch(`${API_BASE}/v1/vms`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                os: osType,
                configuration: size || 'small',
                region: region,
            }),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to provision VM: ${response.status} - ${errorText}`);
        }
        return await response.json();
    }
    /**
     * Delete a VM via TryCua Cloud API
     */
    async deleteVM(cloudName) {
        const response = await fetch(`${API_BASE}/v1/vms/${cloudName}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
            },
        });
        if (!response.ok && response.status !== 404) {
            console.error(`[VMManager] Failed to delete VM ${cloudName}: ${response.status}`);
        }
    }
    /**
     * Spawn a new VM via TryCua Cloud
     */
    async spawn(config) {
        if (!this.apiKey) {
            throw new Error('CUA_API_KEY not set. Get your API key at https://cua.ai');
        }
        if (this.vms.size >= this.maxVms) {
            throw new Error(`Maximum VM limit (${this.maxVms}) reached`);
        }
        const id = uuidv4();
        const osType = config.osType || 'windows'; // Default to Windows
        const size = config.size || 'small';
        const resources = VM_SIZE_SPECS[size];
        const vm = {
            id,
            name: config.name,
            osType,
            status: 'spawning',
            tags: config.tags || [],
            size,
            resources,
            region: config.region,
            createdAt: new Date(),
        };
        this.vms.set(id, { computer: null, meta: vm });
        this.emit('vm_created', { vmId: id, name: config.name });
        try {
            // Step 1: Provision VM via API
            console.log(`[VMManager] Provisioning ${osType} VM...`);
            vm.status = 'setting_up';
            this.emit('vm_status', { vmId: id, status: 'setting_up' });
            const provision = await this.provisionVM(osType, config.region || 'north-america', size);
            console.log(`[VMManager] VM provisioned: ${provision.name} at ${provision.host}`);
            // Step 2: Wait for VM's WebSocket to be accessible before connecting
            // Newly provisioned VMs take time to boot and start the WebSocket server
            console.log(`[VMManager] Waiting for VM to be fully ready...`);
            await this.waitForVMReady(provision.host, 180); // Wait up to 3 minutes
            // Step 3: Connect to the provisioned VM using SDK
            const computer = new Computer({
                name: provision.name, // Use the cloud-assigned name
                osType: this.mapOSType(osType),
                apiKey: this.apiKey,
            });
            console.log(`[VMManager] Connecting to VM at ${provision.host}...`);
            await computer.run();
            // Update our stored reference with cloud name for cleanup
            this.vms.set(id, { computer, meta: vm, cloudName: provision.name });
            // Update VM with actual host info
            vm.name = provision.name;
            vm.status = 'ready';
            this.emit('vm_ready', { vmId: id });
            console.log(`[VMManager] VM "${provision.name}" (${osType}) is ready`);
            // Register with Moltbot Master and start heartbeat
            await this.registerWithMaster(vm);
            this.startHeartbeat(id);
            return vm;
        }
        catch (error) {
            vm.status = 'error';
            this.emit('vm_error', { vmId: id, error: String(error) });
            throw error;
        }
    }
    /**
     * Wait for VM's WebSocket server to be ready by testing TCP connectivity
     */
    async waitForVMReady(host, timeoutSeconds = 180) {
        const startTime = Date.now();
        const wsUrl = `wss://${host}:8443/ws`;
        while (Date.now() - startTime < timeoutSeconds * 1000) {
            try {
                // Try to establish a WebSocket connection briefly
                const connected = await this.testWebSocketConnection(wsUrl, 5000);
                if (connected) {
                    const elapsed = Math.floor((Date.now() - startTime) / 1000);
                    console.log(`[VMManager] VM WebSocket is ready (${elapsed}s)`);
                    return;
                }
            }
            catch {
                // Connection failed - VM not ready yet
            }
            // Wait before retrying
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            console.log(`[VMManager] Waiting for VM WebSocket... (${elapsed}s)`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        throw new Error(`VM not ready after ${timeoutSeconds} seconds`);
    }
    /**
     * Test if WebSocket connection can be established
     */
    testWebSocketConnection(url, timeout) {
        return new Promise((resolve) => {
            // Add auth headers for cloud connection
            const ws = new WebSocket(url, {
                headers: {
                    'X-API-Key': this.apiKey,
                },
                handshakeTimeout: timeout,
            });
            const timer = setTimeout(() => {
                ws.terminate();
                resolve(false);
            }, timeout);
            ws.on('open', () => {
                clearTimeout(timer);
                ws.close();
                resolve(true);
            });
            ws.on('error', () => {
                clearTimeout(timer);
                ws.terminate();
                resolve(false);
            });
        });
    }
    /**
     * Execute a computer action on a VM
     */
    async executeAction(vmId, action) {
        const entry = this.vms.get(vmId);
        if (!entry) {
            throw new Error(`VM ${vmId} not found`);
        }
        const { computer, meta: vm } = entry;
        if (!computer || !computer.interface) {
            throw new Error(`VM ${vmId} interface not ready`);
        }
        vm.lastActivity = new Date();
        try {
            const iface = computer.interface;
            switch (action.type) {
                case 'click':
                    if (action.button === 'right') {
                        await iface.rightClick(action.x, action.y);
                    }
                    else if (action.button === 'middle') {
                        // TryCua doesn't have middle click directly, use left
                        await iface.leftClick(action.x, action.y);
                    }
                    else {
                        await iface.leftClick(action.x, action.y);
                    }
                    break;
                case 'type':
                    if (action.text) {
                        await iface.typeText(action.text);
                    }
                    break;
                case 'key':
                    if (action.key) {
                        await iface.pressKey(action.key);
                    }
                    break;
                case 'scroll':
                    const clicks = action.amount || 3;
                    if (action.direction === 'up') {
                        await iface.scrollUp(clicks);
                    }
                    else {
                        await iface.scrollDown(clicks);
                    }
                    break;
                case 'move':
                    if (action.x !== undefined && action.y !== undefined) {
                        await iface.moveCursor(action.x, action.y);
                    }
                    break;
                case 'screenshot':
                    // Just capture, handled below
                    break;
            }
            // Capture screenshot after action and resize to fit API limits
            const rawScreenshot = await iface.screenshot();
            const screenshotBuffer = await resizeScreenshot(rawScreenshot);
            const imageB64 = screenshotBuffer.toString('base64');
            const screenshot = {
                vmId,
                imageB64,
                timestamp: new Date(),
                lastAction: this.describeAction(action),
            };
            vm.screenshotB64 = imageB64;
            vm.lastAction = screenshot.lastAction;
            this.emit('screenshot', screenshot);
            return screenshot;
        }
        catch (error) {
            vm.status = 'error';
            throw error;
        }
    }
    /**
     * Parse a task to extract browser-related actions
     */
    parseBrowserTask(task) {
        const lowerTask = task.toLowerCase();
        // Check for URL navigation
        const urlMatch = task.match(/(?:go to|navigate to|open|visit|browse to)\s+(https?:\/\/[^\s]+|[a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z]{2,})+[^\s]*)/i);
        if (urlMatch) {
            let url = urlMatch[1];
            if (!url.startsWith('http')) {
                url = 'https://' + url;
            }
            return { action: 'navigate', url };
        }
        // Check for search
        const searchMatch = task.match(/(?:search|google|look up|find)\s+(?:for\s+)?["']?([^"']+?)["']?(?:\s+on\s+(?:google|chrome|the\s+web))?$/i);
        if (searchMatch) {
            return { action: 'search', query: searchMatch[1].trim() };
        }
        // Check for browser opening (Firefox or Chrome)
        if (lowerTask.includes('open chrome') || lowerTask.includes('launch chrome') ||
            lowerTask.includes('start chrome') || lowerTask.includes('open browser') ||
            lowerTask.includes('open chromium') || lowerTask.includes('open firefox') ||
            lowerTask.includes('launch firefox') || lowerTask.includes('start firefox')) {
            return { action: 'open_browser' };
        }
        return { action: 'none' };
    }
    /**
     * Execute a task on a VM (high-level task description)
     * This uses the computer's interface to perform the task step by step
     * Supports automatic Chrome launching and navigation
     */
    async executeTask(vmId, task) {
        const entry = this.vms.get(vmId);
        if (!entry) {
            throw new Error(`VM ${vmId} not found`);
        }
        const { computer, meta: vm } = entry;
        if (vm.status === 'stopped' || vm.status === 'error') {
            throw new Error(`VM ${vmId} is in ${vm.status} state`);
        }
        const startTime = Date.now();
        const screenshots = [];
        const actions = [];
        vm.status = 'working';
        vm.currentTask = task;
        vm.lastActivity = new Date();
        this.emit('task_started', { vmId, task });
        try {
            const iface = computer.interface;
            // Parse the task to see if we can automate it
            const parsed = this.parseBrowserTask(task);
            // Take initial screenshot and resize
            let rawBuffer = await iface.screenshot();
            let screenshotBuffer = await resizeScreenshot(rawBuffer);
            let imageB64 = screenshotBuffer.toString('base64');
            screenshots.push({
                vmId,
                imageB64,
                timestamp: new Date(),
                reasoning: `Task received: ${task}`,
                lastAction: 'Initial screenshot',
            });
            if (parsed.action !== 'none') {
                // Open browser if needed (Firefox preferred, fallback to Chrome)
                if (parsed.action === 'open_browser' || parsed.action === 'navigate' || parsed.action === 'search') {
                    console.log(`[VMManager] Opening Firefox on VM ${vmId}...`);
                    // For Linux: Open terminal and launch Firefox
                    if (vm.osType === 'linux') {
                        // Use keyboard shortcut to open terminal (works on most Linux DEs)
                        await iface.pressKey('ctrl+alt+t');
                        await this.delay(1500);
                        // Type command to launch Firefox (preferred) or Chrome as fallback
                        await iface.typeText('firefox 2>/dev/null || chromium-browser --no-first-run 2>/dev/null || google-chrome --no-first-run 2>/dev/null &');
                        await iface.pressKey('Return');
                        actions.push('Opened terminal and launched Firefox');
                        await this.delay(3000); // Wait for Firefox to open
                        // Close the terminal
                        await iface.pressKey('ctrl+d');
                        await this.delay(500);
                    }
                    else if (vm.osType === 'windows') {
                        // Windows: Win+R, type firefox, Enter
                        await iface.pressKey('super+r');
                        await this.delay(500);
                        await iface.typeText('firefox');
                        await iface.pressKey('Return');
                        actions.push('Launched Firefox via Run dialog');
                        await this.delay(3000);
                    }
                    else if (vm.osType === 'macos') {
                        // macOS: Spotlight, type Firefox, Enter
                        await iface.pressKey('cmd+space');
                        await this.delay(500);
                        await iface.typeText('Firefox');
                        await iface.pressKey('Return');
                        actions.push('Launched Firefox via Spotlight');
                        await this.delay(3000);
                    }
                    // Take screenshot after Firefox opens and resize
                    rawBuffer = await iface.screenshot();
                    screenshotBuffer = await resizeScreenshot(rawBuffer);
                    imageB64 = screenshotBuffer.toString('base64');
                    screenshots.push({
                        vmId,
                        imageB64,
                        timestamp: new Date(),
                        reasoning: 'Firefox launched',
                        lastAction: 'Firefox opened',
                    });
                }
                // Navigate to URL if specified
                if (parsed.action === 'navigate' && parsed.url) {
                    console.log(`[VMManager] Navigating to ${parsed.url}...`);
                    // Focus address bar and navigate
                    await iface.pressKey('ctrl+l');
                    await this.delay(300);
                    await iface.typeText(parsed.url);
                    await iface.pressKey('Return');
                    actions.push(`Navigated to ${parsed.url}`);
                    await this.delay(3000); // Wait for page to load
                    // Take screenshot after navigation and resize
                    rawBuffer = await iface.screenshot();
                    screenshotBuffer = await resizeScreenshot(rawBuffer);
                    imageB64 = screenshotBuffer.toString('base64');
                    screenshots.push({
                        vmId,
                        imageB64,
                        timestamp: new Date(),
                        reasoning: `Navigated to ${parsed.url}`,
                        lastAction: `Loaded ${parsed.url}`,
                    });
                }
                // Search if specified
                if (parsed.action === 'search' && parsed.query) {
                    console.log(`[VMManager] Searching for "${parsed.query}"...`);
                    // Go to address bar and search
                    await iface.pressKey('ctrl+l');
                    await this.delay(300);
                    await iface.typeText(parsed.query);
                    await iface.pressKey('Return');
                    actions.push(`Searched for "${parsed.query}"`);
                    await this.delay(3000); // Wait for results
                    // Take screenshot after search and resize
                    rawBuffer = await iface.screenshot();
                    screenshotBuffer = await resizeScreenshot(rawBuffer);
                    imageB64 = screenshotBuffer.toString('base64');
                    screenshots.push({
                        vmId,
                        imageB64,
                        timestamp: new Date(),
                        reasoning: `Searched for "${parsed.query}"`,
                        lastAction: `Search results for "${parsed.query}"`,
                    });
                }
            }
            vm.screenshotB64 = imageB64;
            vm.status = 'idle';
            vm.currentTask = undefined;
            vm.lastAction = actions.length > 0 ? actions[actions.length - 1] : 'Task completed';
            const result = {
                vmId,
                task,
                success: true,
                output: actions.length > 0
                    ? `Task completed. Actions performed: ${actions.join(', ')}`
                    : `Task "${task}" ready for execution. Screenshot captured. Use computer_action to perform specific actions.`,
                screenshots,
                duration: Date.now() - startTime,
            };
            this.emit('task_complete', { vmId, result });
            return result;
        }
        catch (error) {
            vm.status = 'error';
            const result = {
                vmId,
                task,
                success: false,
                output: '',
                screenshots,
                duration: Date.now() - startTime,
                error: String(error),
            };
            this.emit('task_failed', { vmId, result });
            return result;
        }
    }
    /**
     * Helper to add delay between actions
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    /**
     * Get current screenshot from VM
     */
    async getScreenshot(vmId) {
        const entry = this.vms.get(vmId);
        if (!entry) {
            throw new Error(`VM ${vmId} not found`);
        }
        const { computer, meta: vm } = entry;
        if (!computer || !computer.interface) {
            // Return cached screenshot if interface not ready
            return {
                vmId,
                imageB64: vm.screenshotB64 || '',
                timestamp: new Date(),
                reasoning: vm.reasoning,
                lastAction: vm.lastAction || 'Interface not ready',
            };
        }
        try {
            const rawBuffer = await computer.interface.screenshot();
            const screenshotBuffer = await resizeScreenshot(rawBuffer);
            const imageB64 = screenshotBuffer.toString('base64');
            const screenshot = {
                vmId,
                imageB64,
                timestamp: new Date(),
                reasoning: vm.reasoning,
                lastAction: vm.lastAction,
            };
            vm.screenshotB64 = imageB64;
            return screenshot;
        }
        catch (error) {
            // Return cached screenshot on error
            return {
                vmId,
                imageB64: vm.screenshotB64 || '',
                timestamp: new Date(),
                reasoning: vm.reasoning,
                lastAction: vm.lastAction || `Error: ${error}`,
            };
        }
    }
    /**
     * Stop a VM - disconnects from SDK and deletes the cloud VM
     */
    async stop(vmId) {
        const entry = this.vms.get(vmId);
        if (!entry)
            return;
        const { computer, meta: vm, cloudName } = entry;
        // Stop heartbeat
        this.stopHeartbeat(vmId);
        // Send offline status to Master
        if (this.enableMasterRegistration) {
            try {
                await fetch(`${MOLTBOT_MASTER_URL}/vps/heartbeat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: vmId, status: 'offline' }),
                });
            }
            catch {
                // Ignore - VM is stopping anyway
            }
        }
        // Disconnect SDK
        try {
            if (computer) {
                await computer.stop();
            }
        }
        catch (error) {
            console.error(`[VMManager] Error disconnecting from VM ${vmId}:`, error);
        }
        // Delete cloud VM to release resources
        if (cloudName) {
            console.log(`[VMManager] Deleting cloud VM ${cloudName}...`);
            await this.deleteVM(cloudName);
        }
        vm.status = 'stopped';
        this.vms.delete(vmId);
        this.emit('vm_stopped', { vmId });
    }
    /**
     * Stop all VMs
     */
    async stopAll() {
        // Clear all heartbeat timers first
        for (const timer of this.heartbeatTimers.values()) {
            clearInterval(timer);
        }
        this.heartbeatTimers.clear();
        const stopPromises = Array.from(this.vms.keys()).map((id) => this.stop(id));
        await Promise.all(stopPromises);
    }
    /**
     * Get VM by ID
     */
    get(vmId) {
        return this.vms.get(vmId)?.meta;
    }
    /**
     * Get all VMs
     */
    getAll() {
        return Array.from(this.vms.values()).map((entry) => entry.meta);
    }
    /**
     * Get VMs by status
     */
    getByStatus(status) {
        return this.getAll().filter((vm) => vm.status === status);
    }
    /**
     * Get VMs by tag
     */
    getByTag(tag) {
        return this.getAll().filter((vm) => vm.tags.includes(tag));
    }
    /**
     * Get all unique tags across all VMs
     */
    getAllTags() {
        const tagSet = new Set();
        for (const vm of this.getAll()) {
            for (const tag of vm.tags) {
                tagSet.add(tag);
            }
        }
        return Array.from(tagSet).sort();
    }
    /**
     * Add tags to an existing VM
     */
    addTags(vmId, tags) {
        const entry = this.vms.get(vmId);
        if (!entry)
            return undefined;
        for (const tag of tags) {
            if (!entry.meta.tags.includes(tag)) {
                entry.meta.tags.push(tag);
            }
        }
        return entry.meta;
    }
    /**
     * Remove tags from an existing VM
     */
    removeTags(vmId, tags) {
        const entry = this.vms.get(vmId);
        if (!entry)
            return undefined;
        entry.meta.tags = entry.meta.tags.filter(t => !tags.includes(t));
        return entry.meta;
    }
    /**
     * Get pool status
     */
    getPoolStatus() {
        const vms = this.getAll();
        return {
            total: vms.length,
            maxVms: this.maxVms,
            ready: vms.filter((vm) => vm.status === 'ready').length,
            working: vms.filter((vm) => vm.status === 'working').length,
            idle: vms.filter((vm) => vm.status === 'idle').length,
            error: vms.filter((vm) => vm.status === 'error').length,
            hasApiKey: !!this.apiKey,
        };
    }
    /**
     * Describe a computer action for logging
     */
    describeAction(action) {
        switch (action.type) {
            case 'click':
                return `click(${action.x}, ${action.y}) [${action.button || 'left'}]`;
            case 'type':
                return `type("${action.text?.slice(0, 20)}${(action.text?.length || 0) > 20 ? '...' : ''}")`;
            case 'scroll':
                return `scroll(${action.direction}, ${action.amount})`;
            case 'key':
                return `key(${action.key})`;
            case 'move':
                return `move(${action.x}, ${action.y})`;
            case 'screenshot':
                return 'screenshot()';
            default:
                return 'unknown action';
        }
    }
}
export default VMManager;
//# sourceMappingURL=vm-manager.js.map