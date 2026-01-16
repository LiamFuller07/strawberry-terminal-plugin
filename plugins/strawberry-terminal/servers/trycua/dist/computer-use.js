/**
 * Computer Use Integration
 *
 * Uses Anthropic's computer-use capability to control browsers.
 * This allows Claude to see the screen and decide what actions to take.
 */
import Anthropic from '@anthropic-ai/sdk';
/**
 * Computer Use Agent
 *
 * Interprets screenshots and decides what actions to take.
 */
export class ComputerUseAgent {
    client;
    model;
    constructor(config) {
        this.client = new Anthropic({
            apiKey: config.apiKey,
        });
        this.model = config.model || 'claude-sonnet-4-20250514';
    }
    /**
     * Given a task and screenshot, determine the next action
     */
    async getNextAction(task, screenshotB64, previousActions = [], displaySize = { width: 1280, height: 800 }) {
        try {
            const response = await this.client.messages.create({
                model: this.model,
                max_tokens: 1024,
                system: `You are a computer use agent. You can see the screen and control the mouse/keyboard.

Available actions:
- mouse_move: Move mouse to coordinates [x, y]
- left_click: Click at current position or coordinates
- right_click: Right-click at current position or coordinates
- double_click: Double-click at coordinates
- type: Type text
- key: Press a key (Enter, Tab, Escape, etc.)
- scroll: Scroll up/down/left/right
- screenshot: Take a screenshot (implicit after each action)

Guidelines:
1. Always analyze the screenshot carefully before acting
2. Click on the center of UI elements
3. Wait for pages to load before acting
4. If you see the task is complete, set completed: true
5. If you encounter an error, describe it`,
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: 'image/png',
                                    data: screenshotB64,
                                },
                            },
                            {
                                type: 'text',
                                text: `TASK: ${task}

${previousActions.length > 0 ? `Previous actions:\n${previousActions.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\n` : ''}

Screen size: ${displaySize.width}x${displaySize.height}

Analyze the screenshot and decide the next action to complete the task.
Respond with JSON:
{
  "reasoning": "What I see and why I'm taking this action",
  "action": {
    "type": "left_click",
    "coordinate": [x, y]
  },
  "completed": false
}

Or if the task is done:
{
  "reasoning": "The task is complete because...",
  "completed": true
}`,
                            },
                        ],
                    },
                ],
            });
            const text = response.content[0].type === 'text' ? response.content[0].text : '';
            // Parse JSON from response
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                return {
                    error: 'Could not parse response',
                    reasoning: text,
                };
            }
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                action: parsed.action,
                reasoning: parsed.reasoning,
                completed: parsed.completed,
            };
        }
        catch (error) {
            return {
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    /**
     * Execute a full task with multiple steps
     */
    async executeTask(task, getScreenshot, executeAction, options = {}) {
        const maxSteps = options.maxSteps || 20;
        const displaySize = options.displaySize || { width: 1280, height: 800 };
        const previousActions = [];
        const reasoning = [];
        for (let step = 0; step < maxSteps; step++) {
            // Get current screenshot
            const screenshotB64 = await getScreenshot();
            // Get next action from Claude
            const result = await this.getNextAction(task, screenshotB64, previousActions, displaySize);
            if (result.reasoning) {
                reasoning.push(result.reasoning);
            }
            if (options.onStep) {
                options.onStep(step + 1, result.action, result.reasoning || '');
            }
            if (result.error) {
                return {
                    success: false,
                    steps: step + 1,
                    reasoning,
                    error: result.error,
                };
            }
            if (result.completed) {
                return {
                    success: true,
                    steps: step + 1,
                    reasoning,
                };
            }
            if (result.action) {
                // Execute the action
                await executeAction(result.action);
                previousActions.push(this.describeAction(result.action));
                // Small delay to let the UI update
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }
        return {
            success: false,
            steps: maxSteps,
            reasoning,
            error: 'Max steps reached',
        };
    }
    describeAction(action) {
        switch (action.type) {
            case 'left_click':
                return `Clicked at (${action.coordinate?.[0]}, ${action.coordinate?.[1]})`;
            case 'right_click':
                return `Right-clicked at (${action.coordinate?.[0]}, ${action.coordinate?.[1]})`;
            case 'double_click':
                return `Double-clicked at (${action.coordinate?.[0]}, ${action.coordinate?.[1]})`;
            case 'mouse_move':
                return `Moved mouse to (${action.coordinate?.[0]}, ${action.coordinate?.[1]})`;
            case 'type':
                return `Typed "${action.text?.slice(0, 30)}${(action.text?.length || 0) > 30 ? '...' : ''}"`;
            case 'key':
                return `Pressed key: ${action.text}`;
            case 'scroll':
                return `Scrolled ${action.scroll_direction} by ${action.scroll_amount}`;
            default:
                return `${action.type}`;
        }
    }
}
export default ComputerUseAgent;
//# sourceMappingURL=computer-use.js.map