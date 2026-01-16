/**
 * Browser Controller
 *
 * Uses Puppeteer to control a real browser instance.
 * Integrates with ComputerUseAgent for AI-powered actions.
 */

import puppeteer, { Browser, Page } from 'puppeteer';
import { ComputerUseAgent, ComputerUseAction } from './computer-use.js';
import { EventEmitter } from 'events';

export interface BrowserConfig {
  headless?: boolean;
  width?: number;
  height?: number;
  apiKey: string;
}

export interface BrowserInstance {
  id: string;
  name: string;
  browser: Browser;
  page: Page;
  agent: ComputerUseAgent;
  status: 'ready' | 'working' | 'idle' | 'error';
}

/**
 * Browser Controller
 *
 * Manages browser instances and provides computer-use control.
 */
export class BrowserController extends EventEmitter {
  private instances: Map<string, BrowserInstance> = new Map();
  private config: BrowserConfig;

  constructor(config: BrowserConfig) {
    super();
    this.config = config;
  }

  /**
   * Launch a new browser instance
   */
  async launch(id: string, name: string): Promise<BrowserInstance> {
    const width = this.config.width || 1280;
    const height = this.config.height || 800;

    // Use system Chrome if PUPPETEER_EXECUTABLE_PATH is set
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;

    const browser = await puppeteer.launch({
      headless: this.config.headless ?? false, // Show browser by default for debugging
      executablePath: executablePath || undefined,
      args: [
        `--window-size=${width},${height}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
      defaultViewport: {
        width,
        height,
      },
    });

    const page = await browser.newPage();
    await page.setViewport({ width, height });

    // Navigate to a starting page
    await page.goto('https://www.google.com', { waitUntil: 'networkidle2' });

    const agent = new ComputerUseAgent({
      apiKey: this.config.apiKey,
    });

    const instance: BrowserInstance = {
      id,
      name,
      browser,
      page,
      agent,
      status: 'ready',
    };

    this.instances.set(id, instance);
    this.emit('browser_launched', { id, name });

    return instance;
  }

  /**
   * Get screenshot from browser
   */
  async getScreenshot(id: string): Promise<string> {
    const instance = this.instances.get(id);
    if (!instance) {
      throw new Error(`Browser ${id} not found`);
    }

    const screenshot = await instance.page.screenshot({
      encoding: 'base64',
      type: 'png',
    });

    this.emit('screenshot', { id, timestamp: new Date() });
    return screenshot as string;
  }

  /**
   * Execute a computer-use action
   */
  async executeAction(id: string, action: ComputerUseAction): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance) {
      throw new Error(`Browser ${id} not found`);
    }

    const { page } = instance;

    switch (action.type) {
      case 'left_click':
        if (action.coordinate) {
          await page.mouse.click(action.coordinate[0], action.coordinate[1]);
        }
        break;

      case 'right_click':
        if (action.coordinate) {
          await page.mouse.click(action.coordinate[0], action.coordinate[1], { button: 'right' });
        }
        break;

      case 'double_click':
        if (action.coordinate) {
          await page.mouse.click(action.coordinate[0], action.coordinate[1], { clickCount: 2 });
        }
        break;

      case 'mouse_move':
        if (action.coordinate) {
          await page.mouse.move(action.coordinate[0], action.coordinate[1]);
        }
        break;

      case 'type':
        if (action.text) {
          await page.keyboard.type(action.text, { delay: 50 });
        }
        break;

      case 'key':
        if (action.text) {
          await page.keyboard.press(action.text as any);
        }
        break;

      case 'scroll':
        if (action.scroll_direction && action.scroll_amount) {
          const deltaY = action.scroll_direction === 'down' ? action.scroll_amount : -action.scroll_amount;
          await page.mouse.wheel({ deltaY });
        }
        break;

      default:
        break;
    }

    this.emit('action', { id, action });
  }

  /**
   * Execute an AI-powered task
   */
  async executeTask(
    id: string,
    task: string,
    onProgress?: (step: number, action: string, reasoning: string) => void
  ): Promise<{ success: boolean; steps: number; reasoning: string[]; error?: string }> {
    const instance = this.instances.get(id);
    if (!instance) {
      throw new Error(`Browser ${id} not found`);
    }

    instance.status = 'working';
    this.emit('task_started', { id, task });

    try {
      const result = await instance.agent.executeTask(
        task,
        () => this.getScreenshot(id),
        (action) => this.executeAction(id, action),
        {
          maxSteps: 15,
          displaySize: {
            width: this.config.width || 1280,
            height: this.config.height || 800,
          },
          onStep: (step, action, reasoning) => {
            this.emit('task_step', { id, step, action, reasoning });
            if (onProgress) {
              const actionDesc = action ? this.describeAction(action) : 'thinking';
              onProgress(step, actionDesc, reasoning);
            }
          },
        }
      );

      instance.status = result.success ? 'idle' : 'error';
      this.emit('task_complete', { id, result });

      return result;
    } catch (error) {
      instance.status = 'error';
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.emit('task_error', { id, error: errorMsg });
      return {
        success: false,
        steps: 0,
        reasoning: [],
        error: errorMsg,
      };
    }
  }

  /**
   * Navigate to a URL
   */
  async navigate(id: string, url: string): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance) {
      throw new Error(`Browser ${id} not found`);
    }

    await instance.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    this.emit('navigated', { id, url });
  }

  /**
   * Get current URL
   */
  async getUrl(id: string): Promise<string> {
    const instance = this.instances.get(id);
    if (!instance) {
      throw new Error(`Browser ${id} not found`);
    }

    return instance.page.url();
  }

  /**
   * Close a browser instance
   */
  async close(id: string): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance) return;

    await instance.browser.close();
    this.instances.delete(id);
    this.emit('browser_closed', { id });
  }

  /**
   * Close all browser instances
   */
  async closeAll(): Promise<void> {
    const ids = Array.from(this.instances.keys());
    await Promise.all(ids.map((id) => this.close(id)));
  }

  /**
   * Get instance by ID
   */
  get(id: string): BrowserInstance | undefined {
    return this.instances.get(id);
  }

  /**
   * Get all instances
   */
  getAll(): BrowserInstance[] {
    return Array.from(this.instances.values());
  }

  private describeAction(action: ComputerUseAction): string {
    switch (action.type) {
      case 'left_click':
        return `click(${action.coordinate?.[0]}, ${action.coordinate?.[1]})`;
      case 'type':
        return `type("${action.text?.slice(0, 20)}...")`;
      case 'key':
        return `key(${action.text})`;
      case 'scroll':
        return `scroll(${action.scroll_direction})`;
      default:
        return action.type;
    }
  }
}

export default BrowserController;
