import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASE_DIR, resolveEnvFile, resolveLogsPath, loadEnvFile, loadConfig } from '../src/config.js';

function tmpFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envfile-'));
  const file = path.join(dir, 'intervals.env');
  fs.writeFileSync(file, content);
  return file;
}

describe('resolveEnvFile', () => {
  it('relative --settings-file resolves against cwd', () => {
    expect(resolveEnvFile(['--settings-file', 'config/intervals.env'], {}, '/p')).toBe('/p/config/intervals.env');
  });
  it('flag beats INTERVALS_ENV_FILE', () => {
    expect(resolveEnvFile(['--settings-file', '/a.env'], { INTERVALS_ENV_FILE: '/b.env' }, '/p')).toBe('/a.env');
  });
  it('INTERVALS_ENV_FILE is used without a flag', () => {
    expect(resolveEnvFile([], { INTERVALS_ENV_FILE: 'x.env' }, '/p')).toBe('/p/x.env');
  });
  it('--env-file is not our flag (Node intercepts it)', () => {
    expect(resolveEnvFile(['--env-file', 'x'], {}, '/p')).toBeNull();
  });
  it('no flag or env returns null', () => {
    expect(resolveEnvFile(['--stdio'], {}, '/p')).toBeNull();
  });
  it('flag with no path gives a plain error', () => {
    expect(() => resolveEnvFile(['--stdio', '--settings-file'], {}, '/p')).toThrow(/needs the path/);
  });
  it('flag followed by another flag gives a plain error', () => {
    expect(() => resolveEnvFile(['--settings-file', '--stdio'], {}, '/p')).toThrow(/needs the path/);
  });
});

describe('loadEnvFile', () => {
  it('missing env file names resolved path', () => {
    const missing = path.join(os.tmpdir(), 'nope-does-not-exist.env');
    expect(() => loadEnvFile(missing, {})).toThrow(missing);
    expect(() => loadEnvFile(missing, {})).toThrow('Run setup again');
  });
  it('unreadable settings file gives a plain error naming the path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envdir-'));
    expect(() => loadEnvFile(dir, {})).toThrow(`Could not read your intervals.icu settings file at ${dir}`);
  });
  it('key is trimmed of whitespace and quotes', () => {
    const env: NodeJS.ProcessEnv = {};
    loadEnvFile(tmpFile('INTERVALS_API_KEY= "abc" \n'), env);
    expect(env.INTERVALS_API_KEY).toBe('abc');
  });
  it('empty key gives plain-language error', () => {
    const file = tmpFile('INTERVALS_API_KEY=  \n');
    expect(() => loadEnvFile(file, {})).toThrow(`Your intervals.icu API key is empty in ${file}`);
  });
});

describe('resolveLogsPath', () => {
  it('stdio writes no log file unless LOGS_PATH is set', () => {
    expect(resolveLogsPath({}, '/p', { stdio: true })).toBeNull();
    expect(resolveLogsPath({ LOGS_PATH: '' }, '/p', { stdio: true })).toBeNull();
  });
  it('an explicit LOGS_PATH is used in stdio mode, relative to cwd', () => {
    expect(resolveLogsPath({ LOGS_PATH: 'logs' }, '/p', { stdio: true })).toBe('/p/logs');
    expect(resolveLogsPath({ LOGS_PATH: '/var/log/x' }, '/p', { stdio: true })).toBe('/var/log/x');
  });
  it('HTTP mode defaults to logs/ in the package directory', () => {
    expect(resolveLogsPath({}, '/p', { stdio: false })).toBe(path.join(BASE_DIR, 'logs'));
  });
});

describe('INTERVALS_TIMEOUT_MS', () => {
  function configWithTimeout(value: string) {
    const saved = { key: process.env.INTERVALS_API_KEY, timeout: process.env.INTERVALS_TIMEOUT_MS };
    process.env.INTERVALS_API_KEY = 'test-key';
    process.env.INTERVALS_TIMEOUT_MS = value;
    try {
      return loadConfig();
    } finally {
      for (const [name, prev] of [['INTERVALS_API_KEY', saved.key], ['INTERVALS_TIMEOUT_MS', saved.timeout]] as const) {
        if (prev === undefined) delete process.env[name];
        else process.env[name] = prev;
      }
    }
  }
  it('accepts a positive value', () => {
    expect(configWithTimeout('2500').intervalsTimeoutMs).toBe(2500);
  });
  it('rejects 0 and negative values with a plain error', () => {
    expect(() => configWithTimeout('0')).toThrow(/must be more than 0/);
    expect(() => configWithTimeout('-5')).toThrow(/must be more than 0/);
  });
});
