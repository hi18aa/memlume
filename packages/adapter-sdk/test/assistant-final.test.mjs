import assert from 'node:assert/strict';
import test from 'node:test';

import { AdapterClient } from '../dist/index.js';

const envelope = {
  clientType: 'codex',
  installationId: 'desktop',
  profileId: 'default',
  sessionId: 'session-1',
  projectId: 'memlume',
  workspacePath: 'C:/work/memlume',
};

test('assistant final uses an internal runtime transport and never the capture outbox', async () => {
  const calls = [];
  const client = new AdapterClient({
    daemonUrl: 'http://127.0.0.1:3849',
    token: 'token',
    outboxDirectory: 'C:/unused',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ status: 'saved' }), { status: 201 });
    },
  });
  assert.equal(await client.recordAssistantFinal(envelope, { turnId: 'turn-1', finalAnswer: 'Use Vue.' }), 'saved');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith('/v1/runtime/final'), true);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { sessionId: 'session-1', turnId: 'turn-1', finalAnswer: 'Use Vue.' });
  assert.equal(calls[0].init.headers['x-memlume-runtime'], 'assistant-final');
  assert.equal(calls[0].init.headers['x-memlume-callback'], undefined);
});

test('assistant final rejects secrets locally', async () => {
  let calls = 0;
  const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token: 'token', fetch: async () => { calls += 1; return new Response('{}'); } });
  assert.equal(await client.recordAssistantFinal(envelope, { turnId: 'turn-secret', finalAnswer: 'api_key=secret' }), 'rejected');
  assert.equal(calls, 0);
});
