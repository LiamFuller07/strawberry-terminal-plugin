#!/usr/bin/env node
/**
 * Strawberry Context MCP Server
 *
 * This MCP server enables bidirectional context sync between Claude Code and the Strawberry TUI.
 *
 * Claude Code MUST call `strawberry_sync` after every significant action to keep the TUI updated.
 * The TUI watches the state file and updates its sidebar accordingly.
 *
 * State flow:
 *   Claude Code → strawberry_sync() → /tmp/strawberry-state.json → Strawberry TUI
 */
export {};
