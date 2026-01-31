import { EventEmitter } from 'events';
import { VM, VMConfig, VMStatus, Screenshot, TaskResult, ComputerAction } from './types.js';
/**
 * VMManager - Manages Real Windows/macOS/Linux VMs via TryCua Cloud
 *
 * Uses TryCua Cloud API to provision VMs, then connects via SDK.
 * Each VM is a real cloud-hosted machine controlled via WebSocket.
 */
export declare class VMManager extends EventEmitter {
    private vms;
    private heartbeatTimers;
    private maxVms;
    private apiKey;
    private enableMasterRegistration;
    constructor(maxVms?: number);
    /**
     * Register a VM with Moltbot Master for orchestration
     */
    private registerWithMaster;
    /**
     * Send heartbeat to Moltbot Master
     */
    private sendHeartbeat;
    /**
     * Start periodic heartbeat for a VM
     */
    private startHeartbeat;
    /**
     * Stop heartbeat for a VM
     */
    private stopHeartbeat;
    /**
     * Bootstrap a Linux VM for coding tasks
     * Installs Claude Code CLI and plugins via terminal commands
     */
    bootstrapForCoding(vmId: string, anthropicApiKey?: string): Promise<{
        success: boolean;
        message: string;
    }>;
    /**
     * Map our OSType to TryCua's OSType enum
     */
    private mapOSType;
    /**
     * Provision a VM via TryCua Cloud API
     * This creates the actual cloud VM before we can connect to it
     */
    private provisionVM;
    /**
     * Delete a VM via TryCua Cloud API
     */
    private deleteVM;
    /**
     * Spawn a new VM via TryCua Cloud
     */
    spawn(config: VMConfig): Promise<VM>;
    /**
     * Wait for VM's WebSocket server to be ready by testing TCP connectivity
     */
    private waitForVMReady;
    /**
     * Test if WebSocket connection can be established
     */
    private testWebSocketConnection;
    /**
     * Execute a computer action on a VM
     */
    executeAction(vmId: string, action: ComputerAction): Promise<Screenshot>;
    /**
     * Parse a task to extract browser-related actions
     */
    private parseBrowserTask;
    /**
     * Execute a task on a VM (high-level task description)
     * This uses the computer's interface to perform the task step by step
     * Supports automatic Chrome launching and navigation
     */
    executeTask(vmId: string, task: string): Promise<TaskResult>;
    /**
     * Helper to add delay between actions
     */
    private delay;
    /**
     * Get current screenshot from VM
     */
    getScreenshot(vmId: string): Promise<Screenshot>;
    /**
     * Stop a VM - disconnects from SDK and deletes the cloud VM
     */
    stop(vmId: string): Promise<void>;
    /**
     * Stop all VMs
     */
    stopAll(): Promise<void>;
    /**
     * Get VM by ID
     */
    get(vmId: string): VM | undefined;
    /**
     * Get all VMs
     */
    getAll(): VM[];
    /**
     * Get VMs by status
     */
    getByStatus(status: VMStatus): VM[];
    /**
     * Get VMs by tag
     */
    getByTag(tag: string): VM[];
    /**
     * Get all unique tags across all VMs
     */
    getAllTags(): string[];
    /**
     * Add tags to an existing VM
     */
    addTags(vmId: string, tags: string[]): VM | undefined;
    /**
     * Remove tags from an existing VM
     */
    removeTags(vmId: string, tags: string[]): VM | undefined;
    /**
     * Get pool status
     */
    getPoolStatus(): {
        total: number;
        maxVms: number;
        ready: number;
        working: number;
        idle: number;
        error: number;
        hasApiKey: boolean;
    };
    /**
     * Describe a computer action for logging
     */
    private describeAction;
}
export default VMManager;
//# sourceMappingURL=vm-manager.d.ts.map