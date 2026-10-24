/**
 * Emits intervals.icu's plain-text workout DSL from our internal schema.
 *
 * intervals.icu has no structured-workout write API — `workout_doc` is
 * server-generated output, parsed from the text you submit in an event's
 * `description`. So this module is a text emitter rather than a JSON mapper,
 * and the determinism the plan wanted comes from the typed schema upstream.
 *
 * Whitespace is load-bearing: section headers need a blank line either side, or
 * the parser silently mis-groups the steps. The golden tests assert exact
 * output for that reason.
 */
import type { EventPayload, IntervalsSportType, IntervalsTarget } from '../intervals/types.js';
import {
  type BikeStep,
  type CadenceTarget,
  type Duration,
  type LeafStep,
  type MetricFamily,
  type PaceTarget,
  type PowerTarget,
  type RestStep,
  type RunStep,
  type StructuredWorkout,
} from './schema.js';

/** The metric family implied by the workout's sport. */
export function familyForSport(sport: StructuredWorkout['sport']): MetricFamily {
  return sport === 'run' ? 'pace' : 'power';
}

const SPORT_TYPE: Record<StructuredWorkout['sport'], IntervalsSportType> = {
  run: 'Run',
  bike: 'Ride',
};

const SPORT_TARGET: Record<StructuredWorkout['sport'], IntervalsTarget> = {
  run: 'PACE',
  bike: 'POWER',
};

// ── Primitive formatting ─────────────────────────────────────────────────────

/** Trim trailing zeros so 0.40 emits as "0.4" and 1.000 as "1". */
function num(value: number): string {
  return Number(value.toFixed(3)).toString();
}

/**
 * Format a duration.
 *
 * In this DSL `m` means minutes, so metres are never emitted as `m` — distances
 * always use `km`, per intervals.icu's own guidance to write `0.4km` over
 * `400m`.
 */
export function formatDuration(duration: Duration): string {
  if (duration.kind === 'distance') {
    return `${num(duration.meters / 1000)}km`;
  }

  const total = duration.seconds;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join('');
}

/** Collapse a range to one value when both ends match. */
function range(min: string, max: string): string {
  return min === max ? min : `${min}-${max}`;
}

export function formatPaceTarget(target: PaceTarget): string {
  switch (target.kind) {
    case 'pctThreshold':
      return `${range(num(target.min), num(target.max))}% Pace`;
    case 'zone':
      return `${range(`Z${num(target.min)}`, `Z${num(target.max)}`)} Pace`;
    case 'absolute':
      return `${range(target.min, target.max)}/km Pace`;
  }
}

export function formatPowerTarget(target: PowerTarget): string {
  switch (target.kind) {
    case 'pctFtp':
      return `${range(num(target.min), num(target.max))}%`;
    case 'watts':
      return `${range(num(target.min), num(target.max))}w`;
    case 'zone':
      return range(`Z${num(target.min)}`, `Z${num(target.max)}`);
  }
}

function formatCadence(cadence: CadenceTarget): string {
  return `${range(num(cadence.min), num(cadence.max))}rpm`;
}

// ── Steps ────────────────────────────────────────────────────────────────────

function formatRunStep(step: RunStep): string {
  return joinStep(step.cue, formatDuration(step.duration), formatPaceTarget(step.paceTarget));
}

function formatBikeStep(step: BikeStep): string {
  return joinStep(
    step.cue,
    formatDuration(step.duration),
    formatPowerTarget(step.powerTarget),
    step.cadenceTarget ? formatCadence(step.cadenceTarget) : undefined,
  );
}

/**
 * A rest step with no target emits as a bare duration. We deliberately do not
 * substitute a default recovery intensity — choosing one would be a training
 * decision, and this bridge holds no training logic.
 */
function formatRestStep(step: RestStep, family: MetricFamily): string {
  let target: string | undefined;
  if (step.target) {
    target =
      family === 'pace'
        ? formatPaceTarget(step.target as PaceTarget)
        : formatPowerTarget(step.target as PowerTarget);
  }
  return joinStep(step.cue, formatDuration(step.duration), target);
}

function joinStep(...parts: (string | undefined)[]): string {
  return `- ${parts.filter((part) => part !== undefined && part !== '').join(' ')}`;
}

export function formatLeafStep(step: LeafStep, family: MetricFamily): string {
  switch (step.type) {
    case 'run':
      return formatRunStep(step);
    case 'bike':
      return formatBikeStep(step);
    case 'rest':
      return formatRestStep(step, family);
  }
}

// ── Workout ──────────────────────────────────────────────────────────────────

/**
 * Render the workout as DSL text.
 *
 * Blocks are separated by blank lines; a repeat becomes a `Label Nx` header
 * followed by its steps, which is what gives the watch its "1/5, 2/5" prompts.
 */
export function toWorkoutDescription(workout: StructuredWorkout): string {
  const family = familyForSport(workout.sport);
  const blocks: string[] = [];
  let pending: string[] = [];

  const flush = () => {
    if (pending.length > 0) {
      blocks.push(pending.join('\n'));
      pending = [];
    }
  };

  for (const step of workout.steps) {
    if (step.type === 'repeat') {
      flush();
      const header = `${step.label ?? 'Main Set'} ${step.count}x`;
      const lines = step.steps.map((child) => formatLeafStep(child, family));
      blocks.push([header, ...lines].join('\n'));
    } else {
      pending.push(formatLeafStep(step, family));
    }
  }
  flush();

  return blocks.join('\n\n');
}

/**
 * Total prescribed time in seconds.
 *
 * Returns undefined when the workout contains distance-based steps: converting
 * those to a duration would require assuming a pace, and intervals.icu derives
 * the figure itself from the parsed workout anyway.
 */
export function estimateMovingTime(workout: StructuredWorkout): number | undefined {
  let total = 0;

  for (const step of workout.steps) {
    const multiplier = step.type === 'repeat' ? step.count : 1;
    const children = step.type === 'repeat' ? step.steps : [step];
    for (const child of children) {
      if (child.duration.kind === 'distance') return undefined;
      total += child.duration.seconds * multiplier;
    }
  }

  return total;
}

/** Build the full event body for POST/PUT to the events endpoint. */
export function toIntervalsFormat(workout: StructuredWorkout): EventPayload {
  const description = workout.notes
    ? `${toWorkoutDescription(workout)}\n\n${workout.notes}`
    : toWorkoutDescription(workout);
  const movingTime = estimateMovingTime(workout);

  return {
    // intervals.icu wants a local datetime; midnight keeps it an all-day plan.
    start_date_local: `${workout.date}T00:00:00`,
    category: 'WORKOUT',
    type: SPORT_TYPE[workout.sport],
    name: workout.name,
    description,
    target: SPORT_TARGET[workout.sport],
    ...(movingTime === undefined ? {} : { moving_time: movingTime }),
  };
}
