/**
 * Browser Controller
 *
 * Uses Puppeteer to control a real browser instance.
 * Integrates with ComputerUseAgent for AI-powered actions.
 */
import { Browser, Page } from 'puppeteer';
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
export declare class BrowserController extends EventEmitter {
    private instances;
    private config;
    constructor(config: BrowserConfig);
    /**
     * Launch a new browser instance
     */
    launch(id: string, name: string): Promise<BrowserInstance>;
    /**
     * Get screenshot from browser
     */
    getScreenshot(id: string): Promise<string>;
    /**
     * Execute a computer-use action
     */
    executeAction(id: string, action: ComputerUseAction): Promise<void>;
    /**
     * Execute an AI-powered task
     */
    executeTask(id: string, task: string, onProgress?: (step: number, action: string, reasoning: string) => void): Promise<{
        success: boolean;
        steps: number;
        reasoning: string[];
        error?: string;
    }>;
    /**
     * Navigate to a URL
     */
    navigate(id: string, url: string): Promise<void>;
    /**
     * Get current URL
     */
    getUrl(id: string): Promise<string>;
    /**
     * Close a browser instance
     */
    close(id: string): Promise<void>;
    /**
     * Close all browser instances
     */
    closeAll(): Promise<void>;
    /**
     * Get instance by ID
     */
    get(id: string): BrowserInstance | undefined;
    /**
     * Get all instances
     */
    getAll(): BrowserInstance[];
    private describeAction;
}
export default BrowserController;
//# sourceMappingURL=browser-controller.d.ts.map