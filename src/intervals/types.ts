/**
 * Types for the subset of the intervals.icu API this bridge uses.
 *
 * These describe the wire format, not our internal representation — see
 * `src/workout/schema.ts` for the latter. Fields are optional wherever the API
 * omits them for activities that lack the underlying sensor data, which is most
 * of them most of the time.
 */

/** intervals.icu activity/event sport types. Only the two we plan for are named. */
export type IntervalsSportType = 'Run' | 'Ride' | (string & {});

/** The metric family a planned workout is prescribed in. */
export type IntervalsTarget = 'POWER' | 'PACE' | 'HR' | 'AUTO';

/**
 * A completed activity — what actually happened.
 * `GET /athlete/{id}/activities`
 */
export interface Activity {
  id: string;
  start_date_local: string;
  type: IntervalsSportType;
  name?: string;
  /** Seconds. */
  moving_time?: number;
  /** Seconds. */
  elapsed_time?: number;
  /** Metres. */
  distance?: number;
  icu_training_load?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  icu_average_watts?: number;
  average_speed?: number;
  /** Set when the activity was created from a planned event. */
  paired_event_id?: number;
}

/**
 * A calendar event. `category: 'WORKOUT'` is a planned session; other categories
 * (NOTE, RACE_A, HOLIDAY, …) also appear on the calendar and are filtered out.
 * `GET /athlete/{id}/events`
 */
export interface CalendarEvent {
  id: number;
  start_date_local: string;
  category: string;
  type?: IntervalsSportType;
  name?: string;
  description?: string;
  /** Seconds. */
  moving_time?: number;
  /** Metres. */
  distance?: number;
  icu_training_load?: number;
  target?: IntervalsTarget;
  /** Server-generated. Parsed from `description`; never sent by us. */
  workout_doc?: WorkoutDoc;
}

/**
 * Read-only. intervals.icu produces this by parsing the `description` text; it
 * is not a writable field, which is why `toIntervalsFormat` emits DSL text
 * rather than a step array.
 */
export interface WorkoutDoc {
  steps?: unknown[];
  duration?: number;
  zoneTimes?: number[];
  hrZoneTimes?: number[];
  [key: string]: unknown;
}

/**
 * A daily wellness record. `id` is the date in yyyy-MM-dd.
 * `GET /athlete/{id}/wellness`
 */
export interface WellnessRecord {
  id: string;
  /** Chronic training load — fitness. */
  ctl?: number;
  /** Acute training load — fatigue. */
  atl?: number;
  restingHR?: number;
  hrv?: number;
  weight?: number;
  /** Seconds. */
  sleepSecs?: number;
  sleepScore?: number;
  /** 1 (best) to 4 (worst) on intervals.icu's scale. */
  fatigue?: number;
  soreness?: number;
  stress?: number;
  mood?: number;
}

/**
 * Zone configuration for one sport group, as it actually appears nested under
 * `sportSettings` on the `GET /athlete/{id}` response — confirmed against a
 * live account. This is not the shape an earlier version of this
 * file assumed (a flat `{ftp, heart_rate_zones, power_zones, run_zones}`
 * object); that assumption was never checked against a real response.
 *
 * `types` names every sport this block covers, e.g. `["Ride", "VirtualRide",
 * "MountainBikeRide", ...]`. A given field being `null` means the athlete
 * hasn't configured it for that sport group — power/pace fields are commonly
 * null for non-cycling groups even when HR fields are set.
 */
export interface SportZoneSettings {
  types: string[];
  /** Watts. Only meaningful where power is trained, typically Ride. */
  ftp?: number | null;
  /**
   * Upper bound of each power zone, as **percent of FTP** — not watts, and
   * not a {min,max} pair. A 7-entry array, one per zone; the last entry has
   * no real ceiling (observed as 999).
   */
  power_zones?: number[] | null;
  power_zone_names?: string[] | null;
  /** Lactate threshold heart rate, bpm. */
  lthr?: number | null;
  max_hr?: number | null;
  /** Upper bound of each HR zone, in bpm (absolute, not a percentage). */
  hr_zones?: number[] | null;
  hr_zone_names?: string[] | null;
  /**
   * Threshold pace, metres per second. Frequently `null` — it is only set
   * once the athlete has explicitly configured pace zones for that sport;
   * do not assume it is populated for Run.
   */
  threshold_pace?: number | null;
  pace_zones?: number[] | null;
  pace_zone_names?: string[] | null;
}

/**
 * The subset of the full `GET /athlete/{id}` account object this bridge
 * reads. The real response is a large account/profile/preferences object —
 * dozens of unrelated fields — and, notably, includes `icu_api_key` with the
 * caller's own key in plaintext. Callers must never log or print the response
 * to this endpoint unfiltered.
 */
export interface AthleteAccount {
  id: string;
  sportSettings?: SportZoneSettings[];
}

/**
 * One lap / interval from `GET /activity/{id}/intervals` → `icu_intervals`.
 *
 * `type` matters: Watches can emit sub-second `RECOVERY` blips between laps (e.g. a
 * lap lasting a second and covering a few metres), so callers need to see the type rather
 * than have artifacts silently folded into the analysis.
 *
 * Speeds are metres per second, distances metres, times seconds, gradient a
 * fraction (0.02 = 2%).
 */
export interface ActivityLap {
  type?: string;
  distance?: number;
  moving_time?: number;
  elapsed_time?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_speed?: number;
  average_watts?: number;
  average_cadence?: number;
  average_gradient?: number;
}

/**
 * One stream from `GET /activity/{id}/streams`. Every stream in a response has
 * the same sample count, so they can be zipped positionally.
 */
export interface ActivityStream {
  type: string;
  data: (number | null)[];
}

/**
 * The body we POST/PUT to the events endpoint.
 *
 * `description` carries the structured workout as intervals.icu DSL text — the
 * only supported way to submit structured steps over the API.
 */
export interface EventPayload {
  start_date_local: string;
  category: 'WORKOUT';
  type: IntervalsSportType;
  name: string;
  description: string;
  moving_time?: number;
  target?: IntervalsTarget;
}
