/**
 * Local Computer Use - Control the LOCAL Mac desktop
 *
 * This module provides screenshot capture and mouse/keyboard control
 * for the local machine (not remote VMs). It uses:
 * - macOS screencapture command for screenshots
 * - @jitsi/robotjs for mouse/keyboard control (optional)
 * - AppleScript/Python CGEvent fallbacks for certain operations
 *
 * IMPORTANT: Requires Accessibility permissions in System Preferences
 */
export { LocalComputerController } from './controller.js';
export { LocalComputerMCPServer } from './mcp-server.js';
//# sourceMappingURL=index.js.map