/**
 * `update_workout` — replaces an existing planned event.
 *
 * `dryRun` defaults to true, for the same reason as `push_workout`.
 */
import { z } from 'zod';
import { getLogger } from '../logger.js';
import { structuredWorkoutSchema } from '../workout/schema.js';
import { toIntervalsFormat, toWorkoutDescription } from '../workout/toIntervalsFormat.js';
import { WorkoutValidationError, assertValidWorkout } from '../workout/validate.js';
import { dryRunField } from './pushWorkout.js';
import { errorResult, jsonResult, type ToolContext, type ToolDefinition } from './types.js';

const log = getLogger('tools.update_workout');

const inputSchema = {
  eventId: z
    .number()
    .int()
    .describe('The intervals.icu event id, as returned by get_training_context.'),
  workout: structuredWorkoutSchema.describe('The replacement workout.'),
  dryRun: dryRunField,
};

export const updateWorkoutTool: ToolDefinition = {
  name: 'update_workout',

  register(server, context: ToolContext) {
    server.registerTool(
      'update_workout',
      {
        title: 'Update planned workout',
        description:
          'Replaces an existing planned workout on the intervals.icu calendar. ' +
          'Defaults to a dry run that returns the payload without writing anything. ' +
          'Set dryRun to false only with explicit user approval.',
        inputSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async ({ eventId, workout, dryRun }) => {
        try {
          assertValidWorkout(workout, context.limits);
        } catch (error) {
          if (error instanceof WorkoutValidationError) {
            log.warn('workout rejected by validation', { eventId, errors: error.errors });
            return errorResult('Workout failed validation', error.errors);
          }
          throw error;
        }

        const payload = toIntervalsFormat(workout);

        if (dryRun) {
          log.info('dry run: would update workout', { eventId, name: payload.name });
          return jsonResult({
            dryRun: true,
            eventId,
            wouldReplaceWith: payload,
            renderedWorkout: toWorkoutDescription(workout),
          });
        }

        try {
          const updated = await context.client.updateWorkout(eventId, payload);
          return jsonResult({
            dryRun: false,
            updated: {
              eventId: updated?.id ?? eventId,
              date: payload.start_date_local.slice(0, 10),
              name: payload.name,
            },
          });
        } catch (error) {
          log.error('failed to update workout', { eventId, message: String(error) });
          return errorResult('Could not update the workout', String(error));
        }
      },
    );
  },
};
