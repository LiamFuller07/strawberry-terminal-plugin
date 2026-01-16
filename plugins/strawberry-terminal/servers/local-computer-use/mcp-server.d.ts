#!/usr/bin/env node
/**
 * Local Computer Use MCP Server
 *
 * Exposes local Mac computer control as MCP tools for Claude Code.
 * This is for controlling the LOCAL machine, not remote VMs.
 */
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
export declare class LocalComputerMCPServer {
    private server;
    private controller;
    constructor();
    private setupToolHandlers;
    run(): Promise<void>;
}
export default LocalComputerMCPServer;
//# sourceMappingURL=mcp-server.d.ts.map