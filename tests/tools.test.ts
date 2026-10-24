/**
 * End-to-end over the MCP protocol, against an in-memory transport and a stub
 * intervals.icu client. Nothing here touches the network.
 *
 * The point of driving a real client/server pair rather than calling handlers
 * directly is the dryRun default: it has to hold when the field is *absent from
 * the wire*, which is the case that matters and the one a direct call cannot
 * reproduce.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import { DEFAULT_LIMITS } from '../src/workout/validate.js';
import type { IntervalsClient } from '../src/intervals/client.js';
import type {
  Activity,
  ActivityLap,
  ActivityStream,
  CalendarEvent,
  EventPayload,
  WellnessRecord,
} from '../src/intervals/types.js';

interface Recorder {
  created: EventPayload[];
  updated: { eventId: number; payload: EventPayload }[];
  deleted: number[];
}

function stubClient(seed: {
  wellness?: WellnessRecord[];
  activities?: Activity[];
  events?: CalendarEvent[];
  laps?: ActivityLap[];
  streams?: ActivityStream[];
  failWith?: Error;
}): { client: IntervalsClient; recorder: Recorder } {
  const recorder: Recorder = { created: [], updated: [], deleted: [] };

  const client = {
    getWellness: async () => {
      if (seed.failWith) throw seed.failWith;
      return seed.wellness ?? [];
    },
    getWeekActivities: async () => seed.activities ?? [],
    getWeekEvents: async () => seed.events ?? [],
    getActivityLaps: async () => {
      if (seed.failWith) throw seed.failWith;
      return seed.laps ?? [];
    },
    getActivityStreams: async () => seed.streams ?? [],
    getSportZoneSettings: async (sport: 'run' | 'bike') =>
      sport === 'bike' ? { types: ['Ride'], ftp: 240 } : { types: ['Run'], ftp: null },
    createWorkout: async (payload: EventPayload) => {
      recorder.created.push(payload);
      return { id: 4242, ...payload } as unknown as CalendarEvent;
    },
    updateWorkout: async (eventId: number, payload: EventPayload) => {
      recorder.updated.push({ eventId, payload });
      return { id: eventId, ...payload } as unknown as CalendarEvent;
    },
    deleteWorkout: async (eventId: number) => {
      recorder.deleted.push(eventId);
    },
  } as unknown as IntervalsClient;

  return { client, recorder };
}

async function connect(client: IntervalsClient, options: { timezone?: string } = {}) {
  const server = buildServer({ client, limits: DEFAULT_LIMITS, ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([mcp.connect(clientTransport), server.connect(serverTransport)]);
  return mcp;
}

function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

const EASY_RUN = {
  name: 'Easy 40',
  sport: 'run',
  date: '2026-08-03',
  steps: [
    {
      type: 'run',
      duration: { kind: 'time', seconds: 2400 },
      paceTarget: { kind: 'pctThreshold', min: 62, max: 68 },
    },
  ],
};

/**
 * Synthetic 5k lap values. The activity summary would report averageHr 150;
 * these laps show 140/155/160/155/145. That gap is the reason this tool exists.
 */
const FIVE_K_LAPS: ActivityLap[] = [
  { type: 'WORK', distance: 1000, moving_time: 290, average_heartrate: 140, average_speed: 3.4482759, average_cadence: 86, average_gradient: 0.0 },
  { type: 'WORK', distance: 1000, moving_time: 320, average_heartrate: 155, average_speed: 3.125, average_cadence: 84, average_gradient: 0.01 },
  { type: 'WORK', distance: 1000, moving_time: 295, average_heartrate: 160, average_speed: 3.3898305, average_cadence: 85, average_gradient: -0.01 },
  { type: 'RECOVERY', distance: 5, moving_time: 1, average_heartrate: 149, average_speed: 5.0, average_cadence: 85, average_gradient: 0.0 },
  { type: 'WORK', distance: 1000, moving_time: 290, average_heartrate: 155, average_speed: 3.4482759, average_cadence: 86, average_gradient: 0.0 },
  { type: 'WORK', distance: 1000, moving_time: 300, average_heartrate: 145, average_speed: 3.3333333, average_cadence: 85, average_gradient: 0.004 },
  { type: 'WORK', distance: 120, moving_time: 25, average_heartrate: 150, average_speed: 4.8, average_cadence: 88, average_gradient: 0.0 },
];

describe('tool registration', () => {
  it('exposes exactly the six planned tools', async () => {
    const { client } = stubClient({});
    const mcp = await connect(client);

    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'delete_workout',
      'get_activity_laps',
      'get_activity_streams',
      'get_training_context',
      'push_workout',
      'update_workout',
    ]);
  });

  it('marks both analysis tools read-only', async () => {
    const { client } = stubClient({});
    const mcp = await connect(client);
    const { tools } = await mcp.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(byName['get_activity_laps']!.annotations?.readOnlyHint).toBe(true);
    expect(byName['get_activity_streams']!.annotations?.readOnlyHint).toBe(true);
  });

  it('marks get_training_context read-only and the writes not', async () => {
    const { client } = stubClient({});
    const mcp = await connect(client);
    const { tools } = await mcp.listTools();

    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName['get_training_context']!.annotations?.readOnlyHint).toBe(true);
    expect(byName['push_workout']!.annotations?.readOnlyHint).toBe(false);
    expect(byName['delete_workout']!.annotations?.destructiveHint).toBe(true);
  });
});

// ── The safety property this whole design turns on ───────────────────────────

describe('dryRun defaults to true when omitted from the call', () => {
  let recorder: Recorder;
  let mcp: Awaited<ReturnType<typeof connect>>;

  beforeEach(async () => {
    const stub = stubClient({});
    recorder = stub.recorder;
    mcp = await connect(stub.client);
  });

  it('push_workout writes nothing', async () => {
    const result = await mcp.callTool({
      name: 'push_workout',
      arguments: { workout: EASY_RUN },
    });

    expect(payloadOf(result).dryRun).toBe(true);
    expect(recorder.created).toEqual([]);
  });

  it('update_workout writes nothing', async () => {
    const result = await mcp.callTool({
      name: 'update_workout',
      arguments: { eventId: 77, workout: EASY_RUN },
    });

    expect(payloadOf(result).dryRun).toBe(true);
    expect(recorder.updated).toEqual([]);
  });

  it('delete_workout deletes nothing', async () => {
    const result = await mcp.callTool({
      name: 'delete_workout',
      arguments: { eventId: 77 },
    });

    expect(payloadOf(result).dryRun).toBe(true);
    expect(recorder.deleted).toEqual([]);
  });

  it('returns the exact payload that would have been sent', async () => {
    const result = await mcp.callTool({
      name: 'push_workout',
      arguments: { workout: EASY_RUN },
    });

    expect(payloadOf(result).wouldCreate).toEqual({
      start_date_local: '2026-08-03T00:00:00',
      category: 'WORKOUT',
      type: 'Run',
      name: 'Easy 40',
      description: '- 40m 62-68% Pace',
      target: 'PACE',
      moving_time: 2400,
    });
    expect(payloadOf(result).renderedWorkout).toBe('- 40m 62-68% Pace');
  });
});

describe('dryRun: false writes', () => {
  it('push_workout creates the event only when explicitly told to', async () => {
    const { client, recorder } = stubClient({});
    const mcp = await connect(client);

    const result = await mcp.callTool({
      name: 'push_workout',
      arguments: { workout: EASY_RUN, dryRun: false },
    });

    expect(recorder.created).toHaveLength(1);
    expect(recorder.created[0]!.name).toBe('Easy 40');
    expect(payloadOf(result)).toMatchObject({
      dryRun: false,
      created: { eventId: 4242, date: '2026-08-03' },
    });
  });

  it('update_workout targets the given event id', async () => {
    const { client, recorder } = stubClient({});
    const mcp = await connect(client);

    await mcp.callTool({
      name: 'update_workout',
      arguments: { eventId: 77, workout: EASY_RUN, dryRun: false },
    });

    expect(recorder.updated).toEqual([
      { eventId: 77, payload: expect.objectContaining({ name: 'Easy 40' }) },
    ]);
  });

  it('delete_workout removes the given event id', async () => {
    const { client, recorder } = stubClient({});
    const mcp = await connect(client);

    await mcp.callTool({ name: 'delete_workout', arguments: { eventId: 77, dryRun: false } });

    expect(recorder.deleted).toEqual([77]);
  });
});

describe('validation at the tool boundary', () => {
  it('rejects an implausible workout without writing, even with dryRun false', async () => {
    const { client, recorder } = stubClient({});
    const mcp = await connect(client);

    const result = await mcp.callTool({
      name: 'push_workout',
      arguments: {
        dryRun: false,
        workout: {
          ...EASY_RUN,
          steps: [
            {
              type: 'run',
              duration: { kind: 'time', seconds: 600 },
              paceTarget: { kind: 'absolute', min: '0:45', max: '0:50' },
            },
          ],
        },
      },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(payloadOf(result).error).toBe('Workout failed validation');
    expect(recorder.created).toEqual([]);
  });

  it('rejects a schema-invalid workout at the protocol layer', async () => {
    const { client, recorder } = stubClient({});
    const mcp = await connect(client);

    const result = await mcp.callTool({
      name: 'push_workout',
      arguments: { workout: { ...EASY_RUN, date: '03/08/2026' } },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(recorder.created).toEqual([]);
  });
});

describe('get_activity_laps', () => {
  it('surfaces the per-lap heart-rate pattern that the summary average conceals', async () => {
    const { client } = stubClient({ laps: FIVE_K_LAPS });
    const mcp = await connect(client);

    const result = await mcp.callTool({
      name: 'get_activity_laps',
      arguments: { activityId: 'i1000001' },
    });
    const body = payloadOf(result) as Record<string, any>;

    expect(body.lapCount).toBe(7);
    // The activity summary for this session reports a single averageHr of 150.
    expect(body.laps.map((l: any) => l.averageHr)).toEqual([140, 155, 160, 149, 155, 145, 150]);
  });

  it('converts speed to pace, matching the fixture splits', async () => {
    const { client } = stubClient({ laps: FIVE_K_LAPS });
    const mcp = await connect(client);

    const result = await mcp.callTool({
      name: 'get_activity_laps',
      arguments: { activityId: 'i1000001' },
    });
    const body = payloadOf(result) as Record<string, any>;

    // Full-kilometre WORK laps only; the km-2 dip to 5:20 is the signal.
    const kmPaces = body.laps
      .filter((l: any) => l.type === 'WORK' && l.distanceKm > 0.9)
      .map((l: any) => l.pace);
    expect(kmPaces).toEqual(['4:50', '5:20', '4:55', '4:50', '5:00']);
  });

  it('keeps lap type visible so sub-second artifacts are not mistaken for intervals', async () => {
    const { client } = stubClient({ laps: FIVE_K_LAPS });
    const mcp = await connect(client);

    const result = await mcp.callTool({
      name: 'get_activity_laps',
      arguments: { activityId: 'i1000001' },
    });
    const body = payloadOf(result) as Record<string, any>;

    const artifact = body.laps[3];
    expect(artifact.type).toBe('RECOVERY');
    expect(artifact.durationSeconds).toBe(1);
  });

  it('converts gradient from fraction to percent', async () => {
    const { client } = stubClient({ laps: FIVE_K_LAPS });
    const mcp = await connect(client);

    const result = await mcp.callTool({
      name: 'get_activity_laps',
      arguments: { activityId: 'i1000001' },
    });
    const body = payloadOf(result) as Record<string, any>;

    expect(body.laps[1].gradientPercent).toBeCloseTo(1.0, 1);
  });

  it('reports an empty result rather than erroring when no laps exist', async () => {
    const { client } = stubClient({ laps: [] });
    const mcp = await connect(client);

    const result = await mcp.callTool({
      name: 'get_activity_laps',
      arguments: { activityId: 'iNope' },
    });
    const body = payloadOf(result) as Record<string, any>;

    expect(body.laps).toEqual([]);
    expect(body.note).toMatch(/No lap data/i);
  });

  it('surfaces an API failure as a tool error', async () => {
    const { client } = stubClient({ failWith: new Error('intervals.icu 500') });
    const mcp = await connect(client);

    const result = await mcp.callTool({
      name: 'get_activity_laps',
      arguments: { activityId: 'i1000001' },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});

describe('get_activity_streams', () => {
  /** 3km at a constant 4:00/km, with power collapsing in the final kilometre. */
  function collapseStreams(): ActivityStream[] {
    const time: number[] = [];
    const distance: number[] = [];
    const heartrate: number[] = [];
    const watts: number[] = [];
    for (let i = 0; i < 720; i += 1) {
      time.push(i);
      distance.push(i * (1000 / 240));
      heartrate.push(140);
      watts.push(i < 480 ? 180 : 140);
    }
    return [
      { type: 'time', data: time },
      { type: 'distance', data: distance },
      { type: 'heartrate', data: heartrate },
      { type: 'watts', data: watts },
    ];
  }

  it('aggregates rather than returning raw samples', async () => {
    const { client } = stubClient({ streams: collapseStreams() });
    const mcp = await connect(client);

    const result = await mcp.callTool({
      name: 'get_activity_streams',
      arguments: { activityId: 'i1' },
    });
    const body = payloadOf(result) as Record<string, any>;

    expect(body.rawSampleCount).toBe(720);
    expect(body.bucketCount).toBe(3);
    // The guarantee that matters: the model never sees 720 rows.
    expect(body.buckets).toHaveLength(3);
  });

  it('reveals output collapsing while heart rate holds flat', async () => {
    const { client } = stubClient({ streams: collapseStreams() });
    const mcp = await connect(client);

    const result = await mcp.callTool({
      name: 'get_activity_streams',
      arguments: { activityId: 'i1' },
    });
    const body = payloadOf(result) as Record<string, any>;

    expect(body.buckets.map((b: any) => Math.round(b.metrics.watts.avg))).toEqual([180, 180, 140]);
    expect(body.buckets.map((b: any) => Math.round(b.metrics.heartrate.avg))).toEqual([140, 140, 140]);
  });

  it('defaults to kilometre bucketing when not specified', async () => {
    const { client } = stubClient({ streams: collapseStreams() });
    const mcp = await connect(client);

    const result = await mcp.callTool({
      name: 'get_activity_streams',
      arguments: { activityId: 'i1' },
    });

    expect((payloadOf(result) as Record<string, any>).bucketedBy).toBe('kilometre');
  });

  it('buckets by time when asked', async () => {
    const { client } = stubClient({ streams: collapseStreams() });
    const mcp = await connect(client);

    const result = await mcp.callTool({
      name: 'get_activity_streams',
      arguments: { activityId: 'i1', bucketBy: 'time', minutes: 5 },
    });
    const body = payloadOf(result) as Record<string, any>;

    expect(body.bucketedBy).toBe('5 min');
    expect(body.bucketCount).toBe(3);
  });

  it('reports an empty result rather than erroring when no streams exist', async () => {
    const { client } = stubClient({ streams: [] });
    const mcp = await connect(client);

    const result = await mcp.callTool({
      name: 'get_activity_streams',
      arguments: { activityId: 'iNope' },
    });
    const body = payloadOf(result) as Record<string, any>;

    expect(body.buckets).toEqual([]);
    expect(body.note).toMatch(/No stream data/i);
  });
});

describe('get_training_context', () => {
  it('uses today\'s wellness even when the range extends into the future, where intervals.icu forward-projects ctl/atl but leaves everything else blank', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T12:00:00Z'));
    try {
      const { client } = stubClient({
        wellness: [
          { id: '2026-07-28', ctl: 40.0, atl: 30.0, restingHR: 58, hrv: null },
          // Today: the real, fully-populated record.
          { id: '2026-07-29', ctl: 40.0, atl: 32.0, restingHR: 58, hrv: 70 },
          // Future: intervals.icu forward-projects ctl/atl decay for dates
          // that haven't happened yet, with no actual wellness recorded.
          { id: '2026-07-30', ctl: 38.5, atl: 29.0 },
          { id: '2026-07-31', ctl: 37.0, atl: 27.0 },
        ],
      });
      const mcp = await connect(client);

      const result = await mcp.callTool({
        name: 'get_training_context',
        arguments: { startDate: '2026-07-27', endDate: '2026-08-05' },
      });
      const body = payloadOf(result) as Record<string, any>;

      expect(body.wellness).toMatchObject({
        date: '2026-07-29',
        fitnessCtl: 40,
        fatigueAtl: 32,
        restingHr: 58,
        hrv: 70,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    // 23:30 UTC on the 29th is already the 30th in Auckland.
    ['Pacific/Auckland', '2026-07-29T23:30:00Z', '2026-07-30'],
    // 03:00 UTC on the 30th is still the 29th in Los Angeles.
    ['America/Los_Angeles', '2026-07-30T03:00:00Z', '2026-07-29'],
  ])('treats "today" as the date in the configured time zone (%s)', async (timezone, now, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    try {
      const { client } = stubClient({
        wellness: [
          { id: '2026-07-29', ctl: 40.0, atl: 30.0, restingHR: 58, hrv: 70 },
          { id: '2026-07-30', ctl: 41.0, atl: 31.0, restingHR: 57, hrv: 72 },
        ],
      });
      const mcp = await connect(client, { timezone });

      const result = await mcp.callTool({
        name: 'get_training_context',
        arguments: { startDate: '2026-07-27', endDate: '2026-08-02' },
      });
      const body = payloadOf(result) as Record<string, any>;
      expect(body.wellness.date).toBe(expected);
    } finally {
      vi.useRealTimers();
    }
  });

  it('summarises wellness, sessions and the planned-vs-completed reconciliation', async () => {
    const { client } = stubClient({
      wellness: [{ id: '2026-07-28', ctl: 52.4, atl: 61.9, restingHR: 48, hrv: 71, sleepSecs: 27_000 }],
      events: [
        {
          id: 11,
          start_date_local: '2026-07-28T00:00:00',
          category: 'WORKOUT',
          type: 'Run',
          name: 'Threshold',
          moving_time: 3600,
        },
        {
          id: 12,
          start_date_local: '2026-07-29T00:00:00',
          category: 'WORKOUT',
          type: 'Run',
          name: 'Easy',
          moving_time: 2400,
        },
      ],
      activities: [
        { id: 'a1', start_date_local: '2026-07-28T07:00:00', type: 'Run', moving_time: 3500 },
        { id: 'a2', start_date_local: '2026-07-30T18:00:00', type: 'Ride', moving_time: 2000 },
      ],
    });
    const mcp = await connect(client);

    const result = await mcp.callTool({
      name: 'get_training_context',
      arguments: { startDate: '2026-07-27', endDate: '2026-08-02' },
    });
    const body = payloadOf(result) as Record<string, any>;

    expect(body.wellness).toMatchObject({ fitnessCtl: 52.4, fatigueAtl: 61.9, form: -9.5 });
    expect(body.plannedVsCompleted.completedAsPlanned).toHaveLength(1);
    expect(body.plannedVsCompleted.untouched).toHaveLength(1);
    expect(body.plannedVsCompleted.unplannedExtra).toHaveLength(1);
    // The event id must survive into the summary or adjustments cannot be made.
    expect(body.plannedVsCompleted.untouched[0].eventId).toBe(12);
  });

  it('surfaces an API failure as a tool error rather than throwing', async () => {
    const { client } = stubClient({ failWith: new Error('intervals.icu 503') });
    const mcp = await connect(client);

    const result = await mcp.callTool({
      name: 'get_training_context',
      arguments: { startDate: '2026-07-27', endDate: '2026-08-02' },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(payloadOf(result).error).toBe('Could not fetch training context');
  });
});
