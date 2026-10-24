import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { assertHttpAuthConfigured, buildHttpApp } from '../src/server.js';
import { DEFAULT_LIMITS } from '../src/workout/validate.js';
import type { Config } from '../src/config.js';
import type { IntervalsClient } from '../src/intervals/client.js';

function config(overrides: Partial<Config> = {}): Config {
  return {
    intervalsApiKey: 'test-key',
    intervalsAthleteId: '0',
    intervalsBaseUrl: 'https://example.invalid',
    httpPort: 8787,
    httpHost: '127.0.0.1',
    mcpAuthToken: '',
    allowUnauthenticated: false,
    rateLimitPerMinute: 120,
    logLevel: 'error',
    logsPath: '/tmp/gtb-test-logs',
    timezone: 'Europe/London',
    ...overrides,
  };
}

const TOKEN = 'a'.repeat(32);

describe('fail-closed startup', () => {
  // The failure mode of starting unauthenticated is an open write endpoint on
  // the public internet, which is far worse than the process refusing to boot.
  it('refuses to start HTTP mode with no token', () => {
    expect(() => assertHttpAuthConfigured(config())).toThrow(/MCP_AUTH_TOKEN/);
  });

  it('refuses a token short enough to be guessable', () => {
    expect(() => assertHttpAuthConfigured(config({ mcpAuthToken: 'short' }))).toThrow(/32/);
  });

  it('accepts a sufficiently long token', () => {
    expect(() => assertHttpAuthConfigured(config({ mcpAuthToken: TOKEN }))).not.toThrow();
  });

  it('allows an explicit opt-out for localhost-only development', () => {
    expect(() => assertHttpAuthConfigured(config({ allowUnauthenticated: true }))).not.toThrow();
  });

  it('does not put the token in the error message', () => {
    const error = (() => {
      try {
        assertHttpAuthConfigured(config({ mcpAuthToken: 'short-but-secret' }));
        return null;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(error).not.toBeNull();
    expect(error!.message).not.toContain('short-but-secret');
  });
});

// ── Integration ──────────────────────────────────────────────────────────────
// Driven through the real Express app via supertest rather than a bound port,
// so the middleware order and status codes are exercised exactly as deployed.

function testApp(overrides: Partial<Config> = {}) {
  const client = {
    getWellness: async () => [],
    getWeekActivities: async () => [],
    getWeekEvents: async () => [],
    getSportZoneSettings: async () => undefined,
  } as unknown as IntervalsClient;

  return buildHttpApp(config({ mcpAuthToken: TOKEN, ...overrides }), {
    client,
    limits: DEFAULT_LIMITS,
  });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};

const MCP_ACCEPT = 'application/json, text/event-stream';

describe('public endpoint auth', () => {
  it('rejects an unauthenticated /mcp request', async () => {
    const res = await request(testApp()).post('/mcp').send(INITIALIZE);

    expect(res.status).toBe(401);
  });

  // A WWW-Authenticate header is what makes Claude begin OAuth discovery. We
  // run no authorization server, so advertising it would turn a plain
  // wrong-credential error into a confusing OAuth failure.
  it('returns a bare 401 that does not advertise OAuth discovery', async () => {
    const res = await request(testApp()).post('/mcp').send(INITIALIZE);

    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  it('rejects a wrong token', async () => {
    const res = await request(testApp())
      .post('/mcp')
      .set('Authorization', `Bearer ${'b'.repeat(32)}`)
      .send(INITIALIZE);

    expect(res.status).toBe(401);
  });

  it('accepts the correct token and completes an MCP initialize', async () => {
    const res = await request(testApp())
      .post('/mcp')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Accept', MCP_ACCEPT)
      .send(INITIALIZE);

    expect(res.status).toBe(200);
    expect(res.text).toContain('intervals-training-bridge');
  });

  it('accepts the token via x-api-key as well', async () => {
    const res = await request(testApp())
      .post('/mcp')
      .set('x-api-key', TOKEN)
      .set('Accept', MCP_ACCEPT)
      .send(INITIALIZE);

    expect(res.status).toBe(200);
  });

  it('leaves /health open, so uptime checks do not need the secret', async () => {
    const res = await request(testApp()).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('never echoes the token in a response body', async () => {
    const rejected = await request(testApp()).post('/mcp').send(INITIALIZE);
    const accepted = await request(testApp())
      .post('/mcp')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Accept', MCP_ACCEPT)
      .send(INITIALIZE);

    expect(rejected.text).not.toContain(TOKEN);
    expect(accepted.text).not.toContain(TOKEN);
  });

  it('skips auth entirely under the explicit opt-out', async () => {
    const res = await request(testApp({ allowUnauthenticated: true }))
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .send(INITIALIZE);

    expect(res.status).toBe(200);
  });
});

describe('rate limiting', () => {
  // Ordered before auth so token brute-forcing is throttled by the same budget
  // as everything else.
  it('returns 429 once the per-minute budget is exhausted', async () => {
    const app = testApp({ rateLimitPerMinute: 3 });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await request(app).post('/mcp').send(INITIALIZE);
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 3).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(3).every((s) => s === 429)).toBe(true);
  });
});
