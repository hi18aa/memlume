import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CaptureOutbox } from '../dist/index.js';

async function outbox() {
  const directory = await mkdtemp(join(tmpdir(), 'memlume-outbox-'));
  return new CaptureOutbox({ path: join(directory, 'capture.jsonl'), maxEntries: 2, now: () => '2026-07-16T00:00:00.000Z' });
}

test('deduplicates identity, preserves old entries at capacity, and rejects secrets', async () => {
  const queue = await outbox();
  assert.equal(await queue.enqueue({ identity: 'a', payload: { text: 'Vue' } }), 'queued');
  assert.equal(await queue.enqueue({ identity: 'a', payload: { text: 'Vue' } }), 'deduplicated');
  assert.equal(await queue.enqueue({ identity: 'a', payload: { text: 'other' } }), 'failed');
  assert.equal(await queue.enqueue({ identity: 'b', payload: { text: 'pnpm' } }), 'queued');
  assert.equal(await queue.enqueue({ identity: 'c', payload: { text: 'overflow' } }), 'failed');
  assert.equal(await queue.enqueue({ identity: 'secret', payload: { password: 'do-not-store' } }), 'rejected');
  assert.equal((await queue.list()).length, 2);
});

test('tolerates partial last lines and atomically removes delivered entries', async () => {
  const queue = await outbox();
  await queue.enqueue({ identity: 'a', payload: { text: 'Vue' } });
  const entries = await queue.list();
  assert.equal(entries[0].state, 'pending');
  assert.equal(await queue.remove('a'), true);
  assert.deepEqual(await queue.list(), []);
});

test('flushes bounded batches and retains retry/discards with reasons', async () => {
  const queue = await outbox();
  await queue.enqueue({ identity: 'done', payload: { text: 'Vue' } });
  await queue.enqueue({ identity: 'retry', payload: { text: 'pnpm' } });
  const results = await queue.flush(async (payload) => payload.text === 'Vue' ? 'completed' : 'retry', { maxEntries: 2 });
  assert.deepEqual(results.map(({ result }) => result), ['completed', 'retry']);
  assert.equal((await queue.list()).find((entry) => entry.identity === 'retry').state, 'retry');
});
