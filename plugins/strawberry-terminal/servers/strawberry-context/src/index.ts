#!/usr/bin/env node
/**
 * Strawberry Context MCP Server
 *
 * This MCP server enables bidirectional context sync between Claude Code and the Strawberry TUI.
 *
 * Claude Code MUST call `strawberry_sync` after every significant action to keep the TUI updated.
 * The TUI watches the state file and updates its sidebar accordingly.
 *
 * State flow:
 *   Claude Code → strawberry_sync() → /tmp/strawberry-state.json → Strawberry TUI
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  TextContent,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';

const VERSION = '0.2.0';
const STATE_FILE = '/tmp/strawberry-state.json';
const EVENTS_FILE = '/tmp/strawberry-events.jsonl';
const MOLTBOT_MASTER_URL = 'https://moltbot-master.liam-939.workers.dev';

// Context event from Moltbot Master
interface MoltbotContextEvent {
  id: string;
  type: 'message' | 'task_complete' | 'vps_action' | 'error' | 'status_change';
  source: 'telegram' | 'imessage' | 'vps' | 'master' | 'macbook';
  summary: string;
  details?: any;
  timestamp: string;
}

// State shape that Claude reports
interface StrawberryState {
  timestamp: string;

  // Current activity
  phase: 'thinking' | 'tool_use' | 'responding' | 'idle' | 'waiting';
  currentAction?: string;
  currentTool?: string;

  // Todos from Claude's TodoWrite
  todos: Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
  }>;

  // Recent tool calls
  recentTools: Array<{
    name: string;
    target?: string;
    status: 'running' | 'completed' | 'error';
    timestamp: string;
  }>;

  // Context summary
  context?: string;

  // Session info
  sessionId?: string;
  workingDirectory?: string;

  // Initialization steps (bootstrap progress for MCP servers, VMs, etc.)
  initializationSteps?: Array<{
    id: string;
    name: string;
    description?: string;
    status: 'pending' | 'in_progress' | 'completed' | 'error';
    error?: string;
    startedAt?: string;
    completedAt?: string;
  }>;

  // VM/agent info (if any active)
  activeVMs?: Array<{
    id: string;
    name: string;
    status: string;
  }>;

  activeAgents?: Array<{
    id: string;
    name: string;
    task: string;
  }>;

  // Moltbot instances on Cloudflare (from moltworker-mcp)
  activeMoltbots?: Array<{
    id: string;
    name: string;
    purpose: string;
    status: 'unknown' | 'healthy' | 'starting' | 'error' | 'not_deployed';
    url?: string;
  }>;

  // AI Gateway configuration
  aiGateway?: {
    configured: boolean;
    baseUrl?: string;
    lastUpdate?: string;
  };
}

/**
 * Write state to file for TUI to read
 */
function writeState(state: StrawberryState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('[strawberry-context] Failed to write state:', error);
  }
}

/**
 * Append event to events file for history tracking
 */
function appendEvent(event: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ ...event, timestamp: new Date().toISOString() }) + '\n';
    fs.appendFileSync(EVENTS_FILE, line);
  } catch {
    // Ignore errors - non-critical
  }
}

/**
 * Read current state from file
 */
function readState(): StrawberryState | null {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const content = fs.readFileSync(STATE_FILE, 'utf8');
      return JSON.parse(content);
    }
  } catch {
    // Return null on error
  }
  return null;
}

class StrawberryContextServer {
  private server: Server;
  private state: StrawberryState;

  constructor() {
    // Initialize default state
    this.state = {
      timestamp: new Date().toISOString(),
      phase: 'idle',
      todos: [],
      recentTools: [],
    };

    this.server = new Server(
      {
        name: 'strawberry-context',
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  private setupToolHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = [
        {
          name: 'strawberry_sync',
          description: `CRITICAL: You MUST call this tool after EVERY significant action to keep the Strawberry TUI sidebar updated.

Call this after:
- Completing a tool call
- Updating your todo list
- Starting/finishing a task phase
- Any state change the user should see

This enables real-time progress tracking in the terminal sidebar.`,
          inputSchema: {
            type: 'object',
            properties: {
              phase: {
                type: 'string',
                enum: ['thinking', 'tool_use', 'responding', 'idle', 'waiting'],
                description: 'Current phase of operation',
              },
              current_action: {
                type: 'string',
                description: 'Brief description of what you are currently doing (e.g., "Reading package.json", "Running tests")',
              },
              current_tool: {
                type: 'string',
                description: 'Name of the tool currently being used (if any)',
              },
              todos: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    content: { type: 'string' },
                    status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                  },
                  required: ['content', 'status'],
                },
                description: 'Current todo list state',
              },
              context: {
                type: 'string',
                description: 'Brief context summary for the sidebar (1-2 sentences)',
              },
              tool_completed: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  target: { type: 'string' },
                  status: { type: 'string', enum: ['completed', 'error'] },
                },
                description: 'Info about a tool that just completed',
              },
              active_vms: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    status: { type: 'string' },
                  },
                },
                description: 'Currently active VMs',
              },
              active_agents: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    task: { type: 'string' },
                  },
                },
                description: 'Currently active sub-agents',
              },
              initialization_steps: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'error'] },
                    error: { type: 'string' },
                  },
                  required: ['id', 'name', 'status'],
                },
                description: 'Initialization/bootstrap steps for MCP servers, VMs, etc. Shows progress near MCP server section.',
              },
              active_moltbots: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    purpose: { type: 'string' },
                    status: { type: 'string', enum: ['unknown', 'healthy', 'starting', 'error', 'not_deployed'] },
                    url: { type: 'string' },
                  },
                },
                description: 'Moltbot instances on Cloudflare Workers',
              },
              ai_gateway: {
                type: 'object',
                properties: {
                  configured: { type: 'boolean' },
                  baseUrl: { type: 'string' },
                  lastUpdate: { type: 'string' },
                },
                description: 'AI Gateway configuration status',
              },
            },
            required: ['phase'],
          },
        },
        {
          name: 'strawberry_get_state',
          description: 'Get the current Strawberry TUI state. Useful for checking what the TUI is displaying or resuming context.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'strawberry_notify',
          description: 'Send a notification to the Strawberry TUI that will be displayed prominently. Use for important events.',
          inputSchema: {
            type: 'object',
            properties: {
              level: {
                type: 'string',
                enum: ['info', 'success', 'warning', 'error'],
                description: 'Notification level',
              },
              message: {
                type: 'string',
                description: 'Notification message',
              },
            },
            required: ['level', 'message'],
          },
        },
        {
          name: 'moltbot_context_sync',
          description: `Sync context from the Moltbot Master to see what has happened while you were offline.

This fetches recent events from Telegram, iMessage, VPS tasks, and other activities from the Moltbot swarm.
Call this when starting a session to catch up on what happened.`,
          inputSchema: {
            type: 'object',
            properties: {
              since: {
                type: 'string',
                description: 'ISO timestamp to fetch events since (default: last 24 hours)',
              },
            },
          },
        },
        {
          name: 'moltbot_macbook_register',
          description: `Register this MacBook as online with the Moltbot Master.

This tells the swarm that the MacBook is available for local tasks (iMessage, local files, etc.).
Call this at session start so VPSs know when to delegate work to the MacBook.`,
          inputSchema: {
            type: 'object',
            properties: {
              capabilities: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of capabilities this MacBook provides (e.g., ["imessage", "local-files", "browser"])',
              },
            },
          },
        },
        {
          name: 'moltbot_add_event',
          description: `Add a context event to the Moltbot Master for other instances to see.

Use this to log significant actions so VPSs and future sessions know what happened.`,
          inputSchema: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['message', 'task_complete', 'vps_action', 'error', 'status_change'],
                description: 'Type of event',
              },
              summary: {
                type: 'string',
                description: 'Brief summary of the event',
              },
              details: {
                type: 'object',
                description: 'Additional details about the event',
              },
            },
            required: ['type', 'summary'],
          },
        },
      ];

      return { tools };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'strawberry_sync': {
            // Update state from Claude's report
            const phase = args?.phase as StrawberryState['phase'] || 'idle';
            const currentAction = args?.current_action as string | undefined;
            const currentTool = args?.current_tool as string | undefined;
            const todos = args?.todos as StrawberryState['todos'] | undefined;
            const context = args?.context as string | undefined;
            const toolCompleted = args?.tool_completed as {
              name: string;
              target?: string;
              status: 'completed' | 'error';
            } | undefined;
            const activeVMs = args?.active_vms as StrawberryState['activeVMs'] | undefined;
            const activeAgents = args?.active_agents as StrawberryState['activeAgents'] | undefined;
            const initializationSteps = args?.initialization_steps as StrawberryState['initializationSteps'] | undefined;
            const activeMoltbots = args?.active_moltbots as StrawberryState['activeMoltbots'] | undefined;
            const aiGateway = args?.ai_gateway as StrawberryState['aiGateway'] | undefined;

            // Update recent tools if a tool completed
            if (toolCompleted) {
              this.state.recentTools = [
                {
                  name: toolCompleted.name,
                  target: toolCompleted.target,
                  status: toolCompleted.status,
                  timestamp: new Date().toISOString(),
                },
                ...this.state.recentTools.slice(0, 9), // Keep last 10
              ];
            }

            // If a tool is currently running, add it
            if (currentTool && phase === 'tool_use') {
              // Check if already in recent tools as running
              const existing = this.state.recentTools.find(
                t => t.name === currentTool && t.status === 'running'
              );
              if (!existing) {
                this.state.recentTools = [
                  {
                    name: currentTool,
                    target: currentAction,
                    status: 'running',
                    timestamp: new Date().toISOString(),
                  },
                  ...this.state.recentTools.filter(t => t.status !== 'running').slice(0, 9),
                ];
              }
            }

            // Update state
            this.state = {
              ...this.state,
              timestamp: new Date().toISOString(),
              phase,
              currentAction,
              currentTool: phase === 'tool_use' ? currentTool : undefined,
              todos: todos || this.state.todos,
              context: context || this.state.context,
              activeVMs: activeVMs || this.state.activeVMs,
              activeAgents: activeAgents || this.state.activeAgents,
              initializationSteps: initializationSteps || this.state.initializationSteps,
              activeMoltbots: activeMoltbots || this.state.activeMoltbots,
              aiGateway: aiGateway || this.state.aiGateway,
            };

            // Write to file for TUI
            writeState(this.state);

            // Log event
            appendEvent({
              type: 'sync',
              phase,
              action: currentAction,
              tool: currentTool,
              todosCount: this.state.todos.length,
            });

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: 'State synced to Strawberry TUI',
                    phase,
                    todosCount: this.state.todos.length,
                    activeToolsCount: this.state.recentTools.filter(t => t.status === 'running').length,
                  }, null, 2),
                } as TextContent,
              ],
            };
          }

          case 'strawberry_get_state': {
            const currentState = readState() || this.state;

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(currentState, null, 2),
                } as TextContent,
              ],
            };
          }

          case 'strawberry_notify': {
            const level = args?.level as string;
            const message = args?.message as string;

            appendEvent({
              type: 'notification',
              level,
              message,
            });

            // Also update state with a notification flag
            this.state = {
              ...this.state,
              timestamp: new Date().toISOString(),
            };
            writeState(this.state);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: `Notification sent: [${level}] ${message}`,
                  }, null, 2),
                } as TextContent,
              ],
            };
          }

          case 'moltbot_context_sync': {
            const since = args?.since as string || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

            try {
              const response = await fetch(`${MOLTBOT_MASTER_URL}/context/sync?since=${encodeURIComponent(since)}`);
              if (!response.ok) {
                throw new Error(`Moltbot Master returned ${response.status}`);
              }

              const data = await response.json() as {
                events: MoltbotContextEvent[];
                swarmState: any;
                vpsRegistry: any[];
                timestamp: string;
              };

              // Update local state with swarm info
              if (data.swarmState?.activeMoltbots || data.swarmState?.specialists) {
                this.state.activeMoltbots = Object.entries(data.swarmState.specialists || {}).map(([name, info]: [string, any]) => ({
                  id: name,
                  name,
                  purpose: info.purpose,
                  status: info.status === 'healthy' ? 'healthy' : 'error',
                }));
                writeState(this.state);
              }

              // Log sync event
              appendEvent({
                type: 'moltbot_sync',
                eventsCount: data.events.length,
                vpsCount: data.vpsRegistry?.length || 0,
              });

              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      eventsCount: data.events.length,
                      events: data.events.slice(0, 10), // Return last 10 events
                      swarmState: {
                        specialists: data.swarmState?.specialists ? Object.keys(data.swarmState.specialists) : [],
                        activeVMs: data.swarmState?.activeVMs?.length || 0,
                        pendingTasks: data.swarmState?.pendingTasks?.length || 0,
                      },
                      vpsRegistry: data.vpsRegistry,
                      syncedAt: data.timestamp,
                    }, null, 2),
                  } as TextContent,
                ],
              };
            } catch (error) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: false,
                      error: `Failed to sync with Moltbot Master: ${error instanceof Error ? error.message : String(error)}`,
                    }, null, 2),
                  } as TextContent,
                ],
                isError: true,
              };
            }
          }

          case 'moltbot_macbook_register': {
            const capabilities = args?.capabilities as string[] || ['imessage', 'local-files', 'strawberry-terminal'];

            try {
              const response = await fetch(`${MOLTBOT_MASTER_URL}/macbook/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  capabilities,
                  strawberryVersion: VERSION,
                }),
              });

              if (!response.ok) {
                throw new Error(`Moltbot Master returned ${response.status}`);
              }

              const node = await response.json();

              // Log registration
              appendEvent({
                type: 'macbook_registered',
                capabilities,
              });

              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      message: 'MacBook registered with Moltbot Master',
                      node,
                    }, null, 2),
                  } as TextContent,
                ],
              };
            } catch (error) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: false,
                      error: `Failed to register MacBook: ${error instanceof Error ? error.message : String(error)}`,
                    }, null, 2),
                  } as TextContent,
                ],
                isError: true,
              };
            }
          }

          case 'moltbot_add_event': {
            const eventType = args?.type as string;
            const summary = args?.summary as string;
            const details = args?.details as Record<string, unknown> | undefined;

            try {
              const response = await fetch(`${MOLTBOT_MASTER_URL}/context/event`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  type: eventType,
                  source: 'macbook',
                  summary,
                  details,
                }),
              });

              if (!response.ok) {
                throw new Error(`Moltbot Master returned ${response.status}`);
              }

              const event = await response.json();

              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      message: 'Event added to Moltbot Master',
                      event,
                    }, null, 2),
                  } as TextContent,
                ],
              };
            } catch (error) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: false,
                      error: `Failed to add event: ${error instanceof Error ? error.message : String(error)}`,
                    }, null, 2),
                  } as TextContent,
                ],
                isError: true,
              };
            }
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }, null, 2),
            } as TextContent,
          ],
          isError: true,
        };
      }
    });
  }

  async run(): Promise<void> {
    // Initialize state file
    writeState(this.state);

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`[strawberry-context] MCP server running on stdio (v${VERSION})`);

    // Auto-register MacBook with Moltbot Master
    this.registerMacBook();

    // Start heartbeat (every 2 minutes)
    this.startHeartbeat();
  }

  private async registerMacBook(): Promise<void> {
    try {
      const response = await fetch(`${MOLTBOT_MASTER_URL}/macbook/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capabilities: ['imessage', 'local-files', 'strawberry-terminal', 'clawdbot-local'],
          strawberryVersion: VERSION,
        }),
      });

      if (response.ok) {
        console.error('[strawberry-context] MacBook registered with Moltbot Master');
        appendEvent({ type: 'macbook_auto_registered' });
      }
    } catch (error) {
      console.error('[strawberry-context] Failed to auto-register MacBook:', error);
    }
  }

  private startHeartbeat(): void {
    // Send heartbeat every 2 minutes
    setInterval(async () => {
      try {
        await fetch(`${MOLTBOT_MASTER_URL}/macbook/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
      } catch {
        // Silently ignore heartbeat failures
      }
    }, 2 * 60 * 1000);
  }
}

// Main entry point
const server = new StrawberryContextServer();

process.on('SIGINT', () => {
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

server.run().catch((error) => {
  console.error('[strawberry-context] Fatal error:', error);
  process.exit(1);
});
