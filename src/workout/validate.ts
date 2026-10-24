/**
 * Sanity checks run before anything is emitted or sent.
 *
 * This is a safety net, not a coach. It rejects workouts that are structurally
 * invalid or physiologically implausible — the kind of thing a unit slip or a
 * dropped decimal produces — and says nothing about whether a session is a good
 * idea. It rejects rather than clamps: silently "fixing" a target would put a
 * number on the watch that nobody chose.
 */
import {
  type LeafStep,
  type MetricFamily,
  type PaceTarget,
  type PowerTarget,
  type StructuredWorkout,
} from './schema.js';
import { familyForSport } from './toIntervalsFormat.js';

export interface ValidationLimits {
  /** Fastest plausible prescribed pace, seconds per km. */
  minPaceSecondsPerKm: number;
  /** Slowest plausible prescribed pace, seconds per km. */
  maxPaceSecondsPerKm: number;
  /** Percent of threshold pace. */
  minPctThreshold: number;
  maxPctThreshold: number;
  /** Percent of FTP. */
  minPctFtp: number;
  maxPctFtp: number;
  minCadence: number;
  maxCadence: number;
  /** Pace zones are 1-5, power zones 1-7. */
  maxPaceZone: number;
  maxPowerZone: number;
  /** Used to bound absolute watt targets. Falls back to a fixed range. */
  ftp?: number;
}

/**
 * Generic physiological plausibility bounds — a safety net for unit slips and
 * dropped decimals, not tuned to any one athlete. `ftp` is left unset here and
 * filled in at startup from the athlete's actual Ride FTP when one is
 * configured (`server.ts`'s `withAthleteLimits`); pace has no equivalent
 * per-athlete narrowing because intervals.icu often leaves Run threshold pace
 * unconfigured even when HR and power are set up.
 */
export const DEFAULT_LIMITS: ValidationLimits = {
  minPaceSecondsPerKm: 150, // 2:30/km — faster than a sustainable sprint
  maxPaceSecondsPerKm: 720, // 12:00/km — slower than a walk
  minPctThreshold: 40,
  maxPctThreshold: 150,
  minPctFtp: 30,
  maxPctFtp: 200,
  minCadence: 40,
  maxCadence: 130,
  maxPaceZone: 5,
  maxPowerZone: 7,
};

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export class WorkoutValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(`Workout failed validation:\n- ${errors.join('\n- ')}`);
    this.name = 'WorkoutValidationError';
  }
}

/** Parse "mm:ss" to seconds. */
function paceToSeconds(value: string): number {
  const [minutes, seconds] = value.split(':');
  return Number(minutes) * 60 + Number(seconds);
}

export function validateWorkout(
  workout: StructuredWorkout,
  limits: ValidationLimits = DEFAULT_LIMITS,
): ValidationResult {
  const errors: string[] = [];
  const family = familyForSport(workout.sport);

  const flat: { step: LeafStep; where: string }[] = [];
  workout.steps.forEach((step, index) => {
    if (step.type === 'repeat') {
      step.steps.forEach((child, childIndex) => {
        flat.push({ step: child, where: `step ${index + 1}, repeat item ${childIndex + 1}` });
      });
    } else {
      flat.push({ step, where: `step ${index + 1}` });
    }
  });

  for (const { step, where } of flat) {
    checkSportMatch(step, workout, where, errors);
    checkStep(step, family, where, limits, errors);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * A workout must stay in one metric family. Mixing them breaks intervals.icu's
 * training-load calculation, zone charts and time-in-zone tracking.
 */
function checkSportMatch(
  step: LeafStep,
  workout: StructuredWorkout,
  where: string,
  errors: string[],
): void {
  if (step.type === 'run' && workout.sport !== 'run') {
    errors.push(`${where}: run step in a '${workout.sport}' workout — mixes metric families`);
  }
  if (step.type === 'bike' && workout.sport !== 'bike') {
    errors.push(`${where}: bike step in a '${workout.sport}' workout — mixes metric families`);
  }
}

function checkStep(
  step: LeafStep,
  family: MetricFamily,
  where: string,
  limits: ValidationLimits,
  errors: string[],
): void {
  if (step.duration.kind === 'time' && step.duration.seconds <= 0) {
    errors.push(`${where}: duration must be positive`);
  }
  if (step.duration.kind === 'distance' && step.duration.meters <= 0) {
    errors.push(`${where}: distance must be positive`);
  }

  switch (step.type) {
    case 'run':
      checkPaceTarget(step.paceTarget, where, limits, errors);
      break;

    case 'bike':
      checkPowerTarget(step.powerTarget, where, limits, errors);
      if (step.cadenceTarget) {
        const { min, max } = step.cadenceTarget;
        if (min > max) errors.push(`${where}: cadence min ${min} exceeds max ${max}`);
        if (min < limits.minCadence || max > limits.maxCadence) {
          errors.push(
            `${where}: cadence ${min}-${max}rpm outside ${limits.minCadence}-${limits.maxCadence}rpm`,
          );
        }
      }
      break;

    case 'rest':
      if (step.target) {
        const targetFamily = paceOrPower(step.target);
        // 'neutral' is a bare zone, which inherits the workout's family.
        if (targetFamily !== 'neutral' && targetFamily !== family) {
          errors.push(
            `${where}: rest target is ${targetFamily} but the workout is ${family} — mixes metric families`,
          );
        } else if (family === 'pace') {
          checkPaceTarget(step.target as PaceTarget, where, limits, errors);
        } else {
          checkPowerTarget(step.target as PowerTarget, where, limits, errors);
        }
      }
      break;
  }
}

/** A bare `zone` target takes its family from the workout, so it is neutral. */
function paceOrPower(target: PaceTarget | PowerTarget): MetricFamily | 'neutral' {
  switch (target.kind) {
    case 'pctThreshold':
    case 'absolute':
      return 'pace';
    case 'pctFtp':
    case 'watts':
      return 'power';
    case 'zone':
      return 'neutral';
  }
}

function checkPaceTarget(
  target: PaceTarget,
  where: string,
  limits: ValidationLimits,
  errors: string[],
): void {
  switch (target.kind) {
    case 'pctThreshold': {
      if (target.min > target.max) {
        errors.push(`${where}: pace min ${target.min}% exceeds max ${target.max}%`);
      }
      if (target.min < limits.minPctThreshold || target.max > limits.maxPctThreshold) {
        errors.push(
          `${where}: pace ${target.min}-${target.max}% of threshold outside ` +
            `${limits.minPctThreshold}-${limits.maxPctThreshold}%`,
        );
      }
      break;
    }
    case 'absolute': {
      const min = paceToSeconds(target.min);
      const max = paceToSeconds(target.max);
      if (min > max) {
        errors.push(`${where}: pace ${target.min} is slower than ${target.max}; order the range fastest first`);
      }
      if (min < limits.minPaceSecondsPerKm || max > limits.maxPaceSecondsPerKm) {
        errors.push(
          `${where}: pace ${target.min}-${target.max}/km outside the plausible range ` +
            `${formatSeconds(limits.minPaceSecondsPerKm)}-${formatSeconds(limits.maxPaceSecondsPerKm)}/km`,
        );
      }
      break;
    }
    case 'zone': {
      if (target.min > target.max) {
        errors.push(`${where}: zone min Z${target.min} exceeds max Z${target.max}`);
      }
      if (target.min < 1 || target.max > limits.maxPaceZone) {
        errors.push(`${where}: pace zone Z${target.min}-Z${target.max} outside Z1-Z${limits.maxPaceZone}`);
      }
      break;
    }
  }
}

function checkPowerTarget(
  target: PowerTarget,
  where: string,
  limits: ValidationLimits,
  errors: string[],
): void {
  switch (target.kind) {
    case 'pctFtp': {
      if (target.min > target.max) {
        errors.push(`${where}: power min ${target.min}% exceeds max ${target.max}%`);
      }
      if (target.min < limits.minPctFtp || target.max > limits.maxPctFtp) {
        errors.push(
          `${where}: power ${target.min}-${target.max}% of FTP outside ` +
            `${limits.minPctFtp}-${limits.maxPctFtp}%`,
        );
      }
      break;
    }
    case 'watts': {
      if (target.min > target.max) {
        errors.push(`${where}: power min ${target.min}w exceeds max ${target.max}w`);
      }
      const lower = limits.ftp ? (limits.ftp * limits.minPctFtp) / 100 : 30;
      const upper = limits.ftp ? (limits.ftp * limits.maxPctFtp) / 100 : 1000;
      if (target.min < lower || target.max > upper) {
        errors.push(
          `${where}: power ${target.min}-${target.max}w outside the plausible range ` +
            `${Math.round(lower)}-${Math.round(upper)}w`,
        );
      }
      break;
    }
    case 'zone': {
      if (target.min > target.max) {
        errors.push(`${where}: zone min Z${target.min} exceeds max Z${target.max}`);
      }
      if (target.min < 1 || target.max > limits.maxPowerZone) {
        errors.push(`${where}: power zone Z${target.min}-Z${target.max} outside Z1-Z${limits.maxPowerZone}`);
      }
      break;
    }
  }
}

function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Validate, or throw with every problem listed at once. */
export function assertValidWorkout(
  workout: StructuredWorkout,
  limits: ValidationLimits = DEFAULT_LIMITS,
): void {
  const result = validateWorkout(workout, limits);
  if (!result.ok) {
    throw new WorkoutValidationError(result.errors);
  }
}
