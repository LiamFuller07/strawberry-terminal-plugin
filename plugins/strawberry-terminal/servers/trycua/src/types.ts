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
