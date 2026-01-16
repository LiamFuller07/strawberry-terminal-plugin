/**
 * Computer Use Integration
 *
 * Uses Anthropic's computer-use capability to control browsers.
 * This allows Claude to see the screen and decide what actions to take.
 */
export interface ComputerUseConfig {
    apiKey: string;
    model?: string;
}
export interface ComputerUseAction {
    type: 'mouse_move' | 'left_click' | 'right_click' | 'double_click' | 'type' | 'key' | 'scroll' | 'screenshot' | 'cursor_position';
    coordinate?: [number, number];
    text?: string;
    scroll_direction?: 'up' | 'down' | 'left' | 'right';
    scroll_amount?: number;
}
export interface ComputerUseResult {
    action?: ComputerUseAction;
    reasoning?: string;
    completed?: boolean;
    error?: string;
}
/**
 * Computer Use Agent
 *
 * Interprets screenshots and decides what actions to take.
 */
export declare class ComputerUseAgent {
    private client;
    private model;
    constructor(config: ComputerUseConfig);
    /**
     * Given a task and screenshot, determine the next action
     */
    getNextAction(task: string, screenshotB64: string, previousActions?: string[], displaySize?: {
        width: number;
        height: number;
    }): Promise<ComputerUseResult>;
    /**
     * Execute a full task with multiple steps
     */
    executeTask(task: string, getScreenshot: () => Promise<string>, executeAction: (action: ComputerUseAction) => Promise<void>, options?: {
        maxSteps?: number;
        displaySize?: {
            width: number;
            height: number;
        };
        onStep?: (step: number, action: ComputerUseAction | undefined, reasoning: string) => void;
    }): Promise<{
        success: boolean;
        steps: number;
        reasoning: string[];
        error?: string;
    }>;
    private describeAction;
}
export default ComputerUseAgent;
//# sourceMappingURL=computer-use.d.ts.map