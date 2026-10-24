/**
 * Typed endpoint paths for the intervals.icu API.
 *
 * Paths are relative to the base URL (`https://intervals.icu/api/v1`). The
 * athlete ID `0` resolves to whoever the API key authenticates as.
 */

export const endpoints = {
  wellness: (athleteId: string) => `/athlete/${athleteId}/wellness`,
  activities: (athleteId: string) => `/athlete/${athleteId}/activities`,
  events: (athleteId: string) => `/athlete/${athleteId}/events`,
  event: (athleteId: string, eventId: number) => `/athlete/${athleteId}/events/${eventId}`,
  athlete: (athleteId: string) => `/athlete/${athleteId}`,
  // Activity-scoped endpoints are not nested under the athlete.
  activityIntervals: (activityId: string) => `/activity/${activityId}/intervals`,
  activityStreams: (activityId: string) => `/activity/${activityId}/streams`,
} as const;

/**
 * Date-range query parameters. intervals.icu names these `oldest`/`newest` and
 * expects yyyy-MM-dd — not ISO datetimes.
 */
export interface DateRange {
  oldest: string;
  newest: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function assertDateRange(range: DateRange): void {
  for (const [key, value] of Object.entries(range)) {
    if (!DATE_PATTERN.test(value)) {
      throw new Error(`'${key}' must be a yyyy-MM-dd date, got '${value}'`);
    }
  }
  if (range.oldest > range.newest) {
    throw new Error(
      `'oldest' (${range.oldest}) must not be after 'newest' (${range.newest})`,
    );
  }
}
