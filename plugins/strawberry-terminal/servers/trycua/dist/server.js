#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { VMManager } from './vm-manager.js';
import * as fs from 'fs';
const VERSION = '0.1.0';
const MCP_EVENTS_FILE = '/tmp/bat-mcp-events.jsonl';
const VM_STATUS_FILE = '/tmp/bat-vm-status.json';
const VM_SCREENSHOTS_DIR = '/tmp/strawberry-vm-screenshots';
const DEFAULT_STREAM_INTERVAL_MS = 400;
// Disable VM UI features (screenshots, status) by default
// Set STRAWBERRY_VM_UI=1 to enable
const VM_UI_ENABLED = process.env.STRAWBERRY_VM_UI === '1';
/**
 * Write event for sidebar tracking
 * Only writes if STRAWBERRY_VM_UI=1 is set
 */
function writeEvent(event) {
    if (!VM_UI_ENABLED)
        return;
    try {
        const line = JSON.stringify({ ...event, timestamp: new Date().toISOString() }) + '\n';
        fs.appendFileSync(MCP_EVENTS_FILE, line);
    }
    catch {
        // Ignore errors
    }
}
/**
 * Save VM screenshot for Strawberry TUI viewer
 * Only saves if STRAWBERRY_VM_UI=1 is set
 */
function saveVMScreenshot(vmId, vmName, imageB64, lastAction) {
    if (!VM_UI_ENABLED)
        return;
    try {
        // Ensure directory exists
        if (!fs.existsSync(VM_SCREENSHOTS_DIR)) {
            fs.mkdirSync(VM_SCREENSHOTS_DIR, { recursive: true });
        }
        const screenshot = {
            vmId,
            vmName,
            timestamp: new Date().toISOString(),
            imageData: imageB64,
            lastAction,
        };
        fs.writeFileSync(`${VM_SCREENSHOTS_DIR}/${vmId}.json`, JSON.stringify(screenshot, null, 2));
    }
    catch {
        // Ignore errors
    }
}
/**
 * Update VM status file for sidebar
 * Only updates if STRAWBERRY_VM_UI=1 is set
 */
function updateVMStatus(vmManager) {
    if (!VM_UI_ENABLED)
        return;
    try {
        const vms = vmManager.getAll().map(vm => ({
            id: vm.id,
            name: vm.name,
            status: vm.status,
            osType: vm.osType,
            tags: vm.tags,
            size: vm.size,
            resources: vm.resources,
            region: vm.region,
            createdAt: vm.createdAt.toISOString(),
        }));
        // Calculate total resources
        const totalRAM = vms.reduce((sum, vm) => sum + (vm.resources?.ramMB || 0), 0);
        const totalCPU = vms.reduce((sum, vm) => sum + (vm.resources?.cpu || 0), 0);
        fs.writeFileSync(VM_STATUS_FILE, JSON.stringify({
            vms,
            totals: {
                vmCount: vms.length,
                ramMB: totalRAM,
                ram: `${(totalRAM / 1024).toFixed(1)}GB`,
                cpu: totalCPU,
            },
            lastUpdate: new Date().toISOString()
        }, null, 2));
    }
    catch {
        // Ignore errors
    }
}
/**
 * TryCua MCP Server
 *
 * This MCP server exposes TryCua VM management as tools that Claude Code can use.
 * It enables Claude Code to:
 * 1. Spawn VMs
 * 2. Execute tasks on VMs using computer use
 * 3. Take screenshots
 * 4. Perform mouse/keyboard actions
 * 5. Manage VM lifecycle
 */
class TryCuaMCPServer {
    server;
    vmManager;
    screenStreams = new Map();
    constructor() {
        this.vmManager = new VMManager(10);
        this.server = new Server({
            name: 'trycua-mcp',
            version: VERSION,
        }, {
            capabilities: {
                tools: {},
                resources: {},
            },
        });
        this.setupToolHandlers();
        this.setupResourceHandlers();
        this.setupVMEventForwarding();
    }
    setupToolHandlers() {
        // List available tools
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const tools = [
                {
                    name: 'spawn_vm',
                    description: 'Spawn a new Linux VM in the cloud. IMPORTANT: Only pass the "name" parameter - all other parameters have optimal defaults (Linux, Asia, 8GB RAM). Do NOT specify os_type, region, or size unless explicitly asked.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            name: {
                                type: 'string',
                                description: 'Name for the VM (required)',
                            },
                            os_type: {
                                type: 'string',
                                enum: ['linux', 'windows', 'macos'],
                                description: 'DO NOT SET - defaults to linux',
                            },
                            region: {
                                type: 'string',
                                enum: ['asia-pacific', 'north-america', 'europe', 'south-america'],
                                description: 'DO NOT SET - defaults to asia-pacific',
                            },
                            size: {
                                type: 'string',
                                enum: ['medium', 'small', 'large'],
                                description: 'DO NOT SET - defaults to medium (8GB RAM)',
                            },
                            tags: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Optional tags',
                            },
                        },
                        required: ['name'],
                    },
                },
                {
                    name: 'execute_task',
                    description: 'Execute a task on a VM using computer use. The task will be interpreted and executed using mouse/keyboard actions.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            vm_id: {
                                type: 'string',
                                description: 'The VM ID to execute the task on',
                            },
                            task: {
                                type: 'string',
                                description: 'The task to execute (e.g., "Open Chrome and search for AI news")',
                            },
                        },
                        required: ['vm_id', 'task'],
                    },
                },
                {
                    name: 'computer_action',
                    description: 'Perform a specific computer action (click, type, scroll, key press) on a VM',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            vm_id: {
                                type: 'string',
                                description: 'The VM ID',
                            },
                            action: {
                                type: 'string',
                                enum: ['click', 'type', 'scroll', 'key', 'move', 'screenshot'],
                                description: 'The type of action',
                            },
                            x: {
                                type: 'number',
                                description: 'X coordinate (for click/move)',
                            },
                            y: {
                                type: 'number',
                                description: 'Y coordinate (for click/move)',
                            },
                            text: {
                                type: 'string',
                                description: 'Text to type (for type action)',
                            },
                            button: {
                                type: 'string',
                                enum: ['left', 'right', 'middle'],
                                description: 'Mouse button (for click)',
                            },
                            key: {
                                type: 'string',
                                description: 'Key to press (for key action, e.g., "Enter", "Tab")',
                            },
                            direction: {
                                type: 'string',
                                enum: ['up', 'down'],
                                description: 'Scroll direction',
                            },
                            amount: {
                                type: 'number',
                                description: 'Scroll amount in pixels',
                            },
                        },
                        required: ['vm_id', 'action'],
                    },
                },
                {
                    name: 'get_screenshot',
                    description: 'Get the current screenshot from a VM',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            vm_id: {
                                type: 'string',
                                description: 'The VM ID',
                            },
                        },
                        required: ['vm_id'],
                    },
                },
                {
                    name: 'start_screen_stream',
                    description: 'Start streaming screenshots from a VM to the sidebar. Screenshots are captured frequently and displayed in the Strawberry TUI.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            vm_id: {
                                type: 'string',
                                description: 'The VM ID to stream from',
                            },
                            interval_ms: {
                                type: 'number',
                                description: 'Interval between screenshots in ms (default: 200 for 5 fps)',
                            },
                        },
                        required: ['vm_id'],
                    },
                },
                {
                    name: 'stop_screen_stream',
                    description: 'Stop streaming screenshots from a VM',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            vm_id: {
                                type: 'string',
                                description: 'The VM ID to stop streaming',
                            },
                        },
                        required: ['vm_id'],
                    },
                },
                {
                    name: 'stop_vm',
                    description: 'Stop a running VM',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            vm_id: {
                                type: 'string',
                                description: 'The VM ID to stop',
                            },
                        },
                        required: ['vm_id'],
                    },
                },
                {
                    name: 'list_vms',
                    description: 'List all VMs and their current status',
                    inputSchema: {
                        type: 'object',
                        properties: {},
                    },
                },
                {
                    name: 'get_pool_status',
                    description: 'Get the status of the VM pool (total, working, idle, etc.)',
                    inputSchema: {
                        type: 'object',
                        properties: {},
                    },
                },
                {
                    name: 'find_vms_by_tag',
                    description: 'Find all VMs with a specific tag. Useful for managing groups of VMs like "strawberry-browser" or "claude-cowork".',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            tag: {
                                type: 'string',
                                description: 'Tag to search for (e.g., "strawberry-browser")',
                            },
                        },
                        required: ['tag'],
                    },
                },
                {
                    name: 'execute_on_tagged_vms',
                    description: 'Execute a task on all VMs with a specific tag. Useful for running the same task across all browser VMs or cowork instances.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            tag: {
                                type: 'string',
                                description: 'Tag to filter VMs by',
                            },
                            task: {
                                type: 'string',
                                description: 'Task to execute on all matching VMs',
                            },
                        },
                        required: ['tag', 'task'],
                    },
                },
                {
                    name: 'add_vm_tags',
                    description: 'Add tags to an existing VM',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            vm_id: {
                                type: 'string',
                                description: 'The VM ID',
                            },
                            tags: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Tags to add',
                            },
                        },
                        required: ['vm_id', 'tags'],
                    },
                },
                {
                    name: 'remove_vm_tags',
                    description: 'Remove tags from an existing VM',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            vm_id: {
                                type: 'string',
                                description: 'The VM ID',
                            },
                            tags: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Tags to remove',
                            },
                        },
                        required: ['vm_id', 'tags'],
                    },
                },
                {
                    name: 'list_all_tags',
                    description: 'List all unique tags across all VMs',
                    inputSchema: {
                        type: 'object',
                        properties: {},
                    },
                },
            ];
            return { tools };
        });
        // Handle tool calls
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            try {
                switch (name) {
                    case 'spawn_vm': {
                        const config = {
                            name: args?.name,
                            osType: args?.os_type || 'linux', // Default to Linux
                            region: args?.region || 'asia-pacific', // Default to Asia
                            size: args?.size || 'medium', // Default to medium (8GB RAM)
                            tags: args?.tags || [],
                            setupChrome: args?.setup_chrome !== false,
                            installClaudeExtension: args?.install_claude_extension === true,
                        };
                        // Write event for sidebar tracking
                        writeEvent({ type: 'spawn_vm', vm_name: config.name, os_type: config.osType, status: 'spawning' });
                        const vm = await this.vmManager.spawn(config);
                        // Update status after spawn
                        writeEvent({ type: 'spawn_vm', vm_id: vm.id, vm_name: vm.name, os_type: vm.osType, status: vm.status });
                        updateVMStatus(this.vmManager);
                        // Take initial screenshot for sidebar display
                        try {
                            const initialScreenshot = await this.vmManager.getScreenshot(vm.id);
                            if (initialScreenshot?.imageB64) {
                                saveVMScreenshot(vm.id, vm.name, initialScreenshot.imageB64, 'VM ready');
                            }
                        }
                        catch {
                            // Ignore screenshot errors - VM might still be initializing
                        }
                        // Auto-start screen streaming for sidebar updates
                        await this.startScreenStream(vm.id, DEFAULT_STREAM_INTERVAL_MS);
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        success: true,
                                        vm_id: vm.id,
                                        name: vm.name,
                                        status: vm.status,
                                        os_type: vm.osType,
                                        tags: vm.tags,
                                        size: vm.size,
                                        resources: vm.resources,
                                        region: vm.region,
                                        message: `VM "${vm.name}" spawned successfully. Use vm_id "${vm.id}" for subsequent operations.`,
                                    }, null, 2),
                                },
                            ],
                        };
                    }
                    case 'execute_task': {
                        const vmId = args?.vm_id;
                        const task = args?.task;
                        // Write event for sidebar - task started
                        writeEvent({ type: 'task', vm_id: vmId, action: 'start', data: task.slice(0, 100) });
                        const result = await this.vmManager.executeTask(vmId, task);
                        // Write event - task complete
                        writeEvent({ type: 'task', vm_id: vmId, action: result.success ? 'complete' : 'error', data: result.output?.slice(0, 100), error: result.error });
                        updateVMStatus(this.vmManager);
                        const content = [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    success: result.success,
                                    output: result.output,
                                    duration_ms: result.duration,
                                    error: result.error,
                                }, null, 2),
                            },
                        ];
                        // Include latest screenshot if available
                        if (result.screenshots.length > 0) {
                            const lastScreenshot = result.screenshots[result.screenshots.length - 1];
                            if (lastScreenshot.imageB64) {
                                content.push({
                                    type: 'image',
                                    data: lastScreenshot.imageB64,
                                    mimeType: 'image/png',
                                });
                                // Write screenshot event
                                writeEvent({ type: 'screenshot', vm_id: vmId, data: 'Screenshot captured' });
                                // Save screenshot for Strawberry TUI viewer
                                const vm = this.vmManager.get(vmId);
                                saveVMScreenshot(vmId, vm?.name || vmId, lastScreenshot.imageB64, task);
                            }
                        }
                        return { content };
                    }
                    case 'computer_action': {
                        const vmId = args?.vm_id;
                        const action = {
                            type: args?.action,
                            x: args?.x,
                            y: args?.y,
                            text: args?.text,
                            button: args?.button,
                            key: args?.key,
                            direction: args?.direction,
                            amount: args?.amount,
                        };
                        // Write event for sidebar - action performed
                        const actionDesc = action.type === 'click' ? `click(${action.x},${action.y})` :
                            action.type === 'type' ? `type("${action.text?.slice(0, 20)}...")` :
                                action.type === 'key' ? `key(${action.key})` :
                                    action.type;
                        writeEvent({ type: 'action', vm_id: vmId, action: actionDesc });
                        const screenshot = await this.vmManager.executeAction(vmId, action);
                        // Write screenshot event and save for TUI viewer
                        if (screenshot.imageB64) {
                            writeEvent({ type: 'screenshot', vm_id: vmId, data: screenshot.lastAction });
                            // Save screenshot for Strawberry TUI viewer
                            const vm = this.vmManager.get(vmId);
                            saveVMScreenshot(vmId, vm?.name || vmId, screenshot.imageB64, actionDesc);
                        }
                        updateVMStatus(this.vmManager);
                        const content = [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    success: true,
                                    action: screenshot.lastAction,
                                    timestamp: screenshot.timestamp.toISOString(),
                                }, null, 2),
                            },
                        ];
                        if (screenshot.imageB64) {
                            content.push({
                                type: 'image',
                                data: screenshot.imageB64,
                                mimeType: 'image/png',
                            });
                        }
                        return { content };
                    }
                    case 'get_screenshot': {
                        const vmId = args?.vm_id;
                        const screenshot = await this.vmManager.getScreenshot(vmId);
                        // Write screenshot event for sidebar
                        writeEvent({ type: 'screenshot', vm_id: vmId, data: screenshot.lastAction || 'screenshot' });
                        // Save screenshot for Strawberry TUI viewer
                        if (screenshot.imageB64) {
                            const vm = this.vmManager.get(vmId);
                            saveVMScreenshot(vmId, vm?.name || vmId, screenshot.imageB64, screenshot.lastAction);
                        }
                        const content = [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    vm_id: vmId,
                                    timestamp: screenshot.timestamp.toISOString(),
                                    reasoning: screenshot.reasoning,
                                    last_action: screenshot.lastAction,
                                }, null, 2),
                            },
                        ];
                        if (screenshot.imageB64) {
                            content.push({
                                type: 'image',
                                data: screenshot.imageB64,
                                mimeType: 'image/png',
                            });
                        }
                        return { content };
                    }
                    case 'start_screen_stream': {
                        const vmId = args?.vm_id;
                        const intervalMs = args?.interval_ms || DEFAULT_STREAM_INTERVAL_MS;
                        await this.startScreenStream(vmId, intervalMs);
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        success: true,
                                        message: `Screen streaming started for VM ${vmId} (every ${intervalMs}ms - ${Math.round(1000 / intervalMs)} fps)`,
                                        vm_id: vmId,
                                        interval_ms: intervalMs,
                                    }, null, 2),
                                },
                            ],
                        };
                    }
                    case 'stop_screen_stream': {
                        const vmId = args?.vm_id;
                        if (this.screenStreams.has(vmId)) {
                            clearInterval(this.screenStreams.get(vmId));
                            this.screenStreams.delete(vmId);
                            return {
                                content: [
                                    {
                                        type: 'text',
                                        text: JSON.stringify({ success: true, message: `Screen streaming stopped for VM ${vmId}` }, null, 2),
                                    },
                                ],
                            };
                        }
                        else {
                            return {
                                content: [
                                    {
                                        type: 'text',
                                        text: JSON.stringify({ success: false, message: `No active stream for VM ${vmId}` }, null, 2),
                                    },
                                ],
                            };
                        }
                    }
                    case 'stop_vm': {
                        const vmId = args?.vm_id;
                        // Stop any active screen stream
                        if (this.screenStreams.has(vmId)) {
                            clearInterval(this.screenStreams.get(vmId));
                            this.screenStreams.delete(vmId);
                        }
                        // Write event for sidebar
                        writeEvent({ type: 'stop_vm', vm_id: vmId, status: 'stopping' });
                        await this.vmManager.stop(vmId);
                        // Write final event and update status
                        writeEvent({ type: 'stop_vm', vm_id: vmId, status: 'stopped' });
                        updateVMStatus(this.vmManager);
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        success: true,
                                        message: `VM ${vmId} stopped`,
                                    }, null, 2),
                                },
                            ],
                        };
                    }
                    case 'list_vms': {
                        const vms = this.vmManager.getAll();
                        const totalRAM = vms.reduce((sum, vm) => sum + (vm.resources?.ramMB || 0), 0);
                        const totalCPU = vms.reduce((sum, vm) => sum + (vm.resources?.cpu || 0), 0);
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        count: vms.length,
                                        totals: {
                                            ramMB: totalRAM,
                                            ram: `${(totalRAM / 1024).toFixed(1)}GB`,
                                            cpu: totalCPU,
                                        },
                                        vms: vms.map((vm) => ({
                                            id: vm.id,
                                            name: vm.name,
                                            status: vm.status,
                                            os_type: vm.osType,
                                            tags: vm.tags,
                                            size: vm.size,
                                            resources: vm.resources,
                                            region: vm.region,
                                            created_at: vm.createdAt.toISOString(),
                                            current_task: vm.currentTask,
                                        })),
                                    }, null, 2),
                                },
                            ],
                        };
                    }
                    case 'get_pool_status': {
                        const status = this.vmManager.getPoolStatus();
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify(status, null, 2),
                                },
                            ],
                        };
                    }
                    case 'find_vms_by_tag': {
                        const tag = args?.tag;
                        const vms = this.vmManager.getByTag(tag);
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        tag,
                                        count: vms.length,
                                        vms: vms.map((vm) => ({
                                            id: vm.id,
                                            name: vm.name,
                                            status: vm.status,
                                            os_type: vm.osType,
                                            tags: vm.tags,
                                            created_at: vm.createdAt.toISOString(),
                                            current_task: vm.currentTask,
                                        })),
                                    }, null, 2),
                                },
                            ],
                        };
                    }
                    case 'execute_on_tagged_vms': {
                        const tag = args?.tag;
                        const task = args?.task;
                        const vms = this.vmManager.getByTag(tag);
                        if (vms.length === 0) {
                            return {
                                content: [
                                    {
                                        type: 'text',
                                        text: JSON.stringify({
                                            success: false,
                                            tag,
                                            error: `No VMs found with tag "${tag}"`,
                                        }, null, 2),
                                    },
                                ],
                            };
                        }
                        // Write event for sidebar - batch task started
                        writeEvent({ type: 'batch_task', tag, action: 'start', vm_count: vms.length, data: task.slice(0, 100) });
                        // Execute task on all matching VMs in parallel
                        const results = await Promise.allSettled(vms.map(async (vm) => {
                            try {
                                const result = await this.vmManager.executeTask(vm.id, task);
                                return { vm_id: vm.id, name: vm.name, ...result };
                            }
                            catch (error) {
                                return {
                                    vm_id: vm.id,
                                    name: vm.name,
                                    success: false,
                                    error: error instanceof Error ? error.message : String(error),
                                };
                            }
                        }));
                        const taskResults = results.map((r) => r.status === 'fulfilled' ? r.value : { success: false, error: 'Promise rejected' });
                        // Write event - batch task complete
                        const successCount = taskResults.filter((r) => r.success).length;
                        writeEvent({ type: 'batch_task', tag, action: 'complete', success_count: successCount, total: vms.length });
                        updateVMStatus(this.vmManager);
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        success: true,
                                        tag,
                                        task,
                                        total_vms: vms.length,
                                        successful: successCount,
                                        failed: vms.length - successCount,
                                        results: taskResults,
                                    }, null, 2),
                                },
                            ],
                        };
                    }
                    case 'add_vm_tags': {
                        const vmId = args?.vm_id;
                        const tags = args?.tags;
                        const vm = this.vmManager.addTags(vmId, tags);
                        if (!vm) {
                            return {
                                content: [
                                    {
                                        type: 'text',
                                        text: JSON.stringify({
                                            success: false,
                                            error: `VM ${vmId} not found`,
                                        }, null, 2),
                                    },
                                ],
                                isError: true,
                            };
                        }
                        // Write event for sidebar
                        writeEvent({ type: 'vm_tags', vm_id: vmId, action: 'add', tags });
                        updateVMStatus(this.vmManager);
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        success: true,
                                        vm_id: vmId,
                                        tags: vm.tags,
                                        message: `Tags added to VM ${vmId}`,
                                    }, null, 2),
                                },
                            ],
                        };
                    }
                    case 'remove_vm_tags': {
                        const vmId = args?.vm_id;
                        const tags = args?.tags;
                        const vm = this.vmManager.removeTags(vmId, tags);
                        if (!vm) {
                            return {
                                content: [
                                    {
                                        type: 'text',
                                        text: JSON.stringify({
                                            success: false,
                                            error: `VM ${vmId} not found`,
                                        }, null, 2),
                                    },
                                ],
                                isError: true,
                            };
                        }
                        // Write event for sidebar
                        writeEvent({ type: 'vm_tags', vm_id: vmId, action: 'remove', tags });
                        updateVMStatus(this.vmManager);
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        success: true,
                                        vm_id: vmId,
                                        tags: vm.tags,
                                        message: `Tags removed from VM ${vmId}`,
                                    }, null, 2),
                                },
                            ],
                        };
                    }
                    case 'list_all_tags': {
                        const tags = this.vmManager.getAllTags();
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        count: tags.length,
                                        tags,
                                    }, null, 2),
                                },
                            ],
                        };
                    }
                    default:
                        throw new Error(`Unknown tool: ${name}`);
                }
            }
            catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: error instanceof Error ? error.message : String(error),
                            }, null, 2),
                        },
                    ],
                    isError: true,
                };
            }
        });
    }
    async startScreenStream(vmId, intervalMs) {
        if (this.screenStreams.has(vmId)) {
            clearInterval(this.screenStreams.get(vmId));
        }
        const vm = this.vmManager.get(vmId);
        const streamInterval = setInterval(async () => {
            try {
                const screenshot = await this.vmManager.getScreenshot(vmId);
                if (screenshot?.imageB64) {
                    saveVMScreenshot(vmId, vm?.name || vmId, screenshot.imageB64, 'streaming');
                }
            }
            catch {
                clearInterval(streamInterval);
                this.screenStreams.delete(vmId);
            }
        }, intervalMs);
        this.screenStreams.set(vmId, streamInterval);
        try {
            const screenshot = await this.vmManager.getScreenshot(vmId);
            if (screenshot?.imageB64) {
                saveVMScreenshot(vmId, vm?.name || vmId, screenshot.imageB64, 'stream started');
            }
        }
        catch {
            // Ignore first screenshot error
        }
    }
    setupResourceHandlers() {
        // List resources (VMs as resources)
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
            const vms = this.vmManager.getAll();
            return {
                resources: vms.map((vm) => ({
                    uri: `vm://${vm.id}`,
                    name: vm.name,
                    description: `TryCua VM: ${vm.name} (${vm.status})`,
                    mimeType: 'application/json',
                })),
            };
        });
        // Read a VM resource
        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            const uri = request.params.uri;
            const vmId = uri.replace('vm://', '');
            const vm = this.vmManager.get(vmId);
            if (!vm) {
                throw new Error(`VM not found: ${vmId}`);
            }
            return {
                contents: [
                    {
                        uri,
                        mimeType: 'application/json',
                        text: JSON.stringify({
                            id: vm.id,
                            name: vm.name,
                            status: vm.status,
                            os_type: vm.osType,
                            created_at: vm.createdAt.toISOString(),
                            last_activity: vm.lastActivity?.toISOString(),
                            current_task: vm.currentTask,
                            reasoning: vm.reasoning,
                            last_action: vm.lastAction,
                        }, null, 2),
                    },
                ],
            };
        });
    }
    setupVMEventForwarding() {
        // Forward VM events as server notifications
        this.vmManager.on('vm_created', (data) => {
            // In a full implementation, we would send notifications
            console.error(`[TryCua] VM created: ${data.name} (${data.vmId})`);
        });
        this.vmManager.on('vm_ready', (data) => {
            console.error(`[TryCua] VM ready: ${data.vmId}`);
        });
        this.vmManager.on('vm_stopped', (data) => {
            console.error(`[TryCua] VM stopped: ${data.vmId}`);
        });
        this.vmManager.on('task_started', (data) => {
            console.error(`[TryCua] Task started on ${data.vmId}: ${data.task.slice(0, 50)}...`);
        });
        this.vmManager.on('task_complete', (data) => {
            console.error(`[TryCua] Task complete on ${data.vmId}`);
        });
        this.vmManager.on('screenshot', (data) => {
            console.error(`[TryCua] Screenshot from ${data.vmId}`);
        });
    }
    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error(`[TryCua MCP] Server running on stdio (v${VERSION})`);
    }
    async shutdown() {
        await this.vmManager.stopAll();
    }
}
// Main entry point
const server = new TryCuaMCPServer();
process.on('SIGINT', async () => {
    await server.shutdown();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    await server.shutdown();
    process.exit(0);
});
server.run().catch((error) => {
    console.error('[TryCua MCP] Fatal error:', error);
    process.exit(1);
});
//# sourceMappingURL=server.js.map