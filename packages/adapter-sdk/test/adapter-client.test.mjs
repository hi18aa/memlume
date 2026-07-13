import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { AdapterClient } from '../dist/index.js';

const directories = [];
const token = 'adapter-token-that-must-not-be-persisted';
const brainId = '00000000-0000-7000-8000-000000000002';
const envelope = {
  clientType: 'codex',
  installationId: 'desktop',
  profileId: 'default',
  sessionId: 'session-1',
  projectId: 'memlume',
  workspacePath: 'C:/work/memlume',
};
const beforeTask = {
  intent: 'implement_feature',
  scope: { level: 'project', projectId: 'memlume' },
  task: 'Add the adapter SDK.',
  contextBudget: 500,
};

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop(), { force: true, recursive: true });
  }
  delete process.env.MEMLUME_TOKEN;
});

function temporaryOutboxDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-adapter-sdk-'));
  directories.push(directory);
  return directory;
}

function temporaryOutbox() {
  return join(temporaryOutboxDirectory(), 'outbox.jsonl');
}

function defaultOutbox(value, outboxDirectory) {
  const identity = JSON.stringify([value.clientType, value.installationId, value.profileId]);
  return join(outboxDirectory, 'outbox', `${createHash('sha256').update(identity).digest('hex')}.jsonl`);
}

function context() {
  return {
    traceId: '00000000-0000-7000-8000-000000000001',
    intent: beforeTask.intent,
    scope: beforeTask.scope,
    directives: [],
    procedures: [],
    preferences: [],
    knowledge: [],
    decisions: [],
    explanation: {
      sourceMemoryIds: [],
      exclusions: [],
      budget: { limitUnits: beforeTask.contextBudget, usedUnits: 0, included: [], omitted: [], truncated: false },
    },
  };
}

function savedEvent(id) {
  return { event: { id, brainId } };
}

function fakeFetch(...responses) {
  const calls = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      const next = responses.shift();
      if (next instanceof Error) {
        throw next;
      }
      if (next instanceof Response) {
        return next;
      }
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
    },
  };
}

function deferred() {
  let resolve;
  return { promise: new Promise((done) => { resolve = done; }), resolve };
}

describe('AdapterClient', () => {
  test('uses the environment token and maps all callbacks to authenticated daemon requests', async () => {
    process.env.MEMLUME_TOKEN = token;
    const fake = fakeFetch(
      { status: 200, body: { context: context() } },
      { status: 201, body: savedEvent('event-user') },
      { status: 201, body: savedEvent('event-task') },
    );
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', fetch: fake.fetch });

    assert.deepEqual(await client.beforeTask(beforeTask), context());
    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.' }), { status: 'saved' });
    assert.deepEqual(await client.afterTask(envelope, { messageId: 'message-2', content: 'Implemented SDK.' }), { status: 'saved' });
    assert.deepEqual(await client.onSessionEnd(), []);

    assert.equal(fake.calls.length, 3);
    assert.equal(fake.calls.every(({ init }) => init.headers.authorization === `Bearer ${token}`), true);
    assert.equal(fake.calls[0].url.endsWith('/v1/context/resolve'), true);
    assert.equal(fake.calls[1].url.endsWith('/v1/events'), true);
    assert.equal(fake.calls[2].url.endsWith('/v1/events'), true);
    assert.deepEqual(JSON.parse(fake.calls[1].init.body), {
      rawContent: 'Remember Vue.',
      eventType: 'user_message',
      source: {
        type: 'codex',
        agent: 'codex',
        conversationId: 'session-1',
        messageId: 'message-1',
        reference: JSON.stringify(['codex', 'desktop', 'default', 'session-1', 'message-1']),
      },
      structuredData: { envelope },
    });
    assert.equal(JSON.parse(fake.calls[2].init.body).eventType, 'task_completed');
  });

  test('fails open with one warning when context cannot be read', async () => {
    const warnings = [];
    const fake = fakeFetch(new Error('offline'), new Error('offline'));
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, fetch: fake.fetch, warn: (message) => warnings.push(message) });

    const first = await client.beforeTask(beforeTask);
    const second = await client.beforeTask(beforeTask);

    assert.deepEqual({ ...first, traceId: context().traceId }, context());
    assert.deepEqual({ ...second, traceId: context().traceId }, context());
    assert.deepEqual(warnings, ['Memlume context unavailable; continuing without shared context.']);
    assert.equal(warnings.join(' ').includes(token), false);
  });

  test('uses a stable unique source reference so only retries share an event identity', async () => {
    const references = new Set();
    const fake = {
      fetch: async (_input, init) => {
        references.add(JSON.parse(init.body).source.reference);
        return new Response(JSON.stringify(savedEvent(`event-${references.size}`)), { status: 201 });
      },
    };
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, fetch: fake.fetch });

    await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Same content.' });
    await client.onUserMessage(envelope, { messageId: 'message-2', content: 'Same content.' });
    await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Same content.' });

    assert.deepEqual([...references], [
      JSON.stringify(['codex', 'desktop', 'default', 'session-1', 'message-1']),
      JSON.stringify(['codex', 'desktop', 'default', 'session-1', 'message-2']),
    ]);
    assert.equal(JSON.stringify([...references]).includes(token), false);
  });

  test('queues a write when a successful event response is not valid JSON with a UUIDv7 brain ID', async () => {
    const outboxPath = temporaryOutbox();
    const malformed = new Response('not json', { status: 201, headers: { 'content-type': 'application/json' } });
    const missingBody = new Response(null, { status: 204 });
    const invalidBrain = new Response(JSON.stringify({ event: { id: 'event-user', brainId: 'not-a-uuid' } }), { status: 201 });

    for (const [index, response] of [malformed, missingBody, invalidBrain].entries()) {
      const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: fakeFetch(response).fetch });
      assert.deepEqual(await client.onUserMessage(envelope, { messageId: `invalid-${index}`, content: 'Only confirmed events are saved.' }), { status: 'queued' });
    }

    assert.equal(readFileSync(outboxPath, 'utf8').trim().split('\n').length, 3);
  });

  test('queues a 503 in a persistent stable-identity default outbox when no path is specified', async () => {
    const defaultToken = 'default-outbox-token-that-must-not-be-persisted';
    const outboxDirectory = temporaryOutboxDirectory();
    const outboxPath = defaultOutbox(envelope, outboxDirectory);
    const failing = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token: defaultToken, outboxDirectory, fetch: failing.fetch });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.' }), { status: 'queued' });
    const stored = readFileSync(outboxPath, 'utf8');
    assert.equal(stored.includes(defaultToken), false);
    assert.equal(outboxPath.includes(defaultToken), false);
  });

  test('retains same message IDs from different sessions as separate queued events', async () => {
    const outboxPath = temporaryOutbox();
    const failing = fakeFetch(
      { status: 503, body: { error: 'unavailable' } },
      { status: 503, body: { error: 'unavailable' } },
    );
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: failing.fetch });
    const nextSession = { ...envelope, sessionId: 'session-2' };

    await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.' });
    await client.onUserMessage(nextSession, { messageId: 'message-1', content: 'Remember Vue.' });

    const pending = readFileSync(outboxPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(pending.length, 2);
    assert.deepEqual(pending.map((entry) => entry.request.source.reference), [
      JSON.stringify(['codex', 'desktop', 'default', 'session-1', 'message-1']),
      JSON.stringify(['codex', 'desktop', 'default', 'session-2', 'message-1']),
    ]);
  });

  test('uses the same stable outbox after token rotation and flushes existing entries', async () => {
    const oldToken = 'old-token-that-must-not-be-persisted';
    const newToken = 'new-token-that-must-not-be-persisted';
    const outboxDirectory = temporaryOutboxDirectory();
    const outboxPath = defaultOutbox(envelope, outboxDirectory);
    const unavailable = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const oldClient = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token: oldToken, outboxDirectory, fetch: unavailable.fetch });

    assert.deepEqual(await oldClient.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.' }), { status: 'queued' });

    const recovered = fakeFetch(
      { status: 200, body: { context: context() } },
      { status: 201, body: savedEvent('event-user') },
    );
    const newClient = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token: newToken, outboxDirectory, fetch: recovered.fetch });
    await newClient.beforeTask({ ...beforeTask, envelope });

    assert.deepEqual(await newClient.onSessionEnd(), [{ status: 'saved' }]);
    assert.equal(readFileSync(outboxPath, 'utf8'), '');
    assert.equal(outboxPath.includes(oldToken) || outboxPath.includes(newToken), false);
    assert.equal(recovered.calls[1].init.headers.authorization, `Bearer ${newToken}`);
  });

  test('does not flush a default outbox before an envelope establishes its identity', async () => {
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, fetch: fakeFetch().fetch });

    assert.deepEqual(await client.onSessionEnd(), []);
  });

  test('deduplicates temporary write failures in a token-free JSONL outbox and flushes them later', async () => {
    const outboxPath = temporaryOutbox();
    const failing = fakeFetch({ status: 503, body: { error: 'unavailable' } }, { status: 503, body: { error: 'unavailable' } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: failing.fetch });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.' }), { status: 'queued' });
    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.' }), { status: 'queued' });
    const lines = readFileSync(outboxPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(readFileSync(outboxPath, 'utf8').includes(token), false);

    const recovering = fakeFetch({ status: 201, body: savedEvent('event-user') });
    const retryingClient = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: recovering.fetch });
    assert.deepEqual(await retryingClient.onSessionEnd(), [{ status: 'saved' }]);
    assert.equal(readFileSync(outboxPath, 'utf8'), '');
  });

  test('fails open and preserves the JSONL when a flush cannot rewrite the outbox', async () => {
    const outboxPath = temporaryOutbox();
    const unavailable = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const seedClient = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: unavailable.fetch });
    await seedClient.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.' });
    const original = readFileSync(outboxPath, 'utf8');
    mkdirSync(`${outboxPath}.${process.pid}.tmp`, { recursive: true });

    const warnings = [];
    const accepting = fakeFetch({ status: 201, body: savedEvent('event-user') });
    const client = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: accepting.fetch,
      warn: (message) => warnings.push(message),
    });

    assert.deepEqual(await client.onSessionEnd(), [{ status: 'saved' }]);
    assert.deepEqual(warnings, ['Memlume outbox update unavailable; queued events will retry later.']);
    assert.equal(warnings.join(' ').includes(token), false);
    assert.equal(readFileSync(outboxPath, 'utf8'), original);
  });

  test('rejects and warns when a queued event cannot be persisted', async () => {
    const outboxDirectory = temporaryOutboxDirectory();
    const blockedDirectory = join(outboxDirectory, 'blocked');
    writeFileSync(blockedDirectory, 'not a directory', 'utf8');
    const outboxPath = join(blockedDirectory, 'outbox.jsonl');
    const warnings = [];
    const unavailable = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const client = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: unavailable.fetch,
      warn: (message) => warnings.push(message),
    });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.' }), { status: 'rejected' });
    assert.deepEqual(warnings, ['Memlume outbox unavailable; event was not persisted.']);
    assert.equal(warnings.join(' ').includes(token), false);
  });

  test('rejects authentication failures instead of retaining them for retry or exposing the token', async () => {
    const outboxPath = temporaryOutbox();
    const queued = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: queued.fetch });
    await client.afterTask(envelope, { messageId: 'message-2', content: 'Implemented SDK.' });

    const rejected = fakeFetch({ status: 401, body: { error: 'unauthorized' } });
    const retryingClient = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: rejected.fetch });
    const result = await retryingClient.onSessionEnd();
    assert.deepEqual(result, [{ status: 'rejected' }]);
    assert.equal(readFileSync(outboxPath, 'utf8'), '');
    assert.equal(JSON.stringify(result).includes(token), false);
  });

  test('removes queued entries rejected with 400 or 403', async () => {
    const outboxPath = temporaryOutbox();
    const queued = fakeFetch(
      { status: 503, body: { error: 'unavailable' } },
      { status: 503, body: { error: 'unavailable' } },
    );
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: queued.fetch });
    await client.onUserMessage(envelope, { messageId: 'message-1', content: 'First.' });
    await client.onUserMessage(envelope, { messageId: 'message-2', content: 'Second.' });

    const rejecting = fakeFetch(
      { status: 400, body: { error: 'invalid_request' } },
      { status: 403, body: { error: 'forbidden' } },
    );
    const flushingClient = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: rejecting.fetch });
    assert.deepEqual(await flushingClient.onSessionEnd(), [{ status: 'rejected' }, { status: 'rejected' }]);
    assert.equal(readFileSync(outboxPath, 'utf8'), '');
  });

  test('serializes an in-flight flush with a queued write from the same client', async () => {
    const outboxPath = temporaryOutbox();
    const seeding = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const seedClient = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: seeding.fetch });
    await seedClient.onUserMessage(envelope, { messageId: 'message-old', content: 'Old pending event.' });

    const oldRequestStarted = deferred();
    const releaseOldRequest = deferred();
    const racing = {
      fetch: async (_input, init) => {
        const messageId = JSON.parse(init.body).source.messageId;
        if (messageId === 'message-old') {
          oldRequestStarted.resolve();
          await releaseOldRequest.promise;
          return new Response(JSON.stringify(savedEvent('event-old')), { status: 201 });
        }
        return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
      },
    };
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: racing.fetch });

    const ending = client.onSessionEnd();
    await oldRequestStarted.promise;
    const writing = client.onUserMessage(envelope, { messageId: 'message-new', content: 'New pending event.' });
    releaseOldRequest.resolve();
    assert.deepEqual(await ending, [{ status: 'saved' }]);
    assert.deepEqual(await writing, { status: 'queued' });

    const pending = readFileSync(outboxPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(pending.map((entry) => entry.messageId), ['message-new']);
  });
});
