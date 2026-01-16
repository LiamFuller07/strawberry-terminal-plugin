/**
 * Local Computer Controller
 *
 * Controls the LOCAL Mac desktop using native macOS tools and robotjs.
 * This is different from the trycua-mcp which controls remote VMs.
 */
import type { LocalComputerConfig, LocalComputerAction, LocalScreenshot, ActionResult, DisplayInfo, MouseButton, ScrollDirection } from './types.js';
/**
 * Local Computer Controller
 *
 * Provides screenshot capture and mouse/keyboard control for the local Mac.
 */
export declare class LocalComputerController {
    private config;
    private tempDir;
    private robotjs;
    private robotjsLoadError;
    private hasAccessibilityPermissions;
    constructor(config?: LocalComputerConfig);
    /**
     * Try to load robotjs for mouse/keyboard control
     */
    private loadRobotjs;
    /**
     * Check if robotjs is available
     */
    hasRobotjs(): boolean;
    /**
     * Check accessibility permissions (required for mouse/keyboard control)
     */
    checkAccessibilityPermissions(): Promise<boolean>;
    /**
     * Get display information
     */
    getDisplayInfo(): Promise<DisplayInfo[]>;
    /**
     * Take a screenshot of the screen
     */
    screenshot(displayId?: number): Promise<LocalScreenshot>;
    /**
     * Get image dimensions from file
     */
    private getImageDimensions;
    /**
     * Get current cursor position
     */
    getCursorPosition(): Promise<{
        x: number;
        y: number;
    }>;
    /**
     * Move mouse to coordinates
     */
    moveMouse(x: number, y: number): Promise<void>;
    /**
     * Click at coordinates
     */
    click(x: number, y: number, button?: MouseButton): Promise<void>;
    /**
     * Double click at coordinates
     */
    doubleClick(x: number, y: number): Promise<void>;
    /**
     * Triple click at coordinates
     */
    tripleClick(x: number, y: number): Promise<void>;
    /**
     * Drag from start to end coordinates
     */
    drag(startX: number, startY: number, endX: number, endY: number): Promise<void>;
    /**
     * Type text
     */
    typeText(text: string, delay?: number): Promise<void>;
    /**
     * Press a key or key combination
     */
    pressKey(key: string, modifiers?: string[]): Promise<void>;
    /**
     * Scroll in a direction
     */
    scroll(direction: ScrollDirection, amount?: number): Promise<void>;
    /**
     * Execute a computer action
     */
    executeAction(action: LocalComputerAction): Promise<ActionResult>;
    /**
     * Cleanup temporary files
     */
    cleanup(): void;
    /**
     * Helper: delay for ms milliseconds
     */
    private delay;
    /**
     * Helper: log message if debug enabled
     */
    private log;
}
export default LocalComputerController;
//# sourceMappingURL=controller.d.ts.map