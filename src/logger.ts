/**
 * Logging.
 *
 * Each module takes a named logger via
 * `getLogger(__name__)`, and the entry point configures handlers exactly once.
 *
 * This server writes to an external calendar that syncs to a physical watch, so
 * every push/update/delete is logged with its resolved payload — including dry
 * runs, so the record shows what was attempted as well as what landed.
 *
 * Output goes to stderr, never stdout: under the stdio transport, stdout carries
 * the JSON-RPC stream and any stray write corrupts the protocol.
 */
import fs from 'node:fs';
import path from 'node:path';

export const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type Level = (typeof LEVELS)[number];

interface LoggerConfig {
  level: Level;
  logsPath: string | null;
}

const config: LoggerConfig = { level: 'info', logsPath: null };
let fileStream: fs.WriteStream | null = null;

function isLevel(value: string): value is Level {
  return (LEVELS as readonly string[]).includes(value);
}

/** Configure logging once, from the entry point. */
export function initLogging(options: { level?: string; logsPath?: string }): void {
  if (options.level && isLevel(options.level)) {
    config.level = options.level;
  }
  if (options.logsPath) {
    fs.mkdirSync(options.logsPath, { recursive: true });
    config.logsPath = options.logsPath;
    fileStream = fs.createWriteStream(path.join(options.logsPath, 'bridge.log'), {
      flags: 'a',
    });
  }
}

function enabled(level: Level): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(config.level);
}

function emit(name: string, level: Level, message: string, context?: unknown): void {
  if (!enabled(level)) return;

  const timestamp = new Date().toISOString();
  const suffix = context === undefined ? '' : ` ${safeStringify(context)}`;
  const line = `${timestamp} ${level.toUpperCase().padEnd(5)} ${name}: ${message}${suffix}`;

  process.stderr.write(`${line}\n`);
  fileStream?.write(`${line}\n`);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface Logger {
  debug(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

export function getLogger(name: string): Logger {
  return {
    debug: (message, context) => emit(name, 'debug', message, context),
    info: (message, context) => emit(name, 'info', message, context),
    warn: (message, context) => emit(name, 'warn', message, context),
    error: (message, context) => emit(name, 'error', message, context),
  };
}
