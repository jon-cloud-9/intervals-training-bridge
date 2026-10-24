/**
 * `push_workout` — creates a planned workout on the intervals.icu calendar.
 *
 * `dryRun` defaults to **true**. This server writes to a calendar that may sync to
 * Garmin Connect and onward to a physical watch, so touching the real calendar
 * requires saying so explicitly. A dry run validates, emits the DSL, and returns
 * the exact payload that would have been sent.
 */
import { z } from 'zod';
import { getLogger } from '../logger.js';
import { structuredWorkoutSchema } from '../workout/schema.js';
import { toIntervalsFormat, toWorkoutDescription } from '../workout/toIntervalsFormat.js';
import { WorkoutValidationError, assertValidWorkout } from '../workout/validate.js';
import { errorResult, jsonResult, type ToolContext, type ToolDefinition } from './types.js';

const log = getLogger('tools.push_workout');

export const dryRunField = z
  .boolean()
  .default(true)
  .describe(
    'When true (the default) nothing is written: the validated payload is returned ' +
      'for review. Pass false only after the user has explicitly approved writing to ' +
      'the real calendar, which may sync to their watch.',
  );

const inputSchema = {
  workout: structuredWorkoutSchema.describe(
    'The workout to create. Steps are prescribed in one metric family: pace for runs, ' +
      'power for bike sessions.',
  ),
  dryRun: dryRunField,
};

export const pushWorkoutTool: ToolDefinition = {
  name: 'push_workout',

  register(server, context: ToolContext) {
    server.registerTool(
      'push_workout',
      {
        title: 'Push workout to calendar',
        description:
          'Creates a planned workout on the intervals.icu calendar for a given date. ' +
          'Defaults to a dry run that returns the payload without writing anything. ' +
          'Set dryRun to false only with explicit user approval.',
        inputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async ({ workout, dryRun }) => {
        try {
          assertValidWorkout(workout, context.limits);
        } catch (error) {
          if (error instanceof WorkoutValidationError) {
            log.warn('workout rejected by validation', { name: workout.name, errors: error.errors });
            return errorResult('Workout failed validation', error.errors);
          }
          throw error;
        }

        const payload = toIntervalsFormat(workout);

        if (dryRun) {
          log.info('dry run: would create workout', {
            date: payload.start_date_local,
            name: payload.name,
          });
          return jsonResult({
            dryRun: true,
            wouldCreate: payload,
            renderedWorkout: toWorkoutDescription(workout),
          });
        }

        try {
          const created = await context.client.createWorkout(payload);
          return jsonResult({
            dryRun: false,
            created: {
              eventId: created?.id,
              date: payload.start_date_local.slice(0, 10),
              name: payload.name,
            },
          });
        } catch (error) {
          log.error('failed to create workout', { name: payload.name, message: String(error) });
          return errorResult('Could not create the workout', String(error));
        }
      },
    );
  },
};
