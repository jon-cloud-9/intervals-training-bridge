/**
 * `get_training_context` — read-only.
 *
 * Fetches wellness, completed activities and planned events for a date range,
 * runs `weekDiff` over the last two, and returns a compact summary for Claude
 * to reason over. It draws no conclusions and makes no recommendations: the
 * training reasoning lives in the Project's instructions and context documents,
 * not here.
 */
import { z } from 'zod';
import { getLogger } from '../logger.js';
import type { Activity, CalendarEvent, WellnessRecord } from '../intervals/types.js';
import { weekDiff, type MatchedEntry, type PlannedEntry } from '../state/weekDiff.js';
import { errorResult, jsonResult, type ToolContext, type ToolDefinition } from './types.js';

const log = getLogger('tools.get_training_context');

const inputSchema = {
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Start of the range, yyyy-MM-dd'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('End of the range, inclusive, yyyy-MM-dd'),
};

/** Metres per second to min/km, as "m:ss". */
function paceFromSpeed(metresPerSecond: number | undefined): string | undefined {
  if (!metresPerSecond || metresPerSecond <= 0) return undefined;
  const secondsPerKm = Math.round(1000 / metresPerSecond);
  return `${Math.floor(secondsPerKm / 60)}:${String(secondsPerKm % 60).padStart(2, '0')}`;
}

/**
 * Pick the most recent *actual* wellness record, not the most recent record.
 *
 * intervals.icu populates `ctl`/`atl` as a forward projection on every future
 * date in the requested range — observed against the live API, where a range
 * extending a week past today returned real wellness (resting HR, HRV, sleep)
 * only up to today, then blank-but-`ctl`-populated rows for every day after.
 * Filtering on "has a ctl value" therefore prefers a future forecast row over
 * today's real one whenever the caller's endDate is in the future — which
 * `get_training_context` explicitly allows, since callers reasonably ask for
 * "this week" including days not yet arrived.
 *
 * `today` is threaded in rather than read from the clock here so this stays
 * testable without mocking time; the live caller passes the real date.
 */
function summariseWellness(records: WellnessRecord[], today: string) {
  const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id));
  const upToToday = sorted.filter((record) => record.id <= today);
  const latest = upToToday.at(-1) ?? sorted.at(-1);
  if (!latest) return null;

  const ctl = latest.ctl ?? 0;
  const atl = latest.atl ?? 0;

  return {
    date: latest.id,
    fitnessCtl: round(ctl),
    fatigueAtl: round(atl),
    // intervals.icu calls CTL minus ATL "form".
    form: round(ctl - atl),
    restingHr: latest.restingHR,
    hrv: latest.hrv,
    sleepHours: latest.sleepSecs ? round(latest.sleepSecs / 3600) : undefined,
    // Subjective scores are 1 (best) to 4 (worst) on intervals.icu's scale.
    fatigueScore: latest.fatigue,
    sorenessScore: latest.soreness,
    stressScore: latest.stress,
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function summariseActivity(activity: Activity) {
  return {
    id: activity.id,
    date: activity.start_date_local.slice(0, 10),
    sport: activity.type,
    name: activity.name,
    durationMinutes: activity.moving_time ? Math.round(activity.moving_time / 60) : undefined,
    distanceKm: activity.distance ? round(activity.distance / 1000) : undefined,
    averagePace: paceFromSpeed(activity.average_speed),
    averageHr: activity.average_heartrate,
    averageWatts: activity.icu_average_watts,
    trainingLoad: activity.icu_training_load,
  };
}

function summariseEvent(event: CalendarEvent) {
  return {
    // Needed to call update_workout or delete_workout on this session.
    eventId: event.id,
    date: event.start_date_local.slice(0, 10),
    sport: event.type,
    name: event.name,
    plannedMinutes: event.moving_time ? Math.round(event.moving_time / 60) : undefined,
    plannedDistanceKm: event.distance ? round(event.distance / 1000) : undefined,
    description: event.description,
  };
}

function summarisePlanned(entry: PlannedEntry) {
  return summariseEvent(entry.event);
}

function summariseMatched(entry: MatchedEntry) {
  return {
    planned: summariseEvent(entry.event),
    actual: summariseActivity(entry.activity),
    ...(entry.reasons.length > 0 ? { differences: entry.reasons } : {}),
  };
}

export const getTrainingContextTool: ToolDefinition = {
  name: 'get_training_context',

  register(server, context: ToolContext) {
    server.registerTool(
      'get_training_context',
      {
        title: 'Get training context',
        description:
          'Read-only. Returns current wellness (CTL/ATL/form, resting HR, HRV, sleep), ' +
          'completed activities, planned calendar events, and a reconciliation of planned ' +
          'versus completed for the given date range. Call this before drafting or ' +
          'adjusting a week. Planned events include an eventId for use with update_workout ' +
          'and delete_workout.',
        inputSchema,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ startDate, endDate }) => {
        const range = { oldest: startDate, newest: endDate };
        log.info('fetching training context', range);

        try {
          const [wellness, activities, events] = await Promise.all([
            context.client.getWellness(range),
            context.client.getWeekActivities(range),
            context.client.getWeekEvents(range),
          ]);

          const diff = weekDiff(events, activities);
          const today = new Date().toISOString().slice(0, 10);

          return jsonResult({
            range: { startDate, endDate },
            wellness: summariseWellness(wellness ?? [], today),
            plannedVsCompleted: {
              untouched: diff.untouched.map(summarisePlanned),
              completedAsPlanned: diff.completedAsPlanned.map(summariseMatched),
              completedDifferently: diff.completedDifferently.map(summariseMatched),
              unplannedExtra: diff.unplannedExtra.map(summariseActivity),
            },
            totals: {
              plannedSessions: events.length,
              completedActivities: activities.length,
            },
          });
        } catch (error) {
          log.error('failed to fetch training context', { message: String(error) });
          return errorResult('Could not fetch training context', String(error));
        }
      },
    );
  },
};
