import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SHEBANG = '#!/usr/bin/env node';
const root = resolve(__dirname, '..');

function firstLine(path: string): string {
  return readFileSync(path, 'utf8').split(/\r?\n/, 1)[0];
}

describe('bin entry point', () => {
  it('src/server.ts starts with a node shebang so npx can execute the bin', () => {
    expect(firstLine(resolve(root, 'src/server.ts'))).toBe(SHEBANG);
  });

  it('dist/server.js (when built) keeps the shebang on line 1', () => {
    const dist = resolve(root, 'dist/server.js');
    if (!existsSync(dist)) return;
    expect(firstLine(dist)).toBe(SHEBANG);
  });

  it('package.json bin points at dist/server.js', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(pkg.bin['intervals-training-bridge']).toBe('./dist/server.js');
  });
});

describe('server version', () => {
  it('SERVER_INFO.version matches package.json', async () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const { SERVER_INFO } = await import('../src/server.js');
    expect(SERVER_INFO.version).toBe(pkg.version);
  });
});
