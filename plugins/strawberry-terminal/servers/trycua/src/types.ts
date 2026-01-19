/**
 * TryCua MCP Server Types
 */

export type VMStatus =
  | 'spawning'
  | 'setting_up'
  | 'ready'
  | 'working'
  | 'idle'
  | 'error'
  | 'stopped';

export type OSType = 'macos' | 'linux' | 'windows';

export type VMRegion = 'north-america' | 'europe' | 'asia-pacific' | 'south-america';
export type VMSize = 'small' | 'medium' | 'large';

/**
 * VM resource specifications based on size
 */
export interface VMResources {
  size: VMSize;
  ram: string;      // e.g., "2GB"
  ramMB: number;    // e.g., 2048
  cpu: number;      // vCPU count
  storage: string;  // e.g., "20GB"
}

/**
 * Resource specs by VM size (TryCua Cloud - updated Jan 2026)
 * See: https://cua.ai/docs
 */
export const VM_SIZE_SPECS: Record<VMSize, VMResources> = {
  small: { size: 'small', ram: '4GB', ramMB: 4096, cpu: 1, storage: '20GB' },
  medium: { size: 'medium', ram: '8GB', ramMB: 8192, cpu: 2, storage: '40GB' },
  large: { size: 'large', ram: '32GB', ramMB: 32768, cpu: 8, storage: '80GB' },
};

export interface VMConfig {
  name: string;
  osType?: OSType;
  region?: VMRegion;
  size?: VMSize;
  tags?: string[];
  setupChrome?: boolean;
  installClaudeExtension?: boolean;
  systemPrompt?: string;
}

export interface VM {
  id: string;
  name: string;
  osType: OSType;
  status: VMStatus;
  tags: string[];
  size: VMSize;
  resources: VMResources;
  region?: VMRegion;
  createdAt: Date;
  lastActivity?: Date;
  currentTask?: string;
  screenshotB64?: string;
  reasoning?: string;
  lastAction?: string;
}

export interface Screenshot {
  vmId: string;
  imageB64: string;
  timestamp: Date;
  reasoning?: string;
  lastAction?: string;
}

export interface TaskResult {
  vmId: string;
  task: string;
  success: boolean;
  output: string;
  screenshots: Screenshot[];
  duration: number;
  error?: string;
}

export interface ComputerAction {
  type: 'click' | 'type' | 'scroll' | 'screenshot' | 'key' | 'move';
  x?: number;
  y?: number;
  text?: string;
  button?: 'left' | 'right' | 'middle';
  key?: string;
  direction?: 'up' | 'down';
  amount?: number;
}
