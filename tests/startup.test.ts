/**
 * Start-up must not wait on intervals.icu: the athlete-limits fetch runs after
 * the transport connects, so a slow or failing call can't block the handshake.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runStdio } from '../src/server.js';
import { DEFAULT_LIMITS } from '../src/workout/validate.js';
import type { IntervalsClient } from '../src/intervals/client.js';
import type { ToolContext } from '../src/tools/types.js';

function contextWith(getSportZoneSettings: () => Promise<unknown>): ToolContext {
  const client = { getSportZoneSettings } as unknown as IntervalsClient;
  return { client, limits: { ...DEFAULT_LIMITS } };
}

async function handshake(context: ToolContext) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([runStdio(context, serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

describe('start-up', () => {
  it('completes the MCP handshake while the athlete-limits fetch is still pending', async () => {
    const context = contextWith(() => new Promise(() => {}));
    const mcp = await handshake(context);
    const { tools } = await mcp.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(context.limits.ftp).toBe(DEFAULT_LIMITS.ftp);
    await mcp.close();
  });

  it('keeps serving when the athlete-limits fetch fails', async () => {
    const context = contextWith(async () => {
      throw new Error('network down');
    });
    const mcp = await handshake(context);
    await expect(mcp.listTools()).resolves.toBeDefined();
    await mcp.close();
  });

  it('applies the athlete FTP once the fetch lands', async () => {
    const context = contextWith(async () => ({ types: ['Ride'], ftp: 250 }));
    const mcp = await handshake(context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(context.limits.ftp).toBe(250);
    await mcp.close();
  });
});
