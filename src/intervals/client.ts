/**
 * Thin wrapper over the intervals.icu REST API.
 *
 * It knows about HTTP and the
 * wire format, and nothing about training. Config arrives as constructor
 * arguments rather than by importing `config.ts`, so tests can construct a
 * client against a stub `fetch` with no environment set up.
 *
 * Auth is HTTP basic with the literal username "API_KEY" and the athlete's key
 * as the password.
 */
import { getLogger } from '../logger.js';
import { assertDateRange, endpoints, type DateRange } from './endpoints.js';
import type {
  Activity,
  ActivityLap,
  ActivityStream,
  AthleteAccount,
  CalendarEvent,
  EventPayload,
  SportZoneSettings,
  WellnessRecord,
} from './types.js';

/** Which `sportSettings[].types` entry to look for a given internal sport. */
const SPORT_TYPE_MARKER: Record<'run' | 'bike', string> = { run: 'Run', bike: 'Ride' };

const log = getLogger('intervals.client');

export interface IntervalsClientOptions {
  apiKey: string;
  athleteId: string;
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Give up on a request after this long. Defaults to 10 seconds. */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

/** intervals.icu did not answer in time. */
export class IntervalsTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(
      `intervals.icu did not respond within ${Math.round(timeoutMs / 1000)} seconds ` +
        `(${method} ${path}). Check your internet connection, or try again in a minute ` +
        'in case intervals.icu is busy.',
    );
    this.name = 'IntervalsTimeoutError';
  }
}

/** An API call that returned a non-2xx status. */
export class IntervalsApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`intervals.icu ${method} ${path} failed: ${status} ${body}`.trim());
    this.name = 'IntervalsApiError';
  }
}

export class IntervalsClient {
  private readonly apiKey: string;
  private readonly athleteId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: IntervalsClientOptions) {
    this.apiKey = options.apiKey;
    this.athleteId = options.athleteId;
    this.baseUrl = (options.baseUrl ?? 'https://intervals.icu/api/v1').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private authHeader(): string {
    // Username is the literal string "API_KEY"; the key itself is the password.
    return `Basic ${Buffer.from(`API_KEY:${this.apiKey}`).toString('base64')}`;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: 'application/json',
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    log.debug('request', { method, path, query: options.query });

    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      if (signal.aborted) {
        log.error('request timed out', { method, path, timeoutMs: this.timeoutMs });
        throw new IntervalsTimeoutError(method, path, this.timeoutMs);
      }
      throw error;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // Never log the URL with credentials; path and status are enough to debug.
      log.error('request failed', { method, path, status: response.status });
      throw new IntervalsApiError(response.status, method, path, text);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (text.length === 0) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  /** Daily wellness — CTL/ATL, resting HR, HRV, sleep. */
  async getWellness(range: DateRange): Promise<WellnessRecord[]> {
    assertDateRange(range);
    return this.request<WellnessRecord[]>('GET', endpoints.wellness(this.athleteId), {
      query: { oldest: range.oldest, newest: range.newest },
    });
  }

  /** Completed activities in a date range — what actually happened. */
  async getWeekActivities(range: DateRange): Promise<Activity[]> {
    assertDateRange(range);
    return this.request<Activity[]>('GET', endpoints.activities(this.athleteId), {
      query: { oldest: range.oldest, newest: range.newest },
    });
  }

  /**
   * Calendar events in a date range — what is currently planned.
   * Filters to `category: 'WORKOUT'`; notes, races and holidays also live here.
   */
  async getWeekEvents(range: DateRange): Promise<CalendarEvent[]> {
    assertDateRange(range);
    const events = await this.request<CalendarEvent[]>(
      'GET',
      endpoints.events(this.athleteId),
      { query: { oldest: range.oldest, newest: range.newest } },
    );
    return (events ?? []).filter((event) => event.category === 'WORKOUT');
  }

  /**
   * Zone configuration for one sport — FTP, power/HR/pace zone boundaries —
   * used to bound validation. Fetches the full account object and returns
   * only the matching `sportSettings` entry; the account response also
   * contains the caller's own API key, so nothing beyond `sportSettings` is
   * ever retained or logged here.
   *
   * Returns undefined if the athlete has no configuration for that sport
   * group at all (distinct from having the group but leaving fields null).
   */
  async getSportZoneSettings(sport: 'run' | 'bike'): Promise<SportZoneSettings | undefined> {
    const account = await this.request<AthleteAccount>('GET', endpoints.athlete(this.athleteId));
    const marker = SPORT_TYPE_MARKER[sport];
    return account.sportSettings?.find((entry) => entry.types?.includes(marker));
  }

  /**
   * Per-lap breakdown for one activity.
   *
   * This is what summary data cannot give you: a 5k effort can return lap HR of
   * 140/155/160/155/145 where the activity summary reports a single average of
   * 150 — concealing both the mid-effort dip and an unreliable-sensor pattern.
   */
  async getActivityLaps(activityId: string): Promise<ActivityLap[]> {
    const response = await this.request<{ icu_intervals?: ActivityLap[] }>(
      'GET',
      endpoints.activityIntervals(activityId),
    );
    return response?.icu_intervals ?? [];
  }

  /**
   * Raw time-series streams for one activity.
   *
   * Deliberately not exposed directly to the model — a five-hour ride is roughly
   * 18,000 samples across 11 streams. Callers aggregate first; see
   * `src/analysis/bucketStreams.ts`.
   */
  async getActivityStreams(activityId: string): Promise<ActivityStream[]> {
    const streams = await this.request<ActivityStream[]>(
      'GET',
      endpoints.activityStreams(activityId),
    );
    return streams ?? [];
  }

  /** Create a planned workout on the calendar. */
  async createWorkout(payload: EventPayload): Promise<CalendarEvent> {
    log.info('creating workout', {
      date: payload.start_date_local,
      type: payload.type,
      name: payload.name,
    });
    const created = await this.request<CalendarEvent>(
      'POST',
      endpoints.events(this.athleteId),
      { body: payload },
    );
    log.info('created workout', { eventId: created?.id, name: payload.name });
    return created;
  }

  /** Replace an existing planned workout. */
  async updateWorkout(eventId: number, payload: EventPayload): Promise<CalendarEvent> {
    log.info('updating workout', {
      eventId,
      date: payload.start_date_local,
      name: payload.name,
    });
    const updated = await this.request<CalendarEvent>(
      'PUT',
      endpoints.event(this.athleteId, eventId),
      { body: payload },
    );
    log.info('updated workout', { eventId, name: payload.name });
    return updated;
  }

  /** Remove a planned workout. */
  async deleteWorkout(eventId: number): Promise<void> {
    log.info('deleting workout', { eventId });
    await this.request<void>('DELETE', endpoints.event(this.athleteId, eventId));
    log.info('deleted workout', { eventId });
  }
}
