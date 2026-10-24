/**
 * `delete_workout` — removes a planned event.
 *
 * `dryRun` defaults to true. Deletion is irreversible through this API, so the
 * default matters more here than anywhere else.
 */
import { z } from 'zod';
import { getLogger } from '../logger.js';
import { dryRunField } from './pushWorkout.js';
import { errorResult, jsonResult, type ToolContext, type ToolDefinition } from './types.js';

const log = getLogger('tools.delete_workout');

const inputSchema = {
  eventId: z
    .number()
    .int()
    .describe('The intervals.icu event id, as returned by get_training_context.'),
  dryRun: dryRunField,
};

export const deleteWorkoutTool: ToolDefinition = {
  name: 'delete_workout',

  register(server, context: ToolContext) {
    server.registerTool(
      'delete_workout',
      {
        title: 'Delete planned workout',
        description:
          'Removes a planned workout from the intervals.icu calendar. Defaults to a dry ' +
          'run that reports what would be deleted without deleting it. Set dryRun to ' +
          'false only with explicit user approval — this cannot be undone.',
        inputSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async ({ eventId, dryRun }) => {
        if (dryRun) {
          log.info('dry run: would delete workout', { eventId });
          return jsonResult({ dryRun: true, wouldDelete: { eventId } });
        }

        try {
          await context.client.deleteWorkout(eventId);
          return jsonResult({ dryRun: false, deleted: { eventId } });
        } catch (error) {
          log.error('failed to delete workout', { eventId, message: String(error) });
          return errorResult('Could not delete the workout', String(error));
        }
      },
    );
  },
};
