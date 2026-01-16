/**
 * Types for Local Computer Use
 */
export type MouseButton = 'left' | 'right' | 'middle';
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';
export interface LocalComputerConfig {
    /**
     * Enable debug logging
     */
    debug?: boolean;
    /**
     * Screenshot format (png or jpg)
     */
    screenshotFormat?: 'png' | 'jpg';
    /**
     * Default delay between actions in ms
     */
    actionDelay?: number;
    /**
     * Whether to include cursor in screenshots
     */
    includeCursor?: boolean;
}
export interface LocalComputerAction {
    type: 'screenshot' | 'left_click' | 'right_click' | 'double_click' | 'triple_click' | 'mouse_move' | 'left_click_drag' | 'type' | 'key' | 'scroll' | 'cursor_position';
    /**
     * Target coordinates [x, y] for click/move actions
     */
    coordinate?: [number, number];
    /**
     * Start coordinates for drag operations
     */
    startCoordinate?: [number, number];
    /**
     * Text to type or key to press
     */
    text?: string;
    /**
     * Scroll direction
     */
    scrollDirection?: ScrollDirection;
    /**
     * Scroll amount (number of "clicks")
     */
    scrollAmount?: number;
    /**
     * Modifier keys (cmd, ctrl, alt, shift)
     */
    modifiers?: string[];
}
export interface LocalScreenshot {
    /**
     * Base64 encoded image data
     */
    imageB64: string;
    /**
     * Image format (png or jpg)
     */
    format: 'png' | 'jpg';
    /**
     * Screenshot timestamp
     */
    timestamp: Date;
    /**
     * Screen dimensions
     */
    dimensions: {
        width: number;
        height: number;
    };
    /**
     * Current cursor position at time of screenshot
     */
    cursorPosition?: {
        x: number;
        y: number;
    };
}
export interface ActionResult {
    success: boolean;
    action: string;
    timestamp: Date;
    screenshot?: LocalScreenshot;
    error?: string;
    cursorPosition?: {
        x: number;
        y: number;
    };
}
export interface DisplayInfo {
    width: number;
    height: number;
    scale: number;
    isPrimary: boolean;
    id: number;
}
//# sourceMappingURL=types.d.ts.map