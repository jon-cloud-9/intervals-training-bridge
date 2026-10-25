import { describe, expect, it } from 'vitest';
import {
  IntervalsApiError,
  IntervalsClient,
  IntervalsTimeoutError,
} from '../src/intervals/client.js';
import { assertDateRange } from '../src/intervals/endpoints.js';
import type { EventPayload } from '../src/intervals/types.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A stub fetch that records calls and replays a canned response. */
function stubFetch(response: { status?: number; json?: unknown; text?: string }) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    calls.push({
      url: input.toString(),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const status = response.status ?? 200;
    const text = response.text ?? (response.json ? JSON.stringify(response.json) : '');
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function makeClient(fetchImpl: typeof fetch) {
  return new IntervalsClient({ apiKey: 'test-key', athleteId: 'i1', fetchImpl });
}

const RANGE = { oldest: '2026-07-27', newest: '2026-08-02' };

describe('auth', () => {
  it('sends basic auth with the literal username API_KEY', async () => {
    const { impl, calls } = stubFetch({ json: [] });
    await makeClient(impl).getWellness(RANGE);

    const header = calls[0]!.headers.Authorization!;
    expect(header.startsWith('Basic ')).toBe(true);
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString();
    expect(decoded).toBe('API_KEY:test-key');
  });
});

describe('date ranges', () => {
  it('rejects non yyyy-MM-dd dates', () => {
    expect(() => assertDateRange({ oldest: '2026-7-1', newest: '2026-07-07' })).toThrow(
      /yyyy-MM-dd/,
    );
    expect(() =>
      assertDateRange({ oldest: '2026-07-01T00:00:00', newest: '2026-07-07' }),
    ).toThrow(/yyyy-MM-dd/);
  });

  it('rejects an inverted range', () => {
    expect(() => assertDateRange({ oldest: '2026-08-02', newest: '2026-07-27' })).toThrow(
      /must not be after/,
    );
  });

  it('sends oldest and newest as query params', async () => {
    const { impl, calls } = stubFetch({ json: [] });
    await makeClient(impl).getWeekActivities(RANGE);

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/v1/athlete/i1/activities');
    expect(url.searchParams.get('oldest')).toBe('2026-07-27');
    expect(url.searchParams.get('newest')).toBe('2026-08-02');
  });
});

describe('getWeekEvents', () => {
  it('filters out non-WORKOUT calendar categories', async () => {
    const { impl } = stubFetch({
      json: [
        { id: 1, start_date_local: '2026-07-28T00:00:00', category: 'WORKOUT' },
        { id: 2, start_date_local: '2026-07-29T00:00:00', category: 'NOTE' },
        { id: 3, start_date_local: '2026-07-30T00:00:00', category: 'RACE_A' },
        { id: 4, start_date_local: '2026-07-31T00:00:00', category: 'WORKOUT' },
      ],
    });

    const events = await makeClient(impl).getWeekEvents(RANGE);
    expect(events.map((e) => e.id)).toEqual([1, 4]);
  });
});

describe('writes', () => {
  const payload: EventPayload = {
    start_date_local: '2026-08-03T00:00:00',
    category: 'WORKOUT',
    type: 'Run',
    name: 'Easy 40',
    description: '- 40m 65% Pace',
    moving_time: 2400,
    target: 'PACE',
  };

  it('POSTs the payload to the events endpoint', async () => {
    const { impl, calls } = stubFetch({ json: { id: 99 } });
    const created = await makeClient(impl).createWorkout(payload);

    expect(calls[0]!.method).toBe('POST');
    expect(new URL(calls[0]!.url).pathname).toBe('/api/v1/athlete/i1/events');
    expect(calls[0]!.body).toEqual(payload);
    expect(calls[0]!.headers['Content-Type']).toBe('application/json');
    expect(created.id).toBe(99);
  });

  it('PUTs to the per-event path on update', async () => {
    const { impl, calls } = stubFetch({ json: { id: 99 } });
    await makeClient(impl).updateWorkout(99, payload);

    expect(calls[0]!.method).toBe('PUT');
    expect(new URL(calls[0]!.url).pathname).toBe('/api/v1/athlete/i1/events/99');
  });

  it('DELETEs and tolerates an empty 204 body', async () => {
    const { impl, calls } = stubFetch({ status: 204, text: '' });
    await expect(makeClient(impl).deleteWorkout(99)).resolves.toBeUndefined();

    expect(calls[0]!.method).toBe('DELETE');
    expect(new URL(calls[0]!.url).pathname).toBe('/api/v1/athlete/i1/events/99');
  });
});

// Synthetic fixture shaped like a real GET /athlete/{id} response, trimmed to the
// fields this bridge reads. The full response is a large account object that
// includes the caller's own API key (`icu_api_key`) among dozens of unrelated
// preference fields — confirmed against a live account, after an earlier version
// of this client assumed a flat {ftp, heart_rate_zones, power_zones,
// run_zones} shape that was never checked against a real account and turned
// out to be wrong. getSportZoneSettings must pick the right entry out of this
// array rather than reading top-level fields.
const ACCOUNT_FIXTURE = {
  id: 'i1000001',
  icu_api_key: 'should-never-be-read-by-this-client',
  sportSettings: [
    {
      types: ['Ride', 'VirtualRide', 'MountainBikeRide', 'GravelRide', 'TrackRide', 'Cyclocross'],
      ftp: 240,
      power_zones: [55, 75, 90, 105, 120, 150, 999],
      power_zone_names: [
        'Active Recovery',
        'Endurance',
        'Tempo',
        'Threshold',
        'VO2 Max',
        'Anaerobic',
        'Neuromuscular',
      ],
      lthr: 165,
      max_hr: 185,
      hr_zones: [130, 140, 150, 160, 170, 180, 185],
      threshold_pace: null,
      pace_zones: null,
    },
    {
      types: ['Run', 'VirtualRun', 'TrailRun'],
      ftp: null,
      power_zones: null,
      lthr: 165,
      max_hr: 185,
      hr_zones: [130, 140, 150, 160, 170, 180, 185],
      threshold_pace: null,
      pace_zones: null,
    },
    {
      types: ['Swim', 'OpenWaterSwim'],
      ftp: null,
      lthr: 165,
      max_hr: 185,
      hr_zones: [130, 140, 150, 160, 170, 180, 185],
      threshold_pace: 1,
      pace_zones: null,
    },
  ],
};

describe('getSportZoneSettings', () => {
  it('finds the Ride entry for bike, with FTP as watts and zones as %FTP', async () => {
    const { impl } = stubFetch({ json: ACCOUNT_FIXTURE });
    const settings = await makeClient(impl).getSportZoneSettings('bike');

    expect(settings?.ftp).toBe(240);
    expect(settings?.power_zones).toEqual([55, 75, 90, 105, 120, 150, 999]);
  });

  it('finds the Run entry for run, where FTP and power zones are null', async () => {
    const { impl } = stubFetch({ json: ACCOUNT_FIXTURE });
    const settings = await makeClient(impl).getSportZoneSettings('run');

    expect(settings?.types).toContain('Run');
    expect(settings?.ftp).toBeNull();
    // Confirmed on a real account: pace zones are commonly unconfigured even
    // when HR zones are set up. Callers must not assume this is populated.
    expect(settings?.threshold_pace).toBeNull();
    expect(settings?.hr_zones).toEqual([130, 140, 150, 160, 170, 180, 185]);
  });

  it('returns undefined when no sportSettings entry matches', async () => {
    const { impl } = stubFetch({ json: { id: 'i1', sportSettings: [] } });
    const settings = await makeClient(impl).getSportZoneSettings('bike');

    expect(settings).toBeUndefined();
  });
});

describe('errors', () => {
  it('throws IntervalsApiError carrying status and path', async () => {
    const { impl } = stubFetch({ status: 403, text: 'forbidden' });

    await expect(makeClient(impl).getWellness(RANGE)).rejects.toThrow(IntervalsApiError);
    await expect(makeClient(impl).getWellness(RANGE)).rejects.toMatchObject({
      status: 403,
      method: 'GET',
      path: '/athlete/i1/wellness',
    });
  });

  it('does not leak the api key in the error message', async () => {
    const { impl } = stubFetch({ status: 500, text: 'boom' });
    const error = await makeClient(impl)
      .getWellness(RANGE)
      .catch((e: Error) => e);

    expect(error.message).not.toContain('test-key');
  });
});

describe('request timeout', () => {
  /** A fetch that never answers, but honours the abort signal like the real one. */
  const hangingFetch = ((_input: string | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;

  it('gives up with a plain-language error when intervals.icu does not answer', async () => {
    const client = new IntervalsClient({
      apiKey: 'test-key',
      athleteId: 'i1',
      fetchImpl: hangingFetch,
      timeoutMs: 20,
    });
    const error = await client.getWellness(RANGE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntervalsTimeoutError);
    expect(String((error as Error).message)).toMatch(/did not respond/);
    expect(String((error as Error).message)).toMatch(/internet connection/);
  });

  it('gives the same plain error when the body stalls after the headers', async () => {
    const stallingBody = (async (_input: string | URL, init?: RequestInit) =>
      ({
        ok: true,
        status: 200,
        text: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      }) as Response) as unknown as typeof fetch;
    const client = new IntervalsClient({
      apiKey: 'test-key',
      athleteId: 'i1',
      fetchImpl: stallingBody,
      timeoutMs: 20,
    });
    const error = await client.getWellness(RANGE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntervalsTimeoutError);
  });

  it('passes an abort signal to fetch on every request', async () => {
    let seen: AbortSignal | undefined;
    const impl = (async (_input: string | URL, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return { ok: true, status: 200, text: async () => '[]' } as Response;
    }) as unknown as typeof fetch;
    await makeClient(impl).getWellness(RANGE);
    expect(seen).toBeInstanceOf(AbortSignal);
  });
});
