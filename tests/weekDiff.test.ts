import { describe, expect, it } from 'vitest';
import { DEFAULT_TOLERANCES, weekDiff } from '../src/state/weekDiff.js';
import type { Activity, CalendarEvent } from '../src/intervals/types.js';

let nextId = 1;

function event(
  date: string,
  type: string,
  overrides: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id: nextId++,
    start_date_local: `${date}T00:00:00`,
    category: 'WORKOUT',
    type,
    name: `${type} on ${date}`,
    moving_time: 3600,
    ...overrides,
  };
}

function activity(
  date: string,
  type: string,
  overrides: Partial<Activity> = {},
): Activity {
  return {
    id: `a${nextId++}`,
    start_date_local: `${date}T07:30:00`,
    type,
    name: `${type} on ${date}`,
    moving_time: 3600,
    ...overrides,
  };
}

// ── The four categories from the plan ────────────────────────────────────────

describe('untouched', () => {
  it('reports a planned session with no matching activity', () => {
    const planned = event('2026-07-28', 'Run');
    const diff = weekDiff([planned], []);

    expect(diff.untouched.map((e) => e.event.id)).toEqual([planned.id]);
    expect(diff.completedAsPlanned).toEqual([]);
    expect(diff.completedDifferently).toEqual([]);
    expect(diff.unplannedExtra).toEqual([]);
  });

  it('does not match an activity of a different sport on the same day', () => {
    const diff = weekDiff([event('2026-07-28', 'Run')], [activity('2026-07-28', 'Ride')]);

    expect(diff.untouched).toHaveLength(1);
    expect(diff.unplannedExtra).toHaveLength(1);
  });
});

describe('completedAsPlanned', () => {
  it('matches same day, same sport, same duration', () => {
    const diff = weekDiff([event('2026-07-28', 'Run')], [activity('2026-07-28', 'Run')]);

    expect(diff.completedAsPlanned).toHaveLength(1);
    expect(diff.completedAsPlanned[0]!.reasons).toEqual([]);
    expect(diff.untouched).toEqual([]);
    expect(diff.unplannedExtra).toEqual([]);
  });

  it('tolerates drift inside the threshold', () => {
    const diff = weekDiff(
      [event('2026-07-28', 'Run', { moving_time: 3600 })],
      [activity('2026-07-28', 'Run', { moving_time: 3200 })], // 11% short
    );

    expect(diff.completedAsPlanned).toHaveLength(1);
  });

  it('treats a plan with no comparable figures as done rather than guessing', () => {
    const diff = weekDiff(
      [event('2026-07-28', 'Run', { moving_time: undefined })],
      [activity('2026-07-28', 'Run', { moving_time: 2000 })],
    );

    expect(diff.completedAsPlanned).toHaveLength(1);
  });
});

describe('completedDifferently', () => {
  it('flags a materially shorter session', () => {
    const diff = weekDiff(
      [event('2026-07-28', 'Run', { moving_time: 3600 })],
      [activity('2026-07-28', 'Run', { moving_time: 1800 })],
    );

    expect(diff.completedDifferently).toHaveLength(1);
    expect(diff.completedDifferently[0]!.reasons).toContain('duration 50% shorter than planned');
  });

  it('flags a materially longer session', () => {
    const diff = weekDiff(
      [event('2026-07-28', 'Run', { moving_time: 3600 })],
      [activity('2026-07-28', 'Run', { moving_time: 5400 })],
    );

    expect(diff.completedDifferently[0]!.reasons).toContain('duration 50% longer than planned');
  });

  it('flags distance drift independently of duration', () => {
    const diff = weekDiff(
      [event('2026-07-28', 'Run', { moving_time: 3600, distance: 10_000 })],
      [activity('2026-07-28', 'Run', { moving_time: 3600, distance: 6000 })],
    );

    expect(diff.completedDifferently).toHaveLength(1);
    expect(diff.completedDifferently[0]!.reasons).toEqual(['distance 40% shorter than planned']);
  });

  it('flags a sport swap when intervals.icu itself paired the activity', () => {
    const planned = event('2026-07-28', 'Run');
    const diff = weekDiff(
      [planned],
      [activity('2026-07-28', 'Ride', { paired_event_id: planned.id })],
    );

    expect(diff.completedDifferently).toHaveLength(1);
    expect(diff.completedDifferently[0]!.reasons.join()).toMatch(/sport differs/);
    expect(diff.unplannedExtra).toEqual([]);
  });
});

describe('unplannedExtra', () => {
  it('reports a bonus session on an empty day', () => {
    const diff = weekDiff([], [activity('2026-07-30', 'Ride')]);

    expect(diff.unplannedExtra).toHaveLength(1);
    expect(diff.untouched).toEqual([]);
  });

  it('reports a second same-sport session beyond the one planned', () => {
    const diff = weekDiff(
      [event('2026-07-28', 'Run', { moving_time: 3600 })],
      [
        activity('2026-07-28', 'Run', { moving_time: 3600 }),
        activity('2026-07-28', 'Run', { moving_time: 1200 }),
      ],
    );

    expect(diff.completedAsPlanned).toHaveLength(1);
    expect(diff.unplannedExtra).toHaveLength(1);
    expect(diff.unplannedExtra[0]!.moving_time).toBe(1200);
  });
});

// ── Real-world scenarios from the plan ───────────────────────────────────────

describe('scenarios', () => {
  it('missed day: the plan stands, nothing was recorded', () => {
    const diff = weekDiff(
      [event('2026-07-28', 'Run'), event('2026-07-29', 'Ride')],
      [activity('2026-07-29', 'Ride')],
    );

    expect(diff.untouched.map((e) => e.date)).toEqual(['2026-07-28']);
    expect(diff.completedAsPlanned).toHaveLength(1);
  });

  it('swapped days: the planned day is untouched and the day done is unplanned', () => {
    const diff = weekDiff([event('2026-07-28', 'Run')], [activity('2026-07-29', 'Run')]);

    expect(diff.untouched).toHaveLength(1);
    expect(diff.untouched[0]!.date).toBe('2026-07-28');
    expect(diff.unplannedExtra).toHaveLength(1);
    expect(diff.completedAsPlanned).toEqual([]);
    expect(diff.completedDifferently).toEqual([]);
  });

  it('swapped days stay matched when intervals.icu paired them across the boundary', () => {
    const planned = event('2026-07-28', 'Run');
    const diff = weekDiff(
      [planned],
      [activity('2026-07-29', 'Run', { paired_event_id: planned.id })],
    );

    expect(diff.completedDifferently).toHaveLength(1);
    expect(diff.completedDifferently[0]!.reasons.join()).toMatch(/day differs/);
    expect(diff.untouched).toEqual([]);
  });

  it('partial completion: cut short mid-session', () => {
    const diff = weekDiff(
      [event('2026-07-30', 'Run', { moving_time: 4800, distance: 14_000 })],
      [activity('2026-07-30', 'Run', { moving_time: 1500, distance: 4000 })],
    );

    expect(diff.completedDifferently).toHaveLength(1);
    expect(diff.completedDifferently[0]!.reasons).toHaveLength(2);
  });

  it('a full week reconciles into disjoint buckets', () => {
    const planned = [
      event('2026-07-27', 'Run', { moving_time: 2400 }),
      event('2026-07-28', 'Ride', { moving_time: 3600 }),
      event('2026-07-29', 'Run', { moving_time: 3000 }),
      event('2026-07-31', 'Run', { moving_time: 5400 }),
    ];
    const completed = [
      activity('2026-07-27', 'Run', { moving_time: 2400 }), // as planned
      activity('2026-07-28', 'Ride', { moving_time: 1500 }), // cut short
      activity('2026-07-30', 'Ride', { moving_time: 2000 }), // bonus
      // 2026-07-29 and 2026-07-31 missed
    ];

    const diff = weekDiff(planned, completed);

    expect(diff.completedAsPlanned).toHaveLength(1);
    expect(diff.completedDifferently).toHaveLength(1);
    expect(diff.untouched.map((e) => e.date)).toEqual(['2026-07-29', '2026-07-31']);
    expect(diff.unplannedExtra).toHaveLength(1);

    // Every planned event and every activity is accounted for exactly once.
    const plannedSeen =
      diff.untouched.length + diff.completedAsPlanned.length + diff.completedDifferently.length;
    const activitiesSeen =
      diff.completedAsPlanned.length + diff.completedDifferently.length + diff.unplannedExtra.length;
    expect(plannedSeen).toBe(planned.length);
    expect(activitiesSeen).toBe(completed.length);
  });
});

describe('purity and determinism', () => {
  it('does not mutate its inputs', () => {
    const planned = [event('2026-07-28', 'Run')];
    const completed = [activity('2026-07-28', 'Run')];
    const plannedCopy = structuredClone(planned);
    const completedCopy = structuredClone(completed);

    weekDiff(planned, completed);

    expect(planned).toEqual(plannedCopy);
    expect(completed).toEqual(completedCopy);
  });

  it('is order-independent', () => {
    const a = event('2026-07-28', 'Run');
    const b = event('2026-07-29', 'Ride');
    const x = activity('2026-07-28', 'Run');
    const y = activity('2026-07-29', 'Ride');

    expect(weekDiff([a, b], [x, y])).toEqual(weekDiff([b, a], [y, x]));
  });

  it('honours custom tolerances', () => {
    const planned = [event('2026-07-28', 'Run', { moving_time: 3600 })];
    const completed = [activity('2026-07-28', 'Run', { moving_time: 3000 })]; // 17% short

    expect(weekDiff(planned, completed, DEFAULT_TOLERANCES).completedAsPlanned).toHaveLength(1);
    expect(
      weekDiff(planned, completed, { durationPct: 0.05, distancePct: 0.05 })
        .completedDifferently,
    ).toHaveLength(1);
  });
});
