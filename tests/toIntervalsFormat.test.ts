import { describe, expect, it } from 'vitest';
import {
  estimateMovingTime,
  formatDuration,
  formatPaceTarget,
  formatPowerTarget,
  toIntervalsFormat,
  toWorkoutDescription,
} from '../src/workout/toIntervalsFormat.js';
import { structuredWorkoutSchema, type StructuredWorkout } from '../src/workout/schema.js';

const time = (seconds: number) => ({ kind: 'time' as const, seconds });
const distance = (meters: number) => ({ kind: 'distance' as const, meters });

describe('formatDuration', () => {
  it('emits h/m/s components, omitting zero parts', () => {
    expect(formatDuration(time(30))).toBe('30s');
    expect(formatDuration(time(60))).toBe('1m');
    expect(formatDuration(time(90))).toBe('1m30s');
    expect(formatDuration(time(600))).toBe('10m');
    expect(formatDuration(time(3600))).toBe('1h');
    expect(formatDuration(time(3750))).toBe('1h2m30s');
  });

  it('never emits bare metres, since m means minutes in this DSL', () => {
    expect(formatDuration(distance(400))).toBe('0.4km');
    expect(formatDuration(distance(1000))).toBe('1km');
    expect(formatDuration(distance(1609))).toBe('1.609km');
    expect(formatDuration(distance(5000))).toBe('5km');
  });
});

describe('target formatting', () => {
  it('formats pace targets', () => {
    expect(formatPaceTarget({ kind: 'pctThreshold', min: 71, max: 79 })).toBe('71-79% Pace');
    expect(formatPaceTarget({ kind: 'pctThreshold', min: 65, max: 65 })).toBe('65% Pace');
    expect(formatPaceTarget({ kind: 'zone', min: 2, max: 2 })).toBe('Z2 Pace');
    expect(formatPaceTarget({ kind: 'zone', min: 1, max: 2 })).toBe('Z1-Z2 Pace');
    expect(formatPaceTarget({ kind: 'absolute', min: '4:28', max: '4:32' })).toBe(
      '4:28-4:32/km Pace',
    );
    expect(formatPaceTarget({ kind: 'absolute', min: '5:00', max: '5:00' })).toBe(
      '5:00/km Pace',
    );
  });

  it('formats power targets without a family suffix', () => {
    expect(formatPowerTarget({ kind: 'pctFtp', min: 95, max: 105 })).toBe('95-105%');
    expect(formatPowerTarget({ kind: 'pctFtp', min: 75, max: 75 })).toBe('75%');
    expect(formatPowerTarget({ kind: 'watts', min: 200, max: 240 })).toBe('200-240w');
    expect(formatPowerTarget({ kind: 'zone', min: 3, max: 4 })).toBe('Z3-Z4');
  });
});

// ── Golden files ─────────────────────────────────────────────────────────────
// Exact-output tests. Blank lines around section headers are required by the
// parser, so these assert the whole string rather than matching loosely.

describe('toWorkoutDescription (golden)', () => {
  it('renders a threshold run with a repeat block', () => {
    const workout: StructuredWorkout = {
      name: '5x1km threshold',
      sport: 'run',
      date: '2026-08-03',
      steps: [
        { type: 'run', cue: 'Warmup', duration: time(900), paceTarget: { kind: 'pctThreshold', min: 71, max: 79 } },
        {
          type: 'repeat',
          label: 'Main Set',
          count: 5,
          steps: [
            { type: 'run', duration: distance(1000), paceTarget: { kind: 'pctThreshold', min: 106, max: 112 } },
            { type: 'rest', duration: time(90), target: { kind: 'pctThreshold', min: 62, max: 68 } },
          ],
        },
        { type: 'run', cue: 'Cooldown', duration: time(600), paceTarget: { kind: 'zone', min: 1, max: 1 } },
      ],
    };

    expect(toWorkoutDescription(workout)).toBe(
      [
        '- Warmup 15m 71-79% Pace',
        '',
        'Main Set 5x',
        '- 1km 106-112% Pace',
        '- 1m30s 62-68% Pace',
        '',
        '- Cooldown 10m Z1 Pace',
      ].join('\n'),
    );
  });

  it('renders a bike workout with cadence targets', () => {
    const workout: StructuredWorkout = {
      name: '3x VO2',
      sport: 'bike',
      date: '2026-08-05',
      steps: [
        { type: 'bike', cue: 'Warmup', duration: time(900), powerTarget: { kind: 'pctFtp', min: 55, max: 55 } },
        {
          type: 'repeat',
          count: 3,
          steps: [
            {
              type: 'bike',
              duration: time(180),
              powerTarget: { kind: 'pctFtp', min: 110, max: 115 },
              cadenceTarget: { min: 90, max: 100 },
            },
            { type: 'rest', duration: time(180), target: { kind: 'pctFtp', min: 50, max: 50 } },
          ],
        },
        { type: 'bike', cue: 'Cooldown', duration: time(300), powerTarget: { kind: 'zone', min: 1, max: 1 } },
      ],
    };

    expect(toWorkoutDescription(workout)).toBe(
      [
        '- Warmup 15m 55%',
        '',
        'Main Set 3x',
        '- 3m 110-115% 90-100rpm',
        '- 3m 50%',
        '',
        '- Cooldown 5m Z1',
      ].join('\n'),
    );
  });

  it('defaults the repeat header label to "Main Set"', () => {
    const workout: StructuredWorkout = {
      name: 'Strides',
      sport: 'run',
      date: '2026-08-06',
      steps: [
        {
          type: 'repeat',
          count: 6,
          steps: [{ type: 'run', duration: time(20), paceTarget: { kind: 'pctThreshold', min: 120, max: 130 } }],
        },
      ],
    };

    expect(toWorkoutDescription(workout)).toBe('Main Set 6x\n- 20s 120-130% Pace');
  });

  it('emits an untargeted rest as a bare duration rather than inventing an intensity', () => {
    const workout: StructuredWorkout = {
      name: 'Walk break',
      sport: 'run',
      date: '2026-08-07',
      steps: [{ type: 'rest', cue: 'Walk', duration: time(120) }],
    };

    expect(toWorkoutDescription(workout)).toBe('- Walk 2m');
  });
});

describe('estimateMovingTime', () => {
  it('multiplies repeat blocks by their count', () => {
    const workout: StructuredWorkout = {
      name: 'x',
      sport: 'run',
      date: '2026-08-03',
      steps: [
        { type: 'run', duration: time(600), paceTarget: { kind: 'zone', min: 2, max: 2 } },
        {
          type: 'repeat',
          count: 4,
          steps: [
            { type: 'run', duration: time(180), paceTarget: { kind: 'zone', min: 4, max: 4 } },
            { type: 'rest', duration: time(60) },
          ],
        },
      ],
    };

    expect(estimateMovingTime(workout)).toBe(600 + 4 * 240);
  });

  it('returns undefined when any step is distance-based, rather than assuming a pace', () => {
    const workout: StructuredWorkout = {
      name: 'x',
      sport: 'run',
      date: '2026-08-03',
      steps: [{ type: 'run', duration: distance(5000), paceTarget: { kind: 'zone', min: 3, max: 3 } }],
    };

    expect(estimateMovingTime(workout)).toBeUndefined();
  });
});

describe('toIntervalsFormat', () => {
  const workout: StructuredWorkout = {
    name: 'Easy 40',
    sport: 'run',
    date: '2026-08-03',
    steps: [{ type: 'run', duration: time(2400), paceTarget: { kind: 'pctThreshold', min: 62, max: 68 } }],
  };

  it('builds the event envelope', () => {
    expect(toIntervalsFormat(workout)).toEqual({
      start_date_local: '2026-08-03T00:00:00',
      category: 'WORKOUT',
      type: 'Run',
      name: 'Easy 40',
      description: '- 40m 62-68% Pace',
      target: 'PACE',
      moving_time: 2400,
    });
  });

  it('maps bike to Ride and POWER', () => {
    const payload = toIntervalsFormat({
      ...workout,
      sport: 'bike',
      steps: [{ type: 'bike', duration: time(2400), powerTarget: { kind: 'pctFtp', min: 60, max: 70 } }],
    });

    expect(payload.type).toBe('Ride');
    expect(payload.target).toBe('POWER');
  });

  it('appends notes after the steps, separated by a blank line', () => {
    const payload = toIntervalsFormat({ ...workout, notes: 'Keep it conversational.' });
    expect(payload.description).toBe('- 40m 62-68% Pace\n\nKeep it conversational.');
  });

  it('omits moving_time when it cannot be determined', () => {
    const payload = toIntervalsFormat({
      ...workout,
      steps: [{ type: 'run', duration: distance(8000), paceTarget: { kind: 'zone', min: 2, max: 2 } }],
    });

    expect(payload.moving_time).toBeUndefined();
    expect('moving_time' in payload).toBe(false);
  });
});

describe('schema', () => {
  it('makes nested repeats unrepresentable', () => {
    const nested = {
      name: 'x',
      sport: 'run',
      date: '2026-08-03',
      steps: [
        {
          type: 'repeat',
          count: 2,
          steps: [{ type: 'repeat', count: 2, steps: [] }],
        },
      ],
    };

    expect(structuredWorkoutSchema.safeParse(nested).success).toBe(false);
  });

  it('rejects a malformed date', () => {
    const result = structuredWorkoutSchema.safeParse({
      name: 'x',
      sport: 'run',
      date: '03/08/2026',
      steps: [{ type: 'rest', duration: time(60) }],
    });

    expect(result.success).toBe(false);
  });
});
