#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  TextContent,
} from '@modelcontextprotocol/sdk/types.js';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const VERSION = '0.1.0';

/**
 * Execute a clawdbot CLI command
 */
async function runClawdbot(args: string[], timeout = 60000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('clawdbot', args, {
      timeout,
      env: { ...process.env, NO_COLOR: '1' },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0 || stdout.length > 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`clawdbot exited with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Clawdbot MCP Server
 *
 * Exposes Clawdbot capabilities as MCP tools for Claude Code / Strawberry Terminal
 */
class ClawdbotMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'clawdbot-mcp',
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
          name: 'clawdbot_status',
          description: 'Get Clawdbot status including gateway health, channels, and sessions',
          inputSchema: {
            type: 'object',
            properties: {
              deep: {
                type: 'boolean',
                description: 'Include deep probe for channel connectivity (slower)',
              },
            },
          },
        },
        {
          name: 'clawdbot_send_message',
          description: 'Send a message via Clawdbot to WhatsApp, Telegram, Slack, Discord, or other channels',
          inputSchema: {
            type: 'object',
            properties: {
              channel: {
                type: 'string',
                enum: ['whatsapp', 'telegram', 'slack', 'discord', 'signal', 'imessage'],
                description: 'Channel to send through',
              },
              target: {
                type: 'string',
                description: 'Target (phone number with +, @username, #channel, etc.)',
              },
              message: {
                type: 'string',
                description: 'Message text to send',
              },
            },
            required: ['channel', 'target', 'message'],
          },
        },
        {
          name: 'clawdbot_agent',
          description: 'Run an agent turn through Clawdbot - ask the AI assistant to do something',
          inputSchema: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description: 'Message/task for the Clawdbot agent',
              },
              session_id: {
                type: 'string',
                description: 'Optional session ID for context continuity',
              },
              thinking: {
                type: 'string',
                enum: ['off', 'minimal', 'low', 'medium', 'high'],
                description: 'Thinking/reasoning depth',
              },
              deliver: {
                type: 'boolean',
                description: 'Whether to deliver the response to a messaging channel',
              },
              reply_channel: {
                type: 'string',
                description: 'Override delivery channel',
              },
              reply_to: {
                type: 'string',
                description: 'Override delivery target',
              },
            },
            required: ['message'],
          },
        },
        {
          name: 'clawdbot_gateway_call',
          description: 'Call a Gateway RPC method directly',
          inputSchema: {
            type: 'object',
            properties: {
              method: {
                type: 'string',
                description: 'RPC method name (health, status, system-presence, cron.*, etc.)',
              },
              params: {
                type: 'object',
                description: 'JSON parameters for the method',
              },
            },
            required: ['method'],
          },
        },
        {
          name: 'clawdbot_skills_list',
          description: 'List available Clawdbot skills (capabilities like GitHub, Notion, browser, etc.)',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'clawdbot_memory_search',
          description: 'Search Clawdbot memory for past interactions and context',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query',
              },
              limit: {
                type: 'number',
                description: 'Maximum results to return',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'clawdbot_sessions',
          description: 'List stored conversation sessions',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Maximum sessions to return',
              },
            },
          },
        },
        {
          name: 'clawdbot_browser',
          description: 'Control Clawdbot dedicated browser for web automation',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['status', 'start', 'stop', 'screenshot'],
                description: 'Browser action to perform',
              },
            },
            required: ['action'],
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
          case 'clawdbot_status': {
            const cmdArgs = ['status'];
            if (args?.deep) cmdArgs.push('--deep');
            const result = await runClawdbot(cmdArgs);
            return this.textResult(result.stdout || result.stderr);
          }

          case 'clawdbot_send_message': {
            const { channel, target, message } = args as {
              channel: string;
              target: string;
              message: string;
            };
            const result = await runClawdbot([
              'message',
              'send',
              '--channel',
              channel,
              '--target',
              target,
              '--message',
              message,
              '--json',
            ]);
            return this.textResult(result.stdout || result.stderr);
          }

          case 'clawdbot_agent': {
            const { message, session_id, thinking, deliver, reply_channel, reply_to } = args as {
              message: string;
              session_id?: string;
              thinking?: string;
              deliver?: boolean;
              reply_channel?: string;
              reply_to?: string;
            };
            const cmdArgs = ['agent', '--message', message, '--json'];
            if (session_id) cmdArgs.push('--session-id', session_id);
            if (thinking) cmdArgs.push('--thinking', thinking);
            if (deliver) cmdArgs.push('--deliver');
            if (reply_channel) cmdArgs.push('--reply-channel', reply_channel);
            if (reply_to) cmdArgs.push('--reply-to', reply_to);

            const result = await runClawdbot(cmdArgs, 300000); // 5 min timeout for agent
            return this.textResult(result.stdout || result.stderr);
          }

          case 'clawdbot_gateway_call': {
            const { method, params } = args as { method: string; params?: object };
            const cmdArgs = ['gateway', 'call', method, '--json'];
            if (params) cmdArgs.push('--params', JSON.stringify(params));
            const result = await runClawdbot(cmdArgs);
            return this.textResult(result.stdout || result.stderr);
          }

          case 'clawdbot_skills_list': {
            const result = await runClawdbot(['skills', 'list']);
            return this.textResult(result.stdout || result.stderr);
          }

          case 'clawdbot_memory_search': {
            const { query, limit } = args as { query: string; limit?: number };
            const cmdArgs = ['memory', 'search', query];
            if (limit) cmdArgs.push('--limit', String(limit));
            const result = await runClawdbot(cmdArgs);
            return this.textResult(result.stdout || result.stderr);
          }

          case 'clawdbot_sessions': {
            const { limit } = args as { limit?: number };
            const cmdArgs = ['sessions'];
            if (limit) cmdArgs.push('--limit', String(limit));
            const result = await runClawdbot(cmdArgs);
            return this.textResult(result.stdout || result.stderr);
          }

          case 'clawdbot_browser': {
            const { action } = args as { action: string };
            const result = await runClawdbot(['browser', action]);
            return this.textResult(result.stdout || result.stderr);
          }

          default:
            return this.textResult(`Unknown tool: ${name}`);
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return this.textResult(`Error: ${errMsg}`);
      }
    });
  }

  private textResult(text: string): { content: TextContent[] } {
    return {
      content: [{ type: 'text', text }],
    };
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('[clawdbot-mcp] Server running');
  }
}

const server = new ClawdbotMCPServer();
server.run().catch(console.error);
