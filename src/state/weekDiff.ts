/**
 * Planned vs. completed reconciliation.
 *
 * A pure function, per the source plan's own recommendation (open question 3):
 * `get_training_context` calls it rather than exposing it as its own tool, which
 * keeps the tool surface at four and makes the logic trivially testable.
 *
 * No I/O, no clock, no config. Everything it needs arrives as arguments so the
 * same inputs always produce the same output.
 */
import type { Activity, CalendarEvent } from '../intervals/types.js';

export interface Tolerances {
  /** Fractional drift in moving time before a session counts as different. */
  durationPct: number;
  /** Fractional drift in distance before a session counts as different. */
  distancePct: number;
}

export const DEFAULT_TOLERANCES: Tolerances = {
  durationPct: 0.2,
  distancePct: 0.2,
};

export interface PlannedEntry {
  event: CalendarEvent;
  date: string;
  sport: string;
}

export interface MatchedEntry extends PlannedEntry {
  activity: Activity;
  /** Why it was judged to diverge. Empty when completed as planned. */
  reasons: string[];
}

export interface WeekDiff {
  /** Planned, with no matching activity. */
  untouched: PlannedEntry[];
  /** Planned and done within tolerance. */
  completedAsPlanned: MatchedEntry[];
  /** Planned and done, but materially different. */
  completedDifferently: MatchedEntry[];
  /** Done with nothing planned to match it. */
  unplannedExtra: Activity[];
}

/** intervals.icu returns local datetimes; the calendar day is the first ten chars. */
export function localDate(value: string): string {
  return value.slice(0, 10);
}

function sportOf(value: string | undefined): string {
  return (value ?? 'Unknown').toLowerCase();
}

/**
 * Reconcile a week's plan against what was actually recorded.
 *
 * Matching is on calendar date and sport, except where intervals.icu has
 * already paired an activity to an event itself — `paired_event_id` is a
 * stronger signal than anything we can infer, so it wins even across a date or
 * sport boundary.
 *
 * A session moved to a different day shows up as the original day `untouched`
 * plus an `unplannedExtra` on the day it was actually done. That is the honest
 * reading of the four categories: nothing was done on the planned day, and
 * something was done that was not planned.
 */
export function weekDiff(
  planned: CalendarEvent[],
  completed: Activity[],
  tolerances: Tolerances = DEFAULT_TOLERANCES,
): WeekDiff {
  const diff: WeekDiff = {
    untouched: [],
    completedAsPlanned: [],
    completedDifferently: [],
    unplannedExtra: [],
  };

  const unconsumed = new Set(completed);

  // Deterministic order regardless of how the API returned them.
  const plannedInOrder = [...planned].sort((a, b) =>
    a.start_date_local === b.start_date_local
      ? a.id - b.id
      : a.start_date_local.localeCompare(b.start_date_local),
  );

  for (const event of plannedInOrder) {
    const entry: PlannedEntry = {
      event,
      date: localDate(event.start_date_local),
      sport: sportOf(event.type),
    };

    const activity = findMatch(event, entry, unconsumed);

    if (!activity) {
      diff.untouched.push(entry);
      continue;
    }

    unconsumed.delete(activity);
    const reasons = compare(event, activity, tolerances);
    const matched: MatchedEntry = { ...entry, activity, reasons };

    if (reasons.length === 0) {
      diff.completedAsPlanned.push(matched);
    } else {
      diff.completedDifferently.push(matched);
    }
  }

  diff.unplannedExtra = completed
    .filter((activity) => unconsumed.has(activity))
    .sort((a, b) => a.start_date_local.localeCompare(b.start_date_local));

  return diff;
}

/**
 * Prefer intervals.icu's own pairing. Failing that, take the same-day,
 * same-sport activity closest in duration, so that two runs on one planned day
 * pair up predictably rather than by array order.
 */
function findMatch(
  event: CalendarEvent,
  entry: PlannedEntry,
  pool: Set<Activity>,
): Activity | undefined {
  for (const activity of pool) {
    if (activity.paired_event_id === event.id) return activity;
  }

  const candidates = [...pool].filter(
    (activity) =>
      localDate(activity.start_date_local) === entry.date &&
      sportOf(activity.type) === entry.sport,
  );
  if (candidates.length === 0) return undefined;

  const target = event.moving_time;
  if (target === undefined) return candidates[0];

  return candidates.reduce((best, activity) => {
    const bestGap = Math.abs((best.moving_time ?? 0) - target);
    const gap = Math.abs((activity.moving_time ?? 0) - target);
    return gap < bestGap ? activity : best;
  }, candidates[0]!);
}

/**
 * Reasons the completed session diverges from the plan. An empty array means
 * it counts as completed as planned.
 *
 * When the plan carries no comparable figure — a distance-prescribed session
 * with no `moving_time`, say — there is nothing to diverge from, so it is
 * treated as completed rather than guessed at.
 */
function compare(
  event: CalendarEvent,
  activity: Activity,
  tolerances: Tolerances,
): string[] {
  const reasons: string[] = [];

  if (sportOf(event.type) !== sportOf(activity.type)) {
    reasons.push(`sport differs: planned ${event.type ?? 'unknown'}, did ${activity.type}`);
  }

  if (localDate(event.start_date_local) !== localDate(activity.start_date_local)) {
    reasons.push(
      `day differs: planned ${localDate(event.start_date_local)}, ` +
        `did ${localDate(activity.start_date_local)}`,
    );
  }

  drift('duration', event.moving_time, activity.moving_time, tolerances.durationPct, reasons);
  drift('distance', event.distance, activity.distance, tolerances.distancePct, reasons);

  return reasons;
}

function drift(
  label: string,
  planned: number | undefined,
  actual: number | undefined,
  tolerance: number,
  reasons: string[],
): void {
  if (planned === undefined || actual === undefined || planned <= 0) return;

  const ratio = (actual - planned) / planned;
  if (Math.abs(ratio) <= tolerance) return;

  const direction = ratio > 0 ? 'longer' : 'shorter';
  reasons.push(`${label} ${Math.round(Math.abs(ratio) * 100)}% ${direction} than planned`);
}
