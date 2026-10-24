import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  WorkoutValidationError,
  assertValidWorkout,
  validateWorkout,
} from '../src/workout/validate.js';
import type { StructuredWorkout } from '../src/workout/schema.js';

const time = (seconds: number) => ({ kind: 'time' as const, seconds });

function runWorkout(steps: StructuredWorkout['steps']): StructuredWorkout {
  return { name: 'test', sport: 'run', date: '2026-08-03', steps };
}

function bikeWorkout(steps: StructuredWorkout['steps']): StructuredWorkout {
  return { name: 'test', sport: 'bike', date: '2026-08-03', steps };
}

describe('valid workouts', () => {
  it('accepts a plausible run', () => {
    const result = validateWorkout(
      runWorkout([
        { type: 'run', duration: time(1800), paceTarget: { kind: 'pctThreshold', min: 65, max: 75 } },
      ]),
    );
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('accepts a plausible bike session with cadence', () => {
    const result = validateWorkout(
      bikeWorkout([
        {
          type: 'bike',
          duration: time(1200),
          powerTarget: { kind: 'pctFtp', min: 88, max: 94 },
          cadenceTarget: { min: 85, max: 95 },
        },
      ]),
    );
    expect(result.ok).toBe(true);
  });
});

describe('metric family compliance', () => {
  it('rejects a bike step inside a run workout', () => {
    const result = validateWorkout(
      runWorkout([
        { type: 'bike', duration: time(600), powerTarget: { kind: 'pctFtp', min: 70, max: 80 } },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/mixes metric families/);
  });

  it('rejects a power-targeted rest inside a run workout', () => {
    const result = validateWorkout(
      runWorkout([
        { type: 'run', duration: time(600), paceTarget: { kind: 'zone', min: 2, max: 2 } },
        { type: 'rest', duration: time(120), target: { kind: 'watts', min: 100, max: 120 } },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/rest target is power but the workout is pace/);
  });

  it('allows a bare zone rest target, which takes its family from the sport', () => {
    const result = validateWorkout(
      runWorkout([
        { type: 'run', duration: time(600), paceTarget: { kind: 'zone', min: 3, max: 3 } },
        { type: 'rest', duration: time(120), target: { kind: 'zone', min: 1, max: 1 } },
      ]),
    );
    expect(result.ok).toBe(true);
  });
});

describe('implausible targets', () => {
  it('rejects a pace faster than a sprint', () => {
    const result = validateWorkout(
      runWorkout([
        { type: 'run', duration: time(600), paceTarget: { kind: 'absolute', min: '1:30', max: '1:40' } },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/outside the plausible range/);
  });

  it('rejects an absolute pace range ordered slowest first', () => {
    const result = validateWorkout(
      runWorkout([
        { type: 'run', duration: time(600), paceTarget: { kind: 'absolute', min: '5:30', max: '4:30' } },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/order the range fastest first/);
  });

  it('rejects power above a realistic FTP multiple', () => {
    const result = validateWorkout(
      bikeWorkout([
        { type: 'bike', duration: time(300), powerTarget: { kind: 'pctFtp', min: 250, max: 300 } },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/outside 30-200%/);
  });

  it('bounds absolute watts against FTP when it is known', () => {
    const limits = { ...DEFAULT_LIMITS, ftp: 180 };
    const result = validateWorkout(
      bikeWorkout([
        { type: 'bike', duration: time(300), powerTarget: { kind: 'watts', min: 380, max: 400 } },
      ]),
      limits,
    );
    // 200% of 180 W is 360 W, so 400 W is out of range.
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/54-360w/);
  });

  it('rejects an implausible cadence', () => {
    const result = validateWorkout(
      bikeWorkout([
        {
          type: 'bike',
          duration: time(300),
          powerTarget: { kind: 'pctFtp', min: 80, max: 85 },
          cadenceTarget: { min: 20, max: 200 },
        },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/cadence/);
  });

  it('rejects a pace zone above Z5', () => {
    const result = validateWorkout(
      runWorkout([{ type: 'run', duration: time(600), paceTarget: { kind: 'zone', min: 6, max: 7 } }]),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/outside Z1-Z5/);
  });

  it('accepts Z7 for power, where the zone scale runs to seven', () => {
    const result = validateWorkout(
      bikeWorkout([{ type: 'bike', duration: time(60), powerTarget: { kind: 'zone', min: 7, max: 7 } }]),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an inverted range', () => {
    const result = validateWorkout(
      runWorkout([
        { type: 'run', duration: time(600), paceTarget: { kind: 'pctThreshold', min: 90, max: 70 } },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/exceeds max/);
  });
});

describe('repeat blocks', () => {
  it('validates steps inside repeats and locates them in the message', () => {
    const result = validateWorkout(
      runWorkout([
        {
          type: 'repeat',
          count: 4,
          steps: [
            { type: 'run', duration: time(180), paceTarget: { kind: 'pctThreshold', min: 105, max: 110 } },
            { type: 'run', duration: time(90), paceTarget: { kind: 'pctThreshold', min: 500, max: 600 } },
          ],
        },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/step 1, repeat item 2/);
  });
});

describe('assertValidWorkout', () => {
  it('reports every problem at once rather than the first', () => {
    const error = (() => {
      try {
        assertValidWorkout(
          runWorkout([
            { type: 'run', duration: time(600), paceTarget: { kind: 'pctThreshold', min: 500, max: 600 } },
            { type: 'bike', duration: time(600), powerTarget: { kind: 'pctFtp', min: 900, max: 999 } },
          ]),
        );
        return null;
      } catch (e) {
        return e as WorkoutValidationError;
      }
    })();

    expect(error).toBeInstanceOf(WorkoutValidationError);
    expect(error!.errors.length).toBeGreaterThan(2);
  });

  it('passes silently for a valid workout', () => {
    expect(() =>
      assertValidWorkout(
        runWorkout([{ type: 'run', duration: time(600), paceTarget: { kind: 'zone', min: 2, max: 2 } }]),
      ),
    ).not.toThrow();
  });
});
