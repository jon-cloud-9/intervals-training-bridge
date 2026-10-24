/**
 * Configuration and secrets.
 *
 * dotenv loads a
 * `.env` from the repo root, values are exported as module-level typed constants,
 * and anything required is resolved through `requireEnv()` so a missing variable
 * fails loudly at startup rather than as a confusing `undefined` deep in a request.
 *
 * Importing this module has side effects (it reads `.env` and may throw). Only the
 * server entry point should import it — application modules take their config as
 * arguments so they stay testable without a populated environment.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

/** Project root = intervals-training-bridge/ (two levels up from dist/config.js). */
export const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: path.join(BASE_DIR, '.env'), quiet: true });

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Required environment variable '${key}' is not set`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  const value = process.env[key];
  return value && value.length > 0 ? value : fallback;
}

function resolvePath(key: string, fallback: string): string {
  const raw = optionalEnv(key, fallback);
  return path.isAbsolute(raw) ? raw : path.join(BASE_DIR, raw);
}

function numberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable '${key}' must be a number, got '${raw}'`);
  }
  return parsed;
}

export interface Config {
  readonly intervalsApiKey: string;
  readonly intervalsAthleteId: string;
  readonly intervalsBaseUrl: string;
  readonly httpPort: number;
  readonly httpHost: string;
  readonly mcpAuthToken: string;
  readonly allowUnauthenticated: boolean;
  readonly rateLimitPerMinute: number;
  readonly logLevel: string;
  readonly logsPath: string;
  readonly timezone: string;
}

/**
 * Read configuration from the environment.
 *
 * Deliberately a function rather than top-level constants: the write tools are
 * exercised in dryRun during development without credentials present, and a
 * module-level throw would make the whole server unimportable in that state.
 */
export function loadConfig(): Config {
  return {
    // ── intervals.icu ────────────────────────────────────────────────────────
    intervalsApiKey: requireEnv('INTERVALS_API_KEY'),
    intervalsAthleteId: optionalEnv('INTERVALS_ATHLETE_ID', '0'),
    intervalsBaseUrl: optionalEnv('INTERVALS_BASE_URL', 'https://intervals.icu/api/v1'),

    // ── HTTP transport (Claude custom connector) ─────────────────────
    httpPort: numberEnv('PORT', 8787),
    httpHost: optionalEnv('HOST', '0.0.0.0'),

    // ── Public endpoint auth ─────────────────────────────────────────────────
    // Required in HTTP mode. Left optional here so stdio mode and tests can
    // load config without one; server.ts fails closed before it listens.
    mcpAuthToken: optionalEnv('MCP_AUTH_TOKEN', ''),
    allowUnauthenticated: optionalEnv('ALLOW_UNAUTHENTICATED', '') === 'true',
    rateLimitPerMinute: numberEnv('RATE_LIMIT_PER_MINUTE', 120),

    // ── Logging ──────────────────────────────────────────────────────────────
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
    logsPath: resolvePath('LOGS_PATH', './logs'),

    // ── Misc ─────────────────────────────────────────────────────────────────
    timezone: optionalEnv('TIMEZONE', 'Europe/London'),
  };
}
