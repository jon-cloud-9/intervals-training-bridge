/**
 * `get_activity_streams` — read-only, aggregated time-series for one activity.
 *
 * Always bucketed, never raw. intervals.icu returns roughly one sample per
 * second: a 20-minute run is about 1,200 samples across 11 streams, and a five-hour
 * ride is around 18,000. Returning that would flood the context window and
 * bury the signal it was fetched for.
 *
 * Bucketing is what makes the analysis this project exists to support possible
 * — "power fell from 180W to 140W late in a long ride while heart rate stayed
 * flat" is a per-kilometre comparison, not a per-sample one.
 */
import { z } from 'zod';
import { getLogger } from '../logger.js';
import { bucketStreams, type BucketOptions } from '../analysis/bucketStreams.js';
import { errorResult, jsonResult, type ToolContext, type ToolDefinition } from './types.js';

const log = getLogger('tools.get_activity_streams');

const inputSchema = {
  activityId: z
    .string()
    .min(1)
    .describe('The intervals.icu activity id, e.g. "i1000001", from get_training_context.'),
  bucketBy: z
    .enum(['km', 'time'])
    .default('km')
    .describe(
      'How to aggregate. "km" gives one row per kilometre (best for runs and rides, and for ' +
        'locating where output changed). "time" gives fixed windows, better for indoor or ' +
        'non-distance sessions.',
    ),
  minutes: z
    .number()
    .int()
    .min(1)
    .max(60)
    .default(5)
    .describe('Window size in minutes. Only used when bucketBy is "time".'),
};

export const getActivityStreamsTool: ToolDefinition = {
  name: 'get_activity_streams',

  register(server, context: ToolContext) {
    server.registerTool(
      'get_activity_streams',
      {
        title: 'Get activity streams (aggregated)',
        description:
          'Read-only. Time-series data for one activity, aggregated into buckets (per kilometre ' +
          'by default) with min/average/max per metric. Use when you need to see how effort ' +
          'changed across a session — for example whether power fell while heart rate stayed ' +
          'flat, which distinguishes fuelling or fatigue from a pacing decision. Returns ' +
          'aggregates, never raw samples.',
        inputSchema,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ activityId, bucketBy, minutes }) => {
        log.info('fetching streams', { activityId, bucketBy, minutes });

        try {
          const streams = await context.client.getActivityStreams(activityId);

          if (streams.length === 0) {
            return jsonResult({
              activityId,
              buckets: [],
              note: 'No stream data available for this activity.',
            });
          }

          const options: BucketOptions =
            bucketBy === 'time' ? { bucketBy: 'time', minutes } : { bucketBy: 'km' };
          const result = bucketStreams(streams, options);

          return jsonResult({
            activityId,
            bucketedBy: bucketBy === 'time' ? `${minutes} min` : 'kilometre',
            availableStreams: streams.map((s) => s.type),
            // Shows how much was collapsed, so the aggregation is visible rather
            // than silently standing in for the full data.
            rawSampleCount: result.sampleCount,
            bucketCount: result.buckets.length,
            ...(result.note ? { note: result.note } : {}),
            buckets: result.buckets,
          });
        } catch (error) {
          log.error('failed to fetch streams', { activityId, message: String(error) });
          return errorResult('Could not fetch activity streams', String(error));
        }
      },
    );
  },
};
