import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function savedCapture(status = 'active') {
  return {
    capture: {
      memoryId: status === 'active' || status === 'candidate' ? '00000000-0000-7000-8000-000000000003' : null,
      status,
      brain: brainId,
      scope: { level: 'project', projectId: 'memlume' },
      requiresConfirmation: false,
      source: { eventId: '00000000-0000-7000-8000-000000000004' },
    },
  };
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
  test('reports rejected and ignored capture outcomes without claiming a saved memory', async () => {
    const fake = fakeFetch(
      { status: 200, body: savedCapture('rejected') },
      { status: 200, body: savedCapture('ignore') },
    );
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxDirectory: temporaryOutboxDirectory(), fetch: fake.fetch });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'rejected-memory', content: 'Remember rejected.' }), { status: 'rejected' });
    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'ignored-memory', content: 'Remember ignored.' }), { status: 'ignored', memoryStatus: 'ignore' });
  });

  test('captures a user message through the governed memory endpoint and reports the memory outcome', async () => {
    const fake = fakeFetch({
      status: 201,
      body: savedCapture(),
    });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxDirectory: temporaryOutboxDirectory(), fetch: fake.fetch });

    assert.deepEqual(
      await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember this project uses pnpm.' }),
      { status: 'saved', memoryStatus: 'active' },
    );
    assert.equal(fake.calls[0].url.endsWith('/v1/memories/capture'), true);
    assert.deepEqual(JSON.parse(fake.calls[0].init.body).scope, { level: 'project', projectId: 'memlume' });
  });

  test('reports local pending, retry, and discarded outbox counts without claiming saved memory', async () => {
    const outboxPath = temporaryOutbox();
    const client = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: fakeFetch({ status: 503, body: { error: 'unavailable' } }).fetch,
    });

    await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.' });
    assert.deepEqual(await client.outboxStatus(), { state: 'pending', pending: 1, retry: 0, discarded: 0 });

    const retrying = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: fakeFetch({ status: 503, body: { error: 'unavailable' } }).fetch,
    });
    await retrying.onSessionEnd();
    assert.deepEqual(await retrying.outboxStatus(), { state: 'pending', pending: 1, retry: 1, discarded: 0 });

    const rejecting = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: fakeFetch({ status: 403, body: { error: 'forbidden' } }).fetch,
    });
    await rejecting.onSessionEnd();
    assert.deepEqual(await rejecting.outboxStatus(), { state: 'discarded', pending: 0, retry: 0, discarded: 1 });
    assert.equal(readFileSync(outboxPath, 'utf8').includes(token), false);
  });

  test('waits for an in-flight write before reporting outbox status', async () => {
    const outboxPath = temporaryOutbox();
    const started = deferred();
    const release = deferred();
    const client = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: async () => {
        started.resolve();
        await release.promise;
        return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
      },
    });

    const writing = client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.' });
    await started.promise;
    const status = client.outboxStatus();
    release.resolve();

    await writing;
    assert.deepEqual(await status, { state: 'pending', pending: 1, retry: 0, discarded: 0 });
  });

  test('uses the environment token and maps all callbacks to authenticated daemon requests', async () => {
    process.env.MEMLUME_TOKEN = token;
    const fake = fakeFetch(
      { status: 200, body: { context: context() } },
      { status: 201, body: savedCapture() },
      { status: 201, body: savedEvent('event-task') },
    );
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', outboxDirectory: temporaryOutboxDirectory(), fetch: fake.fetch });

    assert.deepEqual(await client.beforeTask(beforeTask), context());
    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.' }), { status: 'saved', memoryStatus: 'active' });
    assert.deepEqual(await client.afterTask(envelope, { messageId: 'message-2', content: 'Implemented SDK.' }), { status: 'saved' });
    assert.deepEqual(await client.onSessionEnd(), []);

    assert.equal(fake.calls.length, 3);
    assert.equal(fake.calls.every(({ init }) => init.headers.authorization === `Bearer ${token}`), true);
    assert.equal(fake.calls[0].url.endsWith('/v1/context/resolve'), true);
    assert.equal(fake.calls[1].url.endsWith('/v1/memories/capture'), true);
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
      scope: { level: 'project', projectId: 'memlume' },
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

  test('does not send a task scope containing a credential to the context endpoint', async () => {
    const secret = 'sk-live-never-persist-this';
    const warnings = [];
    const fake = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, fetch: fake.fetch, warn: (message) => warnings.push(message) });

    const result = await client.beforeTask({ ...beforeTask, scope: { level: 'project', projectId: secret } });

    assert.equal(result.scope.projectId, secret);
    assert.equal(fake.calls.length, 0);
    assert.equal(warnings.join(' ').includes(secret), false);
  });

  test('uses a stable unique source reference so only retries share an event identity', async () => {
    const references = new Set();
    const fake = {
      fetch: async (_input, init) => {
        references.add(JSON.parse(init.body).source.reference);
        return new Response(JSON.stringify(savedCapture()), { status: 201 });
      },
    };
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxDirectory: temporaryOutboxDirectory(), fetch: fake.fetch });

    await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Same content.' });
    await client.onUserMessage(envelope, { messageId: 'message-2', content: 'Same content.' });
    await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Same content.' });

    assert.deepEqual([...references], [
      JSON.stringify(['codex', 'desktop', 'default', 'session-1', 'message-1']),
      JSON.stringify(['codex', 'desktop', 'default', 'session-1', 'message-2']),
    ]);
    assert.equal(JSON.stringify([...references]).includes(token), false);
  });

  test('queues an explicit capture when a successful response is not valid JSON with a UUIDv7 brain ID', async () => {
    const outboxPath = temporaryOutbox();
    const malformed = new Response('not json', { status: 201, headers: { 'content-type': 'application/json' } });
    const missingBody = new Response(null, { status: 204 });
    const invalidBrain = new Response(JSON.stringify({ event: { id: 'event-user', brainId: 'not-a-uuid' } }), { status: 201 });

    for (const [index, response] of [malformed, missingBody, invalidBrain].entries()) {
      const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: fakeFetch(response).fetch });
      assert.deepEqual(await client.onUserMessage(envelope, { messageId: `invalid-${index}`, content: 'Remember only confirmed memories are saved.' }), { status: 'queued' });
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

  test('queues only explicit memory requests while offline and never turns ordinary turns into later candidates', async () => {
    const outboxPath = temporaryOutbox();
    const unavailable = fakeFetch(
      { status: 503, body: { error: 'unavailable' } },
      { status: 503, body: { error: 'unavailable' } },
      { status: 503, body: { error: 'unavailable' } },
    );
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: unavailable.fetch });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'ordinary', content: 'Vue is used for the frontend.' }), { status: 'rejected' });
    assert.equal(existsSync(outboxPath), false);
    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'explicit', content: 'Remember Vue is used for the frontend.' }), { status: 'queued' });
    assert.deepEqual(await client.afterTask(envelope, { messageId: 'task', content: 'Implemented the frontend.' }), { status: 'rejected' });

    const entries = readFileSync(outboxPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].request.source.messageId, 'explicit');
  });

  test('rejects sensitive raw or structured content before it can be sent online or persisted in an outbox', async () => {
    const outboxPath = temporaryOutbox();
    const secret = 'Remember API_KEY=adapter-secret-that-must-not-be-persisted';
    const fake = fakeFetch({ status: 201, body: savedCapture() });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: fake.fetch });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'secret-online', content: secret }), { status: 'rejected' });
    assert.deepEqual(
      await client.afterTask(envelope, { messageId: 'secret-structured', content: 'Finished safely.', structuredData: { nested: { apiKey: 'adapter-structured-secret' } } }),
      { status: 'rejected' },
    );
    assert.equal(fake.calls.length, 0);
    assert.equal(existsSync(outboxPath), false);
  });

  test('rejects credentials carried by an event source or capture scope before network and outbox persistence', async () => {
    const outboxPath = temporaryOutbox();
    const secret = 'sk-live-never-persist-this';
    const fake = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: fake.fetch });

    assert.deepEqual(
      await client.onUserMessage(envelope, { messageId: secret, content: 'Remember Vue.', scope: { level: 'project', projectId: secret } }),
      { status: 'rejected' },
    );
    assert.equal(fake.calls.length, 0);
    assert.equal(existsSync(outboxPath), false);
  });

  test('rejects secret capture writes locally before an unavailable daemon or outbox can receive them', async () => {
    const secret = 'Remember API_KEY=adapter-secret-that-must-not-be-persisted';

    for (const response of [new Error('offline'), { status: 503, body: { error: 'unavailable' } }]) {
      const outboxPath = temporaryOutbox();
      const warnings = [];
      const fake = fakeFetch(response);
      const client = new AdapterClient({
        daemonUrl: 'http://127.0.0.1:3849',
        token,
        outboxPath,
        fetch: fake.fetch,
        warn: (message) => warnings.push(message),
      });

      assert.deepEqual(await client.onUserMessage(envelope, { messageId: `secret-${warnings.length}`, content: secret }), { status: 'rejected' });
      assert.equal(fake.calls.length, 0);
      assert.equal(existsSync(outboxPath), false);
      assert.deepEqual(warnings, []);
      assert.equal(warnings.join(' ').includes(secret), false);
    }
  });

  test('rejects a secret capture without a token without writing an outbox', async () => {
    const outboxPath = temporaryOutbox();
    const secret = 'Remember API_KEY=adapter-secret-that-must-not-be-persisted';
    const fake = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', outboxPath, fetch: fake.fetch });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'secret-tokenless', content: secret }), { status: 'rejected' });
    assert.equal(fake.calls.length, 0);
    assert.equal(existsSync(outboxPath), false);
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
      { status: 201, body: savedCapture() },
      { status: 200, body: { context: context() } },
    );
    const newClient = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token: newToken, outboxDirectory, fetch: recovered.fetch });
    assert.deepEqual(await newClient.beforeTask({ ...beforeTask, envelope }), context());

    assert.deepEqual(await newClient.onSessionEnd(), []);
    assert.equal(readFileSync(outboxPath, 'utf8'), '');
    assert.equal(outboxPath.includes(oldToken) || outboxPath.includes(newToken), false);
    assert.equal(recovered.calls[0].init.headers.authorization, `Bearer ${newToken}`);
  });

  test('does not flush a default outbox before an envelope establishes its identity', async () => {
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, fetch: fakeFetch().fetch });

    assert.deepEqual(await client.onSessionEnd(), []);
  });

  test('flushes an existing outbox at the next user-turn callback without waiting for session end', async () => {
    const outboxPath = temporaryOutbox();
    const offline = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: fakeFetch({ status: 503, body: { error: 'unavailable' } }).fetch,
    });
    await offline.onUserMessage(envelope, { messageId: 'old-turn', content: 'Remember Vue.' });

    const recovered = fakeFetch(
      { status: 201, body: savedCapture() },
      { status: 201, body: savedCapture() },
    );
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: recovered.fetch });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'new-turn', content: 'Remember TypeScript.' }), { status: 'saved', memoryStatus: 'active' });
    assert.equal(JSON.parse(recovered.calls[0].init.body).source.messageId, 'old-turn');
    assert.equal(readFileSync(outboxPath, 'utf8'), '');
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

    const recovering = fakeFetch({ status: 201, body: savedCapture() });
    const retryingClient = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: recovering.fetch });
    assert.deepEqual(await retryingClient.onSessionEnd(), [{ status: 'saved', memoryStatus: 'active' }]);
    assert.equal(readFileSync(outboxPath, 'utf8'), '');
  });

  test('flushes valid JSONL entries when an interrupted final line is partial JSON', async () => {
    const outboxPath = temporaryOutbox();
    const offline = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: fakeFetch({ status: 503, body: { error: 'unavailable' } }).fetch,
    });
    await offline.onUserMessage(envelope, { messageId: 'complete-line', content: 'Remember Vue.' });
    writeFileSync(outboxPath, `${readFileSync(outboxPath, 'utf8')}{"state":"pend`, 'utf8');

    const recovered = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: fakeFetch({ status: 201, body: savedCapture() }).fetch,
    });

    assert.deepEqual(await recovered.onSessionEnd(), [{ status: 'saved', memoryStatus: 'active' }]);
    assert.equal(readFileSync(outboxPath, 'utf8'), '');
  });

  test('repairs an interrupted final JSONL fragment before appending a later queued event', async () => {
    const outboxPath = temporaryOutbox();
    writeFileSync(outboxPath, '{"state":"pend', 'utf8');
    const unavailable = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: unavailable.fetch });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'recovered-line', content: 'Remember Vue.' }), { status: 'queued' });
    const entries = readFileSync(outboxPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].messageId, 'recovered-line');

    const recovered = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: fakeFetch({ status: 201, body: savedCapture() }).fetch,
    });
    assert.deepEqual(await recovered.onSessionEnd(), [{ status: 'saved', memoryStatus: 'active' }]);
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
    const accepting = fakeFetch({ status: 201, body: savedCapture() });
    const client = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: accepting.fetch,
      warn: (message) => warnings.push(message),
    });

    assert.deepEqual(await client.onSessionEnd(), [{ status: 'saved', memoryStatus: 'active' }]);
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

  test('marks authentication failures discarded instead of retrying or exposing the token', async () => {
    const outboxPath = temporaryOutbox();
    const queued = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: queued.fetch });
    await client.onUserMessage(envelope, { messageId: 'message-2', content: 'Remember the SDK implementation.' });

    const rejected = fakeFetch({ status: 401, body: { error: 'unauthorized' } });
    const retryingClient = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: rejected.fetch });
    const result = await retryingClient.onSessionEnd();
    assert.deepEqual(result, [{ status: 'rejected' }]);
    assert.deepEqual(await retryingClient.outboxStatus(), { state: 'discarded', pending: 0, retry: 0, discarded: 1 });
    assert.equal(readFileSync(outboxPath, 'utf8').includes(token), false);
    assert.equal(JSON.stringify(result).includes(token), false);
  });

  test('retains a rate-limited outbox entry for retry instead of discarding it', async () => {
    const outboxPath = temporaryOutbox();
    const offline = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: offline.fetch });
    await client.onUserMessage(envelope, { messageId: 'rate-limited', content: 'Remember Vue.' });

    const rateLimited = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: fakeFetch({ status: 429, body: { error: 'too_many_requests' } }).fetch,
    });

    assert.deepEqual(await rateLimited.onSessionEnd(), [{ status: 'queued' }]);
    assert.deepEqual(await rateLimited.outboxStatus(), { state: 'pending', pending: 1, retry: 1, discarded: 0 });
  });

  test('marks queued entries discarded when the daemon rejects them with 400 or 403', async () => {
    const outboxPath = temporaryOutbox();
    const queued = fakeFetch(
      { status: 503, body: { error: 'unavailable' } },
      { status: 503, body: { error: 'unavailable' } },
    );
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: queued.fetch });
    await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember the first setting.' });
    await client.onUserMessage(envelope, { messageId: 'message-2', content: 'Remember the second setting.' });

    const rejecting = fakeFetch(
      { status: 400, body: { error: 'invalid_request' } },
      { status: 403, body: { error: 'forbidden' } },
    );
    const flushingClient = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: rejecting.fetch });
    assert.deepEqual(await flushingClient.onSessionEnd(), [{ status: 'rejected' }, { status: 'rejected' }]);
    assert.deepEqual(await flushingClient.outboxStatus(), { state: 'discarded', pending: 0, retry: 0, discarded: 2 });
  });

  test('serializes an in-flight flush with a queued write from the same client', async () => {
    const outboxPath = temporaryOutbox();
    const seeding = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const seedClient = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: seeding.fetch });
    await seedClient.onUserMessage(envelope, { messageId: 'message-old', content: 'Remember the old pending event.' });

    const oldRequestStarted = deferred();
    const releaseOldRequest = deferred();
    const racing = {
      fetch: async (_input, init) => {
        const messageId = JSON.parse(init.body).source.messageId;
        if (messageId === 'message-old') {
          oldRequestStarted.resolve();
          await releaseOldRequest.promise;
          return new Response(JSON.stringify(savedCapture()), { status: 201 });
        }
        return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
      },
    };
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: racing.fetch });

    const ending = client.onSessionEnd();
    await oldRequestStarted.promise;
    const writing = client.onUserMessage(envelope, { messageId: 'message-new', content: 'Remember the new pending event.' });
    releaseOldRequest.resolve();
    assert.deepEqual(await ending, [{ status: 'saved', memoryStatus: 'active' }]);
    assert.deepEqual(await writing, { status: 'queued' });

    const pending = readFileSync(outboxPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(pending.map((entry) => entry.messageId), ['message-new']);
  });

  test('does not lose a concurrent client write while another client flushes the same outbox', async () => {
    const outboxPath = temporaryOutbox();
    const seeding = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: fakeFetch({ status: 503, body: { error: 'unavailable' } }).fetch,
    });
    await seeding.onUserMessage(envelope, { messageId: 'old-turn', content: 'Remember Vue.' });

    const oldRequestStarted = deferred();
    const releaseOldRequest = deferred();
    const flushing = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: async () => {
        oldRequestStarted.resolve();
        await releaseOldRequest.promise;
        return new Response(JSON.stringify(savedCapture()), { status: 201 });
      },
    });
    const ending = flushing.onSessionEnd();
    await oldRequestStarted.promise;

    const concurrent = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: fakeFetch({ status: 503, body: { error: 'unavailable' } }, { status: 503, body: { error: 'unavailable' } }).fetch,
    });
    const writing = concurrent.onUserMessage(envelope, { messageId: 'new-turn', content: 'Remember TypeScript.' });
    let completed = false;
    void writing.then(() => { completed = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(completed, false);
    releaseOldRequest.resolve();

    await ending;
    await writing;
    const pending = readFileSync(outboxPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(pending.filter((entry) => entry.state !== 'discarded').map((entry) => entry.request.source.messageId), ['new-turn']);
  });
});
