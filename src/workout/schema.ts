/**
 * The internal workout representation.
 *
 * This is the deterministic contract between Claude and intervals.icu. Claude
 * never writes intervals.icu DSL text by hand — it fills in this structure, the
 * validator checks it, and `toIntervalsFormat` emits exact syntax from it.
 *
 * Zod schemas double as the MCP tool input schemas, so a malformed workout is
 * rejected at the protocol boundary before any of our code sees it.
 */
import { z } from 'zod';

// ── Durations ────────────────────────────────────────────────────────────────
// A step is bounded either by time or by distance. Distance steps matter for
// run intervals ("1km at threshold"), which the DSL supports natively.

export const durationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('time'),
    seconds: z.number().int().positive().max(86_400),
  }),
  z.object({
    kind: z.literal('distance'),
    meters: z.number().positive().max(200_000),
  }),
]);

export type Duration = z.infer<typeof durationSchema>;

// ── Targets ──────────────────────────────────────────────────────────────────
// Every target is a range. A single value is expressed as min === max, which
// the emitter collapses back to one number.

const rangeFields = {
  min: z.number(),
  max: z.number(),
};

export const paceTargetSchema = z.discriminatedUnion('kind', [
  /** Percent of threshold pace. 100% is T-pace; higher percent is faster. */
  z.object({ kind: z.literal('pctThreshold'), ...rangeFields }),
  /** Pace zone number, 1-5. */
  z.object({ kind: z.literal('zone'), ...rangeFields }),
  /**
   * Absolute pace as mm:ss per kilometre, e.g. "4:28". Discouraged by
   * intervals.icu because it ignores current fitness, but supported.
   */
  z.object({
    kind: z.literal('absolute'),
    min: z.string().regex(/^\d{1,2}:[0-5]\d$/, 'pace must be mm:ss'),
    max: z.string().regex(/^\d{1,2}:[0-5]\d$/, 'pace must be mm:ss'),
  }),
]);

export type PaceTarget = z.infer<typeof paceTargetSchema>;

export const powerTargetSchema = z.discriminatedUnion('kind', [
  /** Percent of FTP. */
  z.object({ kind: z.literal('pctFtp'), ...rangeFields }),
  /** Absolute watts. */
  z.object({ kind: z.literal('watts'), ...rangeFields }),
  /** Power zone number, 1-7. */
  z.object({ kind: z.literal('zone'), ...rangeFields }),
]);

export type PowerTarget = z.infer<typeof powerTargetSchema>;

export const cadenceTargetSchema = z.object({
  min: z.number().int(),
  max: z.number().int(),
});

export type CadenceTarget = z.infer<typeof cadenceTargetSchema>;

// ── Steps ────────────────────────────────────────────────────────────────────

/** Free-text shown on the watch before the step, e.g. "Warmup". */
const cue = z.string().min(1).max(80).optional();

export const runStepSchema = z.object({
  type: z.literal('run'),
  cue,
  duration: durationSchema,
  paceTarget: paceTargetSchema,
});

export const bikeStepSchema = z.object({
  type: z.literal('bike'),
  cue,
  duration: durationSchema,
  powerTarget: powerTargetSchema,
  cadenceTarget: cadenceTargetSchema.optional(),
});

/**
 * A recovery step. `target` is optional but, when present, must belong to the
 * same metric family as the rest of the workout — intervals.icu's load and
 * time-in-zone calculations break when a workout mixes families.
 */
export const restStepSchema = z.object({
  type: z.literal('rest'),
  cue,
  duration: durationSchema,
  target: z.union([paceTargetSchema, powerTargetSchema]).optional(),
});

export const leafStepSchema = z.discriminatedUnion('type', [
  runStepSchema,
  bikeStepSchema,
  restStepSchema,
]);

export type RunStep = z.infer<typeof runStepSchema>;
export type BikeStep = z.infer<typeof bikeStepSchema>;
export type RestStep = z.infer<typeof restStepSchema>;
export type LeafStep = z.infer<typeof leafStepSchema>;

/**
 * A repeated block, emitted as an `Nx` section header.
 *
 * Not recursive: intervals.icu does not support nested repeats, so the schema
 * makes that unrepresentable rather than leaving it to the validator.
 */
export const repeatBlockSchema = z.object({
  type: z.literal('repeat'),
  label: z.string().min(1).max(60).optional(),
  count: z.number().int().min(2).max(50),
  steps: z.array(leafStepSchema).min(1),
});

export type RepeatBlock = z.infer<typeof repeatBlockSchema>;

export const workoutStepSchema = z.union([leafStepSchema, repeatBlockSchema]);
export type WorkoutStep = z.infer<typeof workoutStepSchema>;

// ── Workout ──────────────────────────────────────────────────────────────────

export const structuredWorkoutSchema = z.object({
  name: z.string().min(1).max(120),
  sport: z.enum(['run', 'bike']),
  /** Calendar date, yyyy-MM-dd. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be yyyy-MM-dd'),
  steps: z.array(workoutStepSchema).min(1),
  notes: z.string().max(2000).optional(),
});

export type StructuredWorkout = z.infer<typeof structuredWorkoutSchema>;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The metric family a workout is prescribed in. */
export type MetricFamily = 'pace' | 'power';

/** Flatten a workout to its leaf steps, ignoring repeat structure. */
export function leafSteps(workout: StructuredWorkout): LeafStep[] {
  return workout.steps.flatMap((step) =>
    step.type === 'repeat' ? step.steps : [step],
  );
}

/** Which metric family a target belongs to, or null for an untargeted rest. */
export function targetFamily(
  target: PaceTarget | PowerTarget | undefined,
): MetricFamily | null {
  if (!target) return null;
  switch (target.kind) {
    case 'pctThreshold':
    case 'absolute':
      return 'pace';
    case 'pctFtp':
    case 'watts':
      return 'power';
    case 'zone':
      // Ambiguous on its own — `Z2` is power, `Z2 Pace` is pace. Resolved from
      // the step type by the caller.
      return null;
  }
}
