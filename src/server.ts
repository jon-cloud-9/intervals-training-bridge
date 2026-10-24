/**
 * MCP server entry point.
 *
 * Two transports:
 *
 * - **Streamable HTTP** (default) — what a Claude custom connector needs.
 *   A stdio server cannot be a Project connector; the connector talks HTTP.
 * - **stdio** (`--stdio`) — for driving the server from a local Claude Code
 *   session while testing in dryRun.
 *
 * HTTP runs stateless: a fresh server and transport per request. There is no
 * cross-request state to keep, and it avoids leaking sessions if the connector
 * reconnects.
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, type Config } from './config.js';
import { getLogger, initLogging } from './logger.js';
import { IntervalsClient } from './intervals/client.js';
import { createAuthMiddleware } from './http/auth.js';
import { registerTools } from './tools/index.js';
import { DEFAULT_LIMITS, type ValidationLimits } from './workout/validate.js';
import type { ToolContext } from './tools/types.js';

const log = getLogger('server');

const SERVER_INFO = {
  name: 'intervals-training-bridge',
  version: '0.1.0',
} as const;

const INSTRUCTIONS =
  'Bridges a training plan to intervals.icu, which can sync to Garmin Connect and a Garmin ' +
  'watch. This server is mechanical: it holds no training logic and makes no coaching ' +
  'decisions. Call get_training_context before drafting or adjusting a week. The write ' +
  'tools default to dryRun; only pass dryRun: false after the user has explicitly ' +
  'approved writing to their real calendar.';

/** Shortest token we accept. 32 hex chars is 128 bits of entropy. */
const MIN_TOKEN_LENGTH = 32;

/**
 * Refuse to serve HTTP without a credential.
 *
 * Fails closed on purpose: starting unauthenticated would leave the write tools
 * open to anyone who finds the URL, which is far worse than the process not
 * booting. `ALLOW_UNAUTHENTICATED=true` is the deliberate, explicit escape
 * hatch for binding to localhost during development.
 */
export function assertHttpAuthConfigured(config: Config): void {
  if (config.allowUnauthenticated) {
    log.warn(
      'starting with authentication DISABLED (ALLOW_UNAUTHENTICATED=true) — ' +
        'never expose this to the public internet',
    );
    return;
  }
  if (!config.mcpAuthToken) {
    throw new Error(
      'MCP_AUTH_TOKEN is not set. HTTP mode exposes the write tools, so a token ' +
        'is required. Generate one with: openssl rand -hex 32 — or set ' +
        'ALLOW_UNAUTHENTICATED=true if binding to localhost only.',
    );
  }
  if (config.mcpAuthToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `MCP_AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters. ` +
        'Generate one with: openssl rand -hex 32',
    );
  }
}

/** Build a configured MCP server. Exported so tests can drive it in-process. */
export function buildServer(context: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  registerTools(server, context);
  return server;
}

function buildContext(config: Config): ToolContext {
  const client = new IntervalsClient({
    apiKey: config.intervalsApiKey,
    athleteId: config.intervalsAthleteId,
    baseUrl: config.intervalsBaseUrl,
  });
  return { client, limits: DEFAULT_LIMITS satisfies ValidationLimits };
}

/**
 * Fetch the athlete's FTP so absolute watt targets are bounded against their
 * actual fitness rather than a generic range. Read from the Ride sport group
 * specifically — FTP is commonly unset on the Run group even when configured
 * for cycling. Non-fatal, and silent when FTP simply isn't configured: a
 * failure or an absent value both just leave the wider default bounds in
 * place, which is the expected steady state for pace-only accounts.
 */
async function withAthleteLimits(context: ToolContext): Promise<ToolContext> {
  try {
    const bikeSettings = await context.client.getSportZoneSettings('bike');
    if (bikeSettings?.ftp) {
      log.info('bounding power validation against athlete FTP', { ftp: bikeSettings.ftp });
      return { ...context, limits: { ...context.limits, ftp: bikeSettings.ftp } };
    }
    log.info('no FTP configured for this account; using default power validation bounds');
  } catch (error) {
    log.warn('could not fetch athlete zones; using default validation bounds', {
      message: String(error),
    });
  }
  return context;
}

async function runStdio(context: ToolContext): Promise<void> {
  const server = buildServer(context);
  await server.connect(new StdioServerTransport());
  log.info('listening on stdio');
}

/**
 * Build the Express app.
 *
 * Separated from listening so tests can drive the real middleware stack via
 * supertest without binding a port — the ordering of rate limiting and auth is
 * the part most worth testing, and it only exists here.
 */
export function buildHttpApp(config: Config, context: ToolContext): express.Express {
  const allowedHosts = (process.env.ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);

  const app = createMcpExpressApp({
    host: config.httpHost,
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
  });
  app.use(express.json({ limit: '1mb' }));

  // Open on purpose: uptime checks should not need the secret, and this
  // discloses only the name and version.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: SERVER_INFO.name, version: SERVER_INFO.version });
  });

  // Rate limit BEFORE auth, so brute-forcing the token is throttled by the same
  // budget as legitimate traffic rather than being effectively unlimited.
  app.use(
    '/mcp',
    rateLimit({
      windowMs: 60_000,
      limit: config.rateLimitPerMinute,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        jsonrpc: '2.0',
        error: { code: -32002, message: 'Too many requests' },
        id: null,
      },
    }),
  );

  if (!config.allowUnauthenticated) {
    app.use('/mcp', createAuthMiddleware(config.mcpAuthToken));
  }

  // Stateless: a new server and transport per request, torn down when it closes.
  app.post('/mcp', async (req, res) => {
    const requestId = randomUUID();
    const server = buildServer(context);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log.error('request failed', { requestId, message: String(error) });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // Stateless mode has no stream to resume and no session to delete.
  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this server is stateless' },
      id: null,
    });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return app;
}

async function runHttp(config: Config, context: ToolContext): Promise<void> {
  assertHttpAuthConfigured(config);
  const app = buildHttpApp(config, context);

  await new Promise<void>((resolve) => {
    app.listen(config.httpPort, config.httpHost, () => {
      log.info('listening on http', {
        host: config.httpHost,
        port: config.httpPort,
        endpoint: '/mcp',
        authenticated: !config.allowUnauthenticated,
        rateLimitPerMinute: config.rateLimitPerMinute,
      });
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  initLogging({ level: config.logLevel, logsPath: config.logsPath });

  const useStdio = process.argv.includes('--stdio');
  const context = await withAthleteLimits(buildContext(config));

  if (useStdio) {
    await runStdio(context);
  } else {
    await runHttp(config, context);
  }
}

// Only run when executed directly, so importing this module in tests is safe.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((error: unknown) => {
    log.error('fatal', { message: String(error) });
    process.exitCode = 1;
  });
}
