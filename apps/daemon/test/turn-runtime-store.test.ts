import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { TurnRuntimeStore } from '../src/turn-runtime-store.js';

describe('TurnRuntimeStore', () => {
  test('stores only bounded final text and expires it with an injectable clock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memlume-turn-runtime-'));
    let now = new Date('2026-07-16T00:00:00.000Z');
    const store = new TurnRuntimeStore({ rootDir: join(root, 'runtime', 'turns'), now: () => now });
    expect(await store.save({ installationId: 'codex', sessionId: 'session-1', turnId: 'turn-1', traceId: 'trace-1', finalAnswer: 'Use Vue.' })).toBe('saved');
    expect(await store.read({ installationId: 'codex', sessionId: 'session-1', turnId: 'turn-1' })).toMatchObject({ finalAnswer: 'Use Vue.', traceId: 'trace-1' });
    now = new Date('2026-07-17T00:00:01.000Z');
    expect(await store.read({ installationId: 'codex', sessionId: 'session-1', turnId: 'turn-1' })).toBeUndefined();
    expect(await readdir(join(root, 'runtime', 'turns'))).toHaveLength(0);
  });

  test('rejects secrets and oversize responses before persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memlume-turn-runtime-'));
    const store = new TurnRuntimeStore({ rootDir: root, maxBytes: 8 });
    expect(await store.save({ installationId: 'codex', sessionId: 's', turnId: 'secret', finalAnswer: 'api_key=super-secret-value' })).toBe('rejected');
    expect(await store.save({ installationId: 'codex', sessionId: 's', turnId: 'large', finalAnswer: '123456789' })).toBe('rejected');
    await expect(readFile(join(root, 'anything.json'))).rejects.toThrow();
  });

  test('clears only after durable or queued capture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memlume-turn-runtime-'));
    const store = new TurnRuntimeStore({ rootDir: root });
    const key = { installationId: 'codex', sessionId: 's', turnId: 't' };
    await store.save({ ...key, finalAnswer: 'Remember this.' });
    expect(await store.clearAfterCapture(key, 'failed')).toBe(false);
    expect(await store.read(key)).toBeDefined();
    expect(await store.clearAfterCapture(key, 'queued')).toBe(true);
    expect(await store.read(key)).toBeUndefined();
  });
});
