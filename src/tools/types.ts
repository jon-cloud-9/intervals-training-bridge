/**
 * Shared shape for tool modules.
 *
 * Each tool exports a `ToolDefinition`, and `index.ts` registers them all. The
 * dependencies a tool needs arrive in `ToolContext` rather than being imported,
 * so tools can be exercised against a stub client in tests.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IntervalsClient } from '../intervals/client.js';
import type { ValidationLimits } from '../workout/validate.js';

export interface ToolContext {
  client: IntervalsClient;
  limits: ValidationLimits;
}

export interface ToolDefinition {
  name: string;
  register(server: McpServer, context: ToolContext): void;
}

/** Wrap a payload as MCP text content. */
export function jsonResult(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/** Wrap an error as MCP text content flagged as an error. */
export function errorResult(message: string, detail?: unknown) {
  return {
    isError: true as const,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error: message, detail }, null, 2),
      },
    ],
  };
}
