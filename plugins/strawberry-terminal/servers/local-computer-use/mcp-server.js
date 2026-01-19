#!/usr/bin/env node
/**
 * Local Computer Use MCP Server
 *
 * Exposes local Mac computer control as MCP tools for Claude Code.
 * This is for controlling the LOCAL machine, not remote VMs.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { LocalComputerController } from './controller.js';
import * as fs from 'fs';
const VERSION = '0.1.0';
const LOCAL_SCREENSHOTS_DIR = '/tmp/strawberry-local-screenshots';
/**
 * Save local screenshot for Strawberry TUI viewer
 */
function saveLocalScreenshot(imageB64, action) {
    try {
        if (!fs.existsSync(LOCAL_SCREENSHOTS_DIR)) {
            fs.mkdirSync(LOCAL_SCREENSHOTS_DIR, { recursive: true });
        }
        const screenshot = {
            vmId: 'local-mac',
            vmName: 'Local Mac',
            timestamp: new Date().toISOString(),
            imageData: imageB64,
            lastAction: action || 'screenshot',
        };
        fs.writeFileSync(`${LOCAL_SCREENSHOTS_DIR}/local-mac.json`, JSON.stringify(screenshot, null, 2));
    }
    catch {
        // Ignore errors
    }
}
/**
 * Local Computer Use MCP Server
 *
 * Provides tools for Claude to control the local Mac:
 * - Take screenshots
 * - Move mouse
 * - Click (left, right, double, triple)
 * - Type text
 * - Press keys
 * - Scroll
 * - Drag
 */
export class LocalComputerMCPServer {
    server;
    controller;
    constructor() {
        this.controller = new LocalComputerController({
            debug: process.env.DEBUG === 'true',
            screenshotFormat: 'png',
            includeCursor: true,
        });
        this.server = new Server({
            name: 'local-computer-use',
            version: VERSION,
        }, {
            capabilities: {
                tools: {},
            },
        });
        this.setupToolHandlers();
    }
    setupToolHandlers() {
        // List available tools
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const tools = [
                {
                    name: 'local_screenshot',
                    description: 'Take a screenshot of the LOCAL Mac screen. Returns the screenshot as a base64 encoded PNG image.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            display: {
                                type: 'number',
                                description: 'Display number to capture (1 = primary, 2 = secondary, etc.)',
                                default: 1,
                            },
                        },
                    },
                },
                {
                    name: 'local_computer_action',
                    description: 'Perform a mouse/keyboard action on the LOCAL Mac screen. Actions include: left_click, right_click, double_click, triple_click, mouse_move, left_click_drag, type, key, scroll, cursor_position',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            action: {
                                type: 'string',
                                enum: [
                                    'left_click',
                                    'right_click',
                                    'double_click',
                                    'triple_click',
                                    'mouse_move',
                                    'left_click_drag',
                                    'type',
                                    'key',
                                    'scroll',
                                    'cursor_position',
                                ],
                                description: 'The type of action to perform',
                            },
                            coordinate: {
                                type: 'array',
                                items: { type: 'number' },
                                minItems: 2,
                                maxItems: 2,
                                description: 'Target coordinates [x, y] for click/move actions',
                            },
                            start_coordinate: {
                                type: 'array',
                                items: { type: 'number' },
                                minItems: 2,
                                maxItems: 2,
                                description: 'Start coordinates [x, y] for drag operations',
                            },
                            text: {
                                type: 'string',
                                description: 'Text to type (for type action) or key to press (for key action)',
                            },
                            scroll_direction: {
                                type: 'string',
                                enum: ['up', 'down', 'left', 'right'],
                                description: 'Scroll direction (for scroll action)',
                            },
                            scroll_amount: {
                                type: 'number',
                                description: 'Number of scroll "clicks" (default: 3)',
                                default: 3,
                            },
                            modifiers: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Modifier keys for key action: cmd, ctrl, alt, shift',
                            },
                        },
                        required: ['action'],
                    },
                },
                {
                    name: 'local_get_display_info',
                    description: 'Get information about the LOCAL Mac display(s) - resolution, scale factor, etc.',
                    inputSchema: {
                        type: 'object',
                        properties: {},
                    },
                },
                {
                    name: 'local_check_permissions',
                    description: 'Check if the necessary accessibility permissions are granted for mouse/keyboard control. Returns status and instructions if permissions are missing.',
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
                    case 'local_screenshot': {
                        const displayId = args?.display || 1;
                        const screenshot = await this.controller.screenshot(displayId);
                        // Save for Strawberry TUI viewer
                        saveLocalScreenshot(screenshot.imageB64, 'screenshot');
                        const content = [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    success: true,
                                    timestamp: screenshot.timestamp.toISOString(),
                                    dimensions: screenshot.dimensions,
                                    cursor_position: screenshot.cursorPosition,
                                    format: screenshot.format,
                                }, null, 2),
                            },
                            {
                                type: 'image',
                                data: screenshot.imageB64,
                                mimeType: `image/${screenshot.format}`,
                            },
                        ];
                        return { content };
                    }
                    case 'local_computer_action': {
                        const action = {
                            type: args?.action,
                            coordinate: args?.coordinate,
                            startCoordinate: args?.start_coordinate,
                            text: args?.text,
                            scrollDirection: args?.scroll_direction,
                            scrollAmount: args?.scroll_amount,
                            modifiers: args?.modifiers,
                        };
                        const result = await this.controller.executeAction(action);
                        const content = [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    success: result.success,
                                    action: result.action,
                                    timestamp: result.timestamp.toISOString(),
                                    error: result.error,
                                    cursor_position: result.cursorPosition,
                                }, null, 2),
                            },
                        ];
                        // Include screenshot if action produced one
                        if (result.screenshot) {
                            // Save for Strawberry TUI viewer
                            saveLocalScreenshot(result.screenshot.imageB64, result.action);
                            content.push({
                                type: 'image',
                                data: result.screenshot.imageB64,
                                mimeType: `image/${result.screenshot.format}`,
                            });
                        }
                        return { content };
                    }
                    case 'local_get_display_info': {
                        const displays = await this.controller.getDisplayInfo();
                        const cursorPos = await this.controller.getCursorPosition();
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        displays,
                                        current_cursor_position: cursorPos,
                                        robotjs_available: this.controller.hasRobotjs(),
                                    }, null, 2),
                                },
                            ],
                        };
                    }
                    case 'local_check_permissions': {
                        const hasPermissions = await this.controller.checkAccessibilityPermissions();
                        const hasRobotjs = this.controller.hasRobotjs();
                        let instructions = '';
                        if (!hasPermissions) {
                            instructions = `
Accessibility permissions are required for mouse/keyboard control.

To grant permissions:
1. Open System Settings (or System Preferences on older macOS)
2. Go to Privacy & Security > Accessibility
3. Click the lock icon to make changes
4. Enable the terminal app you're running this from (Terminal, iTerm2, VS Code, etc.)
5. You may need to restart the terminal after granting permissions
`;
                        }
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        accessibility_permissions: hasPermissions,
                                        robotjs_available: hasRobotjs,
                                        status: hasPermissions ? 'ready' : 'permissions_required',
                                        instructions: instructions.trim() || undefined,
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
    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error(`[Local Computer Use MCP] Server running on stdio (v${VERSION})`);
    }
}
// Main entry point when run directly
if (process.argv[1]?.includes('mcp-server')) {
    const server = new LocalComputerMCPServer();
    server.run().catch((error) => {
        console.error('[Local Computer Use MCP] Fatal error:', error);
        process.exit(1);
    });
}
export default LocalComputerMCPServer;
//# sourceMappingURL=mcp-server.js.map