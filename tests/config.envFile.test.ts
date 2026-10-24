import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveEnvFile, loadEnvFile } from '../src/config.js';

function tmpFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envfile-'));
  const file = path.join(dir, 'intervals.env');
  fs.writeFileSync(file, content);
  return file;
}

describe('resolveEnvFile', () => {
  it('relative --env-file resolves against cwd', () => {
    expect(resolveEnvFile(['--env-file', 'config/intervals.env'], {}, '/p')).toBe('/p/config/intervals.env');
  });
  it('flag beats INTERVALS_ENV_FILE', () => {
    expect(resolveEnvFile(['--env-file', '/a.env'], { INTERVALS_ENV_FILE: '/b.env' }, '/p')).toBe('/a.env');
  });
  it('INTERVALS_ENV_FILE is used without a flag', () => {
    expect(resolveEnvFile([], { INTERVALS_ENV_FILE: 'x.env' }, '/p')).toBe('/p/x.env');
  });
  it('no flag or env returns null', () => {
    expect(resolveEnvFile(['--stdio'], {}, '/p')).toBeNull();
  });
});

describe('loadEnvFile', () => {
  it('missing env file names resolved path', () => {
    const missing = path.join(os.tmpdir(), 'nope-does-not-exist.env');
    expect(() => loadEnvFile(missing, {})).toThrow(missing);
    expect(() => loadEnvFile(missing, {})).toThrow('Run setup again');
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
