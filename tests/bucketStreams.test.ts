import { describe, expect, it } from 'vitest';
import { bucketStreams, formatPace } from '../src/analysis/bucketStreams.js';
import type { ActivityStream } from '../src/intervals/types.js';

/** Build a synthetic stream set: one sample per second at a constant speed. */
function syntheticRun(options: {
  seconds: number;
  metresPerSecond: number;
  heartrate?: (i: number) => number;
  watts?: (i: number) => number;
}): ActivityStream[] {
  const { seconds, metresPerSecond } = options;
  const time: number[] = [];
  const distance: number[] = [];
  const heartrate: number[] = [];
  const watts: number[] = [];

  for (let i = 0; i < seconds; i += 1) {
    time.push(i);
    distance.push(i * metresPerSecond);
    heartrate.push(options.heartrate ? options.heartrate(i) : 150);
    watts.push(options.watts ? options.watts(i) : 200);
  }

  return [
    { type: 'time', data: time },
    { type: 'distance', data: distance },
    { type: 'heartrate', data: heartrate },
    { type: 'watts', data: watts },
  ];
}

describe('bucketStreams — distance bucketing', () => {
  it('collapses thousands of samples into one bucket per kilometre', () => {
    // 3km at 4:00/km => 720 samples.
    const streams = syntheticRun({ seconds: 720, metresPerSecond: 1000 / 240 });
    const result = bucketStreams(streams, { bucketBy: 'km' });

    expect(result.buckets).toHaveLength(3);
    expect(result.sampleCount).toBe(720);
    // The whole point: the model sees 3 rows, not 720.
    expect(result.buckets.length).toBeLessThan(result.sampleCount / 100);
  });

  it('labels buckets by kilometre', () => {
    const streams = syntheticRun({ seconds: 480, metresPerSecond: 1000 / 240 });
    const result = bucketStreams(streams, { bucketBy: 'km' });

    expect(result.buckets.map((b) => b.label)).toEqual(['km 1', 'km 2']);
  });

  it('reports min, average and max per metric', () => {
    const streams = syntheticRun({
      seconds: 240,
      metresPerSecond: 1000 / 240,
      heartrate: (i) => 140 + (i % 21), // 140..160
    });
    const result = bucketStreams(streams, { bucketBy: 'km' });
    const hr = result.buckets[0]!.metrics['heartrate']!;

    expect(hr.min).toBe(140);
    expect(hr.max).toBe(160);
    expect(hr.avg).toBeGreaterThan(140);
    expect(hr.avg).toBeLessThan(160);
  });

  // Power falls while heart rate holds flat:
  // output collapses with no matching rise in HR.
  it('surfaces a power collapse against flat heart rate', () => {
    const streams = syntheticRun({
      seconds: 720,
      metresPerSecond: 1000 / 240,
      heartrate: () => 140,
      watts: (i) => (i < 480 ? 180 : 140),
    });
    const result = bucketStreams(streams, { bucketBy: 'km' });

    const watts = result.buckets.map((b) => Math.round(b.metrics['watts']!.avg));
    const hr = result.buckets.map((b) => Math.round(b.metrics['heartrate']!.avg));

    expect(watts).toEqual([180, 180, 140]);
    expect(hr).toEqual([140, 140, 140]);
  });
});

describe('bucketStreams — time bucketing', () => {
  it('buckets by fixed minutes when asked', () => {
    const streams = syntheticRun({ seconds: 900, metresPerSecond: 3 });
    const result = bucketStreams(streams, { bucketBy: 'time', minutes: 5 });

    expect(result.buckets).toHaveLength(3);
    expect(result.buckets.map((b) => b.label)).toEqual(['0:00–5:00', '5:00–10:00', '10:00–15:00']);
  });
});

describe('bucketStreams — robustness', () => {
  it('ignores null samples rather than treating them as zero', () => {
    const streams: ActivityStream[] = [
      { type: 'time', data: [0, 1, 2, 3] },
      { type: 'distance', data: [0, 500, 1000, 1500] },
      { type: 'heartrate', data: [150, null, null, 160] },
    ];
    const result = bucketStreams(streams, { bucketBy: 'km' });

    // A null must not drag the average toward zero.
    expect(result.buckets[0]!.metrics['heartrate']!.avg).toBe(150);
  });

  it('omits a metric entirely when it has no valid samples in a bucket', () => {
    const streams: ActivityStream[] = [
      { type: 'time', data: [0, 1] },
      { type: 'distance', data: [0, 500] },
      { type: 'watts', data: [null, null] },
    ];
    const result = bucketStreams(streams, { bucketBy: 'km' });

    expect(result.buckets[0]!.metrics['watts']).toBeUndefined();
  });

  it('returns no buckets when the distance stream is missing and km bucketing was asked for', () => {
    const streams: ActivityStream[] = [
      { type: 'time', data: [0, 1] },
      { type: 'heartrate', data: [150, 151] },
    ];
    const result = bucketStreams(streams, { bucketBy: 'km' });

    expect(result.buckets).toEqual([]);
    expect(result.note).toMatch(/distance/i);
  });

  it('drops latlng, which is location data with no analytical value here', () => {
    const streams: ActivityStream[] = [
      { type: 'time', data: [0, 1] },
      { type: 'distance', data: [0, 1500] },
      { type: 'latlng', data: [1, 2] },
      { type: 'heartrate', data: [150, 151] },
    ];
    const result = bucketStreams(streams, { bucketBy: 'km' });

    expect(result.buckets[0]!.metrics['latlng']).toBeUndefined();
    expect(result.buckets[0]!.metrics['heartrate']).toBeDefined();
  });

  it('handles an empty stream set without throwing', () => {
    const result = bucketStreams([], { bucketBy: 'km' });
    expect(result.buckets).toEqual([]);
  });
});

describe('bucketStreams — pace derivation', () => {
  it('exposes pace as a formatted string, never as a mislabelled speed number', () => {
    const streams: ActivityStream[] = [
      { type: 'time', data: [0, 1, 2, 3] },
      { type: 'distance', data: [0, 400, 800, 1200] },
      // 1000/240 m/s == 4:00/km
      { type: 'velocity_smooth', data: [1000 / 240, 1000 / 240, 1000 / 240, 1000 / 240] },
    ];
    const result = bucketStreams(streams, { bucketBy: 'km' });

    expect(result.buckets[0]!.pace).toBe('4:00');
    // The raw speed stays under its own name and units.
    expect(result.buckets[0]!.metrics['velocity_smooth']!.avg).toBeCloseTo(4.17, 1);
    expect(result.buckets[0]!.metrics['pace_min_per_km']).toBeUndefined();
  });

  it('omits pace entirely when there is no speed stream', () => {
    const streams: ActivityStream[] = [
      { type: 'time', data: [0, 1] },
      { type: 'distance', data: [0, 1500] },
      { type: 'heartrate', data: [150, 151] },
    ];
    const result = bucketStreams(streams, { bucketBy: 'km' });

    expect(result.buckets[0]!.pace).toBeUndefined();
  });
});

describe('formatPace', () => {
  it('converts metres per second to min/km', () => {
    expect(formatPace(1000 / 240)).toBe('4:00');
    expect(formatPace(3.7037037)).toBe('4:30');
  });

  it('returns undefined for non-positive speed rather than dividing by zero', () => {
    expect(formatPace(0)).toBeUndefined();
    expect(formatPace(undefined)).toBeUndefined();
  });
});
