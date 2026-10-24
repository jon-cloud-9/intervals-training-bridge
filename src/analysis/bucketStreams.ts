/**
 * Aggregates 1-Hz activity streams into a handful of buckets.
 *
 * Streams are the only way to see what summary data hides — a 5k effort
 * can report `averageHr: 150` while its laps actually ran 140/155/160/155/145 — but
 * they cannot be handed to a model raw: a five-hour ride is roughly 18,000
 * samples across 11 streams. Bucketing keeps the shape of the effort (which is
 * what the analysis needs) while collapsing the volume by two or three orders of
 * magnitude.
 *
 * A pure function: no I/O, no clock, no config. Same inputs, same output.
 */
import type { ActivityStream } from '../intervals/types.js';

/** Streams that carry no analytical value at bucket level. */
const IGNORED_STREAMS = new Set(['latlng', 'time', 'distance', 'fixed_altitude']);

export type BucketOptions =
  | { bucketBy: 'km' }
  | { bucketBy: 'time'; minutes: number };

export interface MetricSummary {
  min: number;
  avg: number;
  max: number;
}

export interface Bucket {
  label: string;
  /** Seconds of samples falling in this bucket. */
  samples: number;
  /**
   * Average pace as "m:ss" per km, derived from `velocity_smooth`. A separate
   * field rather than an entry in `metrics` because pace is a formatted string
   * in different units from the speed it comes from — putting it in `metrics`
   * would mean publishing m/s values under a per-km label.
   */
  pace?: string;
  metrics: Record<string, MetricSummary | undefined>;
}

export interface BucketedStreams {
  buckets: Bucket[];
  /** Raw sample count, so the caller can see how much was collapsed. */
  sampleCount: number;
  note?: string;
}

function streamData(streams: ActivityStream[], type: string): (number | null)[] | undefined {
  return streams.find((s) => s.type === type)?.data;
}

/** Metres per second to min/km, as "m:ss". Undefined when speed is unusable. */
export function formatPace(metresPerSecond: number | undefined): string | undefined {
  if (!metresPerSecond || metresPerSecond <= 0) return undefined;
  const secondsPerKm = Math.round(1000 / metresPerSecond);
  return `${Math.floor(secondsPerKm / 60)}:${String(secondsPerKm % 60).padStart(2, '0')}`;
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function summarise(values: number[]): MetricSummary | undefined {
  if (values.length === 0) return undefined;
  let min = Infinity;
  let max = -Infinity;
  let total = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    total += v;
  }
  return {
    min: round(min),
    avg: round(total / values.length),
    max: round(max),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Assign each sample index to a bucket, returning one index list per bucket
 * along with its label. Buckets with no samples are dropped.
 */
function assignBuckets(
  streams: ActivityStream[],
  options: BucketOptions,
  sampleCount: number,
): { labels: string[]; indices: number[][] } | { error: string } {
  const groups = new Map<number, number[]>();

  if (options.bucketBy === 'km') {
    const distance = streamData(streams, 'distance');
    if (!distance) {
      return { error: 'No distance stream available, so per-kilometre bucketing is not possible.' };
    }
    for (let i = 0; i < sampleCount; i += 1) {
      const d = distance[i];
      if (d === null || d === undefined) continue;
      const key = Math.floor(d / 1000);
      const list = groups.get(key);
      if (list) list.push(i);
      else groups.set(key, [i]);
    }
    const keys = [...groups.keys()].sort((a, b) => a - b);
    return {
      labels: keys.map((k) => `km ${k + 1}`),
      indices: keys.map((k) => groups.get(k)!),
    };
  }

  const time = streamData(streams, 'time');
  const windowSeconds = Math.max(1, options.minutes) * 60;
  for (let i = 0; i < sampleCount; i += 1) {
    // Fall back to sample index when no time stream exists; streams are 1 Hz.
    const t = time?.[i] ?? i;
    if (t === null || t === undefined) continue;
    const key = Math.floor(t / windowSeconds);
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  }
  const keys = [...groups.keys()].sort((a, b) => a - b);
  return {
    labels: keys.map(
      (k) => `${formatClock(k * windowSeconds)}–${formatClock((k + 1) * windowSeconds)}`,
    ),
    indices: keys.map((k) => groups.get(k)!),
  };
}

export function bucketStreams(
  streams: ActivityStream[],
  options: BucketOptions,
): BucketedStreams {
  if (streams.length === 0) {
    return { buckets: [], sampleCount: 0 };
  }

  const sampleCount = Math.max(...streams.map((s) => s.data.length));
  const assignment = assignBuckets(streams, options, sampleCount);

  if ('error' in assignment) {
    return { buckets: [], sampleCount, note: assignment.error };
  }

  const metricStreams = streams.filter((s) => !IGNORED_STREAMS.has(s.type));

  const buckets: Bucket[] = assignment.indices.map((indices, bucketIndex) => {
    const metrics: Record<string, MetricSummary | undefined> = {};

    for (const stream of metricStreams) {
      const values: number[] = [];
      for (const i of indices) {
        const v = stream.data[i];
        // null means "no reading here" — averaging it as zero would invent data.
        if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
      }
      const summary = summarise(values);
      if (summary) metrics[stream.type] = summary;
    }

    // Speed is more legible as pace for runs; kept alongside, not instead of.
    const pace = formatPace(metrics['velocity_smooth']?.avg);

    return {
      label: assignment.labels[bucketIndex]!,
      samples: indices.length,
      ...(pace === undefined ? {} : { pace }),
      metrics,
    };
  });

  return { buckets, sampleCount };
}
