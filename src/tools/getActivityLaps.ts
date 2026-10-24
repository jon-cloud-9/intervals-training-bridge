/**
 * `get_activity_laps` — read-only per-lap breakdown of one activity.
 *
 * Summary data conceals within-session variation. A 5k effort can report a
 * single `averageHr: 150`, while its laps actually ran 140/155/160/155/145 —
 * which is both the mid-effort dip and the signature of an unreliable sensor.
 * Neither is visible without this.
 */
import { z } from 'zod';
import { getLogger } from '../logger.js';
import { formatPace } from '../analysis/bucketStreams.js';
import type { ActivityLap } from '../intervals/types.js';
import { errorResult, jsonResult, type ToolContext, type ToolDefinition } from './types.js';

const log = getLogger('tools.get_activity_laps');

const inputSchema = {
  activityId: z
    .string()
    .min(1)
    .describe('The intervals.icu activity id, e.g. "i1000001", from get_training_context.'),
};

function round(value: number | undefined, dp = 1): number | undefined {
  if (value === undefined || value === null) return undefined;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

function summariseLap(lap: ActivityLap, index: number) {
  return {
    lap: index + 1,
    // Watches can emit sub-second RECOVERY blips between laps; surfaced rather than
    // hidden so an artifact is never mistaken for a real interval.
    type: lap.type,
    distanceKm: round((lap.distance ?? 0) / 1000, 2),
    durationSeconds: lap.moving_time,
    pace: formatPace(lap.average_speed),
    averageHr: lap.average_heartrate,
    maxHr: lap.max_heartrate,
    averageWatts: lap.average_watts,
    averageCadence: round(lap.average_cadence),
    // API returns a fraction; percent is the readable form.
    gradientPercent: round((lap.average_gradient ?? 0) * 100, 2),
  };
}

export const getActivityLapsTool: ToolDefinition = {
  name: 'get_activity_laps',

  register(server, context: ToolContext) {
    server.registerTool(
      'get_activity_laps',
      {
        title: 'Get activity laps',
        description:
          'Read-only. Per-lap pace, heart rate, power, cadence and gradient for one activity. ' +
          'Use this instead of the activity summary whenever within-session variation matters ' +
          '— split analysis, mid-effort dips, or checking whether a sensor reading is reliable. ' +
          'Lap type is included because sub-second RECOVERY laps are common artifacts.',
        inputSchema,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ activityId }) => {
        log.info('fetching laps', { activityId });

        try {
          const laps = await context.client.getActivityLaps(activityId);

          if (laps.length === 0) {
            return jsonResult({
              activityId,
              laps: [],
              note: 'No lap data available for this activity.',
            });
          }

          return jsonResult({
            activityId,
            lapCount: laps.length,
            laps: laps.map(summariseLap),
          });
        } catch (error) {
          log.error('failed to fetch laps', { activityId, message: String(error) });
          return errorResult('Could not fetch activity laps', String(error));
        }
      },
    );
  },
};
