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
import fs from 'node:fs';
import dotenv from 'dotenv';

/** Project root = intervals-training-bridge/ (two levels up from dist/config.js). */
export const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Not named `--env-file`: Node intercepts that flag itself.
 * Pick the env file: `--settings-file <path>` beats `INTERVALS_ENV_FILE`; relative
 * paths resolve against `cwd`. Returns null to fall back to the package `.env`.
 */
export function resolveEnvFile(argv: string[], env: NodeJS.ProcessEnv, cwd: string): string | null {
  const i = argv.indexOf('--settings-file');
  const raw = i >= 0 && argv[i + 1] ? argv[i + 1] : env.INTERVALS_ENV_FILE;
  return raw ? path.resolve(cwd, raw) : null;
}

/** Strip whitespace, then surrounding quotes, then whitespace again. */
function cleanValue(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/s, '$2').trim();
}

/**
 * Load an explicit env file into `target` (default `process.env`). Throws
 * plain-language errors for a missing file or an empty API key.
 */
export function loadEnvFile(file: string, target: NodeJS.ProcessEnv = process.env): void {
  if (!fs.existsSync(file)) {
    throw new Error(`Could not find your intervals.icu settings file at ${file}. Run setup again.`);
  }
  const parsed = dotenv.parse(fs.readFileSync(file));
  for (const [key, raw] of Object.entries(parsed)) {
    const value = cleanValue(raw);
    if (key === 'INTERVALS_API_KEY' && value === '') {
      throw new Error(`Your intervals.icu API key is empty in ${file}`);
    }
    if (target[key] === undefined) target[key] = value;
  }
  if (!target.INTERVALS_API_KEY) {
    throw new Error(`Your intervals.icu API key is empty in ${file}`);
  }
}

// Default behaviour for existing callers: package-root .env. An explicit
// env file is loaded by the server entry point so errors can be reported cleanly.
if (resolveEnvFile(process.argv.slice(2), process.env, process.cwd()) === null) {
  dotenv.config({ path: path.join(BASE_DIR, '.env'), quiet: true });
}

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

/**
 * Where to write `bridge.log`, or null for stderr only.
 *
 * An explicit `LOGS_PATH` always wins, resolved against `cwd` when relative.
 * Without one, stdio mode writes no file: under npx the package directory is
 * the npm cache, which is no place for logs, and Claude Code already captures
 * stderr. HTTP mode is a long-running server started from a checkout, so it
 * keeps `logs/` in the package directory.
 */
export function resolveLogsPath(
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: { stdio: boolean },
): string | null {
  const raw = env.LOGS_PATH;
  if (raw && raw.length > 0) return path.resolve(cwd, raw);
  return options.stdio ? null : path.join(BASE_DIR, 'logs');
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

/** An IANA time zone from the environment, or the machine's own zone. */
function timeZoneEnv(key: string): string {
  const raw = process.env[key];
  if (!raw) return Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: raw });
  } catch {
    throw new Error(
      `${key} '${raw}' is not a time zone name. Use one like Europe/London or ` +
        'America/New_York, or leave it blank to use this computer\'s time zone.',
    );
  }
  return raw;
}

export interface Config {
  readonly intervalsApiKey: string;
  readonly intervalsAthleteId: string;
  readonly intervalsBaseUrl: string;
  readonly intervalsTimeoutMs: number;
  readonly httpPort: number;
  readonly httpHost: string;
  readonly mcpAuthToken: string;
  readonly allowUnauthenticated: boolean;
  readonly rateLimitPerMinute: number;
  readonly logLevel: string;
  /** null = stderr only, no log file. */
  readonly logsPath: string | null;
  readonly timezone: string;
}

/**
 * Read configuration from the environment.
 *
 * Deliberately a function rather than top-level constants: the write tools are
 * exercised in dryRun during development without credentials present, and a
 * module-level throw would make the whole server unimportable in that state.
 */
export function loadConfig(options: { stdio?: boolean } = {}): Config {
  return {
    // ── intervals.icu ────────────────────────────────────────────────────────
    intervalsApiKey: requireEnv('INTERVALS_API_KEY'),
    intervalsAthleteId: optionalEnv('INTERVALS_ATHLETE_ID', '0'),
    intervalsBaseUrl: optionalEnv('INTERVALS_BASE_URL', 'https://intervals.icu/api/v1'),
    intervalsTimeoutMs: numberEnv('INTERVALS_TIMEOUT_MS', 10_000),

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
    logsPath: resolveLogsPath(process.env, process.cwd(), { stdio: options.stdio ?? false }),

    // ── Misc ─────────────────────────────────────────────────────────────────
    timezone: timeZoneEnv('TIMEZONE'),
  };
}
