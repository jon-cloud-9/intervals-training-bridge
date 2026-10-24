/**
 * Tool registry.
 *
 * Four tools, deliberately: one read and three writes. `weekDiff` is folded into
 * `get_training_context` rather than exposed separately, which keeps the surface
 * small and the reasoning in the Project rather than in the tool list.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getLogger } from '../logger.js';
import { deleteWorkoutTool } from './deleteWorkout.js';
import { getActivityLapsTool } from './getActivityLaps.js';
import { getActivityStreamsTool } from './getActivityStreams.js';
import { getTrainingContextTool } from './getTrainingContext.js';
import { pushWorkoutTool } from './pushWorkout.js';
import { updateWorkoutTool } from './updateWorkout.js';
import type { ToolContext, ToolDefinition } from './types.js';

const log = getLogger('tools');

export const tools: ToolDefinition[] = [
  getTrainingContextTool,
  getActivityLapsTool,
  getActivityStreamsTool,
  pushWorkoutTool,
  updateWorkoutTool,
  deleteWorkoutTool,
];

export function registerTools(server: McpServer, context: ToolContext): void {
  for (const tool of tools) {
    tool.register(server, context);
    log.debug('registered tool', { name: tool.name });
  }
  log.info('registered tools', { count: tools.length, names: tools.map((t) => t.name) });
}

export type { ToolContext, ToolDefinition };
