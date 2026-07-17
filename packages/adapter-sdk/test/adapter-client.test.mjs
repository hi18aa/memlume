import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { AdapterClient, loadLocalAdapterProfile } from '../dist/index.js';

const directories = [];
const token = 'adapter-token-that-must-not-be-persisted';
const brainId = '00000000-0000-7000-8000-000000000002';
const mountedBrainId = '00000000-0000-7000-8000-000000000005';
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

function assertEmptyContext(value, input = beforeTask) {
  const { traceId, ...contextPack } = value;
  assert.equal(typeof traceId, 'string');
  assert.deepEqual(contextPack, {
    intent: input.intent,
    scope: input.scope,
    directives: [],
    procedures: [],
    preferences: [],
    knowledge: [],
    decisions: [],
    explanation: {
      sourceMemoryIds: [],
      exclusions: [],
      budget: { limitUnits: input.contextBudget, usedUnits: 0, included: [], omitted: [], truncated: false },
    },
  });
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
      const path = new URL(String(input)).pathname;
      const expectedBodyKey = path.endsWith('/context/resolve') ? 'context' : 'capture';
      const matchingIndex = responses.findIndex((candidate) => (
        candidate && typeof candidate === 'object' && !(candidate instanceof Error) && !(candidate instanceof Response) &&
        candidate.body && typeof candidate.body === 'object' && Object.hasOwn(candidate.body, expectedBodyKey)
      ));
      const next = matchingIndex >= 0 ? responses.splice(matchingIndex, 1)[0] : responses.shift();
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

async function eventually(assertion, timeoutMs = 500) {
  const deadline = performance.now() + timeoutMs;
  let lastError;
  while (performance.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

describe('AdapterClient', () => {
  test('loads only the matching local adapter profile and lets explicit host configuration override it', () => {
    const directory = temporaryOutboxDirectory();
    const configPath = join(directory, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      backupDirectory: join(directory, 'backups'),
      adapters: [
        {
          clientType: 'hermes',
          installationId: 'hermes-main',
          profileId: 'default',
          projectId: 'memlume',
          brainId,
          token: 'hermes-token',
          corePath: 'C:/work/memlume',
          daemonUrl: 'http://127.0.0.1:3849',
        },
        {
          clientType: 'codex',
          installationId: 'codex-main',
          profileId: 'default',
          projectId: 'memlume',
          brainId,
          token: 'codex-token',
          corePath: 'C:/work/memlume',
          daemonUrl: 'http://127.0.0.1:3849',
        },
      ],
    }));

    const profile = loadLocalAdapterProfile('hermes', {
      configPath,
      environment: {
        MEMLUME_TOKEN: 'explicit-hermes-token',
        MEMLUME_PROJECT_ID: 'explicit-project',
      },
    });

    assert.deepEqual(profile, {
      clientType: 'hermes',
      installationId: 'hermes-main',
      profileId: 'default',
      projectId: 'explicit-project',
      brainId,
      token: 'explicit-hermes-token',
      corePath: 'C:/work/memlume',
      daemonUrl: 'http://127.0.0.1:3849',
    });
    assert.equal(loadLocalAdapterProfile('claude-code', { configPath, environment: {} }), undefined);
  });

  test('forwards a requested context Brain subset without the local envelope', async () => {
    const fake = fakeFetch({ status: 200, body: { context: context() } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxDirectory: temporaryOutboxDirectory(), fetch: fake.fetch });
    const requestedBrainIds = [brainId, '00000000-0000-7000-8000-000000000005'];

    await client.beforeTask({ ...beforeTask, envelope, requestedBrainIds });
    assert.deepEqual(JSON.parse(fake.calls[0].init.body), { ...beforeTask, requestedBrainIds });
  });

  test('reads subagent context from exactly the configured Project Brain without host-only metadata or writes', async () => {
    const fake = fakeFetch({ status: 200, body: { context: context() } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, defaultWriteBrainId: brainId, outboxDirectory: temporaryOutboxDirectory(), fetch: fake.fetch });

    assert.deepEqual(await client.onSubagentStart({
      ...beforeTask,
      envelope,
      parentTaskId: 'parent-task',
      subagentId: 'child-agent',
    }), context());
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url.endsWith('/v1/context/resolve'), true);
    assert.deepEqual(JSON.parse(fake.calls[0].init.body), { ...beforeTask, requestedBrainIds: [brainId] });
  });

  test('rejects subagent context outside the configured Project Brain before HTTP', async () => {
    for (const requestedBrainIds of [[mountedBrainId], []]) {
      const fake = fakeFetch({ status: 200, body: { context: context() } });
      const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, defaultWriteBrainId: brainId, outboxDirectory: temporaryOutboxDirectory(), fetch: fake.fetch, warn: () => undefined });

      const result = await client.onSubagentStart({ ...beforeTask, envelope, parentTaskId: 'parent-task', requestedBrainIds });
      assertEmptyContext(result);
      assert.equal(fake.calls.length, 0);
    }
  });

  test('rejects subagent context without a configured Project Brain before HTTP', async () => {
    const fake = fakeFetch({ status: 200, body: { context: context() } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxDirectory: temporaryOutboxDirectory(), fetch: fake.fetch, warn: () => undefined });

    const result = await client.onSubagentStart({ ...beforeTask, envelope, parentTaskId: 'parent-task', requestedBrainIds: [brainId] });
    assertEmptyContext(result);
    assert.equal(fake.calls.length, 0);
  });

  test('exposes only the three shared lifecycle methods', () => {
    const methods = Object.getOwnPropertyNames(AdapterClient.prototype);
    assert.equal(methods.includes('beforeTask'), true);
    assert.equal(methods.includes('onUserMessage'), true);
    assert.equal(methods.includes('onSubagentStart'), true);
    assert.equal(methods.includes('afterTask'), false);
    assert.equal(methods.includes('onSessionEnd'), false);
  });

  test('reads subagent context without flushing an existing outbox capture', async () => {
    const outboxPath = temporaryOutbox();
    const pending = {
      state: 'pending',
      retryCount: 0,
      messageId: 'pending-parent-memory',
      request: {
        endpoint: '/v1/memories/capture',
        rawContent: 'Remember Vue.',
        eventType: 'user_message',
        source: {
          type: 'codex',
          agent: 'codex',
          conversationId: 'session-1',
          messageId: 'pending-parent-memory',
          reference: 'pending-parent-memory',
        },
        brainId,
        scope: { level: 'project', projectId: 'memlume' },
        structuredData: { envelope },
      },
    };
    const original = `${JSON.stringify(pending)}\n`;
    writeFileSync(outboxPath, original, 'utf8');
    const paths = [];
    const client = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      defaultWriteBrainId: brainId,
      outboxPath,
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        return new Response(JSON.stringify(path === '/v1/context/resolve' ? { context: context() } : savedCapture()), { status: 200 });
      },
    });

    await client.onSubagentStart({ ...beforeTask, envelope, parentTaskId: 'parent-task' });
    assert.deepEqual(paths, ['/v1/context/resolve']);
    assert.equal(readFileSync(outboxPath, 'utf8'), original);
  });

  test('discards a legacy task audit without sending it or blocking a new explicit capture', async () => {
    const outboxPath = temporaryOutbox();
    writeFileSync(outboxPath, `${JSON.stringify({
      state: 'pending',
      retryCount: 2,
      messageId: 'legacy-task-audit',
      request: {
        endpoint: '/v1/events',
        rawContent: 'Completed a task.',
        eventType: 'task_completed',
        source: {
          type: 'codex', agent: 'codex', conversationId: 'session-1', messageId: 'legacy-task-audit', reference: 'legacy-task-audit',
        },
        brainId,
        structuredData: { envelope },
      },
    })}\n`, 'utf8');
    const paths = [];
    const client = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        return new Response(JSON.stringify(path === '/v1/context/resolve' ? { context: context() } : savedCapture()), {
          status: path === '/v1/context/resolve' ? 200 : 201,
        });
      },
    });

    await client.beforeTask({ ...beforeTask, envelope });
    assert.deepEqual(await client.outboxStatus(), { state: 'discarded', pending: 0, retry: 0, discarded: 1 });
    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'new-memory', content: 'Remember Vue.', brainId }), { status: 'saved', memoryStatus: 'active' });
    assert.deepEqual(paths, ['/v1/context/resolve', '/v1/memories/capture']);
    assert.equal(JSON.parse(readFileSync(outboxPath, 'utf8')).endpoint, '/v1/events');
  });

  test('uses the configured default Brain for a new user-memory capture', async () => {
    const fake = fakeFetch({ status: 201, body: savedCapture() });
    const client = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      defaultWriteBrainId: brainId,
      outboxDirectory: temporaryOutboxDirectory(),
      fetch: fake.fetch,
    });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'default-target', content: 'Remember Vue.' }), { status: 'saved', memoryStatus: 'active' });
    assert.equal(JSON.parse(fake.calls[0].init.body).brainId, brainId);
  });

  test('uses an explicit message Brain instead of the configured default', async () => {
    const explicitBrainId = '00000000-0000-7000-8000-000000000006';
    const fake = fakeFetch({ status: 201, body: savedCapture() });
    const client = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      defaultWriteBrainId: brainId,
      outboxDirectory: temporaryOutboxDirectory(),
      fetch: fake.fetch,
    });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'explicit-target', content: 'Remember Vue.', brainId: explicitBrainId }), { status: 'saved', memoryStatus: 'active' });
    assert.equal(JSON.parse(fake.calls[0].init.body).brainId, explicitBrainId);
  });

  test('sends a v0.3 workspace capture without selecting a Brain locally', async () => {
    const automaticEnvelope = {
      clientType: 'codex',
      installationId: 'desktop-automatic',
      profileId: 'default',
      sessionId: 'session-automatic',
      workspacePath: 'C:/work/memlume',
    };
    const fake = fakeFetch({
      status: 201,
      body: {
        receipt: {
          captureId: 'capture-automatic',
          sourceReference: 'codex-reference',
          status: 'active',
          atoms: [{ atomKey: 'atom-1', status: 'active', brainId }],
          createdAt: '2026-07-16T00:00:00.000Z',
          updatedAt: '2026-07-16T00:00:00.000Z',
        },
      },
    });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, fetch: fake.fetch });
    const result = await client.onUserMessage(automaticEnvelope, {
      messageId: 'message-automatic',
      turnId: 'turn-automatic',
      content: '記住我使用 Vue 開發前端',
    });
    assert.deepEqual(result, { status: 'saved', memoryStatus: 'active' });
    assert.equal(new URL(fake.calls[0].url).pathname, '/v1/capture');
    const body = JSON.parse(fake.calls[0].init.body);
    assert.equal(body.brainId, undefined);
    assert.equal(body.workspacePath, automaticEnvelope.workspacePath);
    assert.equal(body.sessionId, automaticEnvelope.sessionId);
    assert.equal(body.turnId, 'turn-automatic');
    assert.equal(body.actor, 'user');
  });

  test('rejects a new user-memory capture without a target Brain before any network or outbox work', async () => {
    const outboxPath = temporaryOutbox();
    const fake = fakeFetch({ status: 201, body: savedCapture() });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: fake.fetch });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'missing-target', content: 'Remember Vue.' }), { status: 'rejected' });
    assert.equal(fake.calls.length, 0);
    assert.equal(existsSync(outboxPath), false);
  });

  test('rejects a targetless capture before creating an outbox parent directory', async () => {
    const directory = temporaryOutboxDirectory();
    const outboxPath = join(directory, 'missing', 'nested', 'outbox.jsonl');
    const fake = fakeFetch({ status: 201, body: savedCapture() });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: fake.fetch });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'missing-target-directory', content: 'Remember Vue.' }), { status: 'rejected' });
    assert.equal(fake.calls.length, 0);
    assert.equal(existsSync(join(directory, 'missing')), false);
  });

  test('rejects a targetless capture without flushing an existing outbox entry', async () => {
    const outboxPath = temporaryOutbox();
    const pending = {
      state: 'pending',
      retryCount: 0,
      messageId: 'pending-no-target',
      request: {
        endpoint: '/v1/memories/capture',
        rawContent: 'Remember Vue.',
        eventType: 'user_message',
        source: {
          type: 'codex',
          agent: 'codex',
          conversationId: 'session-1',
          messageId: 'pending-no-target',
          reference: 'pending-no-target',
        },
        brainId,
        scope: { level: 'project', projectId: 'memlume' },
        structuredData: { envelope },
      },
    };
    const original = `${JSON.stringify(pending)}\n`;
    writeFileSync(outboxPath, original, 'utf8');
    const fake = fakeFetch({ status: 201, body: savedCapture() });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: fake.fetch });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'missing-target-pending', content: 'Remember Vue.' }), { status: 'rejected' });
    assert.equal(fake.calls.length, 0);
    assert.equal(readFileSync(outboxPath, 'utf8'), original);
  });

  test('upgrades a legacy capture outbox entry with the configured default Brain before retrying it', async () => {
    const outboxPath = temporaryOutbox();
    const legacy = {
      state: 'pending',
      retryCount: 0,
      messageId: 'legacy-default-target',
      request: {
        endpoint: '/v1/memories/capture',
        rawContent: 'Remember Vue.',
        eventType: 'user_message',
        source: {
          type: 'codex',
          agent: 'codex',
          conversationId: 'session-1',
          messageId: 'legacy-default-target',
          reference: 'legacy-default-target',
        },
        scope: { level: 'project', projectId: 'memlume' },
        structuredData: { envelope },
      },
    };
    writeFileSync(outboxPath, `${JSON.stringify(legacy)}\n`, 'utf8');
    const fake = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, defaultWriteBrainId: brainId, fetch: fake.fetch });

    await client.beforeTask({ ...beforeTask, envelope });
    await eventually(() => {
      const capture = fake.calls.find((call) => new URL(call.url).pathname === '/v1/memories/capture');
      assert.ok(capture);
      assert.equal(JSON.parse(capture.init.body).brainId, brainId);
      assert.equal(JSON.parse(readFileSync(outboxPath, 'utf8')).request.brainId, brainId);
    });
  });

  test('keeps a legacy capture outbox entry pending when this client has no target Brain', async () => {
    const outboxPath = temporaryOutbox();
    const legacy = {
      state: 'pending',
      retryCount: 0,
      messageId: 'legacy-missing-target',
      request: {
        endpoint: '/v1/memories/capture',
        rawContent: 'Remember Vue.',
        eventType: 'user_message',
        source: {
          type: 'codex',
          agent: 'codex',
          conversationId: 'session-1',
          messageId: 'legacy-missing-target',
          reference: 'legacy-missing-target',
        },
        scope: { level: 'project', projectId: 'memlume' },
        structuredData: { envelope },
      },
    };
    writeFileSync(outboxPath, `${JSON.stringify(legacy)}\n`, 'utf8');
    const warnings = [];
    const fake = fakeFetch(
      { status: 200, body: { context: context() } },
      { status: 200, body: { context: context() } },
    );
    const client = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: fake.fetch,
      warn: (message) => warnings.push(message),
    });

    await client.beforeTask({ ...beforeTask, envelope });
    assert.deepEqual(fake.calls.map(({ url }) => new URL(url).pathname), ['/v1/context/resolve']);
    assert.deepEqual(await client.outboxStatus(), { state: 'pending', pending: 1, retry: 1, discarded: 0 });
    assert.equal(JSON.parse(readFileSync(outboxPath, 'utf8')).request.brainId, undefined);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].includes('Remember Vue.'), false);

    const retryWarnings = [];
    const retrying = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: fake.fetch,
      warn: (message) => retryWarnings.push(message),
    });
    await retrying.beforeTask({ ...beforeTask, envelope });
    assert.deepEqual(retryWarnings, []);
  });

  test('replaces a matching targetless legacy capture with the safe incoming request during queue deduplication', async () => {
    const outboxPath = temporaryOutbox();
    const messageId = 'legacy-collision-message';
    const legacySecret = 'legacy-structured-secret';
    const legacy = {
      state: 'retry',
      retryCount: 7,
      messageId: 'legacy-queue-metadata',
      request: {
        endpoint: '/v1/memories/capture',
        rawContent: 'Remember Vue.',
        eventType: 'user_message',
        source: {
          type: 'codex',
          agent: 'codex',
          conversationId: 'session-1',
          messageId,
          reference: JSON.stringify(['codex', 'desktop', 'default', 'session-1', messageId]),
        },
        scope: { level: 'project', projectId: 'memlume' },
        structuredData: { envelope, data: { apiKey: legacySecret } },
      },
    };
    writeFileSync(outboxPath, `${JSON.stringify(legacy)}\n`, 'utf8');
    const unavailable = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: unavailable.fetch });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId, content: 'Remember Vue.', brainId }), { status: 'queued' });
    const entries = readFileSync(outboxPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].state, 'retry');
    assert.equal(entries[0].retryCount, 8);
    assert.equal(entries[0].messageId, 'legacy-queue-metadata');
    assert.equal(entries[0].request.brainId, brainId);
    assert.equal(entries[0].request.source.reference, legacy.request.source.reference);
    assert.deepEqual(entries[0].request.structuredData, { envelope });
    assert.equal(readFileSync(outboxPath, 'utf8').includes(legacySecret), false);

    const recoveredFetch = fakeFetch(
      { status: 201, body: savedCapture() },
      { status: 200, body: { context: context() } },
    );
    const recovered = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: recoveredFetch.fetch,
    });
    await recovered.beforeTask({ ...beforeTask, envelope });
    await recovered.outboxStatus();
    assert.equal(recoveredFetch.calls.some(({ url }) => url.endsWith('/v1/memories/capture')), true);
    assert.equal(readFileSync(outboxPath, 'utf8'), '');
  });

  test('upgrades and clears a matching targetless legacy capture after direct delivery succeeds', async () => {
    const outboxPath = temporaryOutbox();
    const messageId = 'legacy-direct-success';
    const legacy = {
      state: 'retry',
      retryCount: 7,
      messageId: 'legacy-direct-metadata',
      request: {
        endpoint: '/v1/memories/capture',
        rawContent: 'Remember Vue.',
        eventType: 'user_message',
        source: {
          type: 'codex',
          agent: 'codex',
          conversationId: 'session-1',
          messageId,
          reference: JSON.stringify(['codex', 'desktop', 'default', 'session-1', messageId]),
        },
        scope: { level: 'project', projectId: 'memlume' },
        structuredData: { envelope },
      },
    };
    writeFileSync(outboxPath, `${JSON.stringify(legacy)}\n`, 'utf8');
    const paths = [];
    let entryDuringDelivery;
    const client = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: async (input) => {
        paths.push(new URL(String(input)).pathname);
        entryDuringDelivery = JSON.parse(readFileSync(outboxPath, 'utf8'));
        return new Response(JSON.stringify(savedCapture()), { status: 201 });
      },
    });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId, content: 'Remember Vue.', brainId }), { status: 'saved', memoryStatus: 'active' });
    assert.deepEqual(paths, ['/v1/memories/capture']);
    assert.equal(entryDuringDelivery.state, 'retry');
    assert.equal(entryDuringDelivery.retryCount, 8);
    assert.equal(entryDuringDelivery.messageId, 'legacy-direct-metadata');
    assert.equal(entryDuringDelivery.request.brainId, brainId);
    assert.equal(readFileSync(outboxPath, 'utf8'), '');

    const nextPaths = [];
    const nextClient = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: async (input) => {
        nextPaths.push(new URL(String(input)).pathname);
        return new Response(JSON.stringify(savedCapture()), { status: 201 });
      },
    });
    await nextClient.beforeTask({ ...beforeTask, envelope });
    assert.deepEqual(nextPaths, ['/v1/context/resolve']);
  });

  test('uses an explicit incoming Brain before flushing a matching legacy capture with a default Brain', async () => {
    const defaultBrainId = '00000000-0000-7000-8000-000000000007';
    const explicitBrainId = '00000000-0000-7000-8000-000000000008';
    const outboxPath = temporaryOutbox();
    const messageId = 'legacy-default-conflict';
    const legacy = {
      state: 'retry',
      retryCount: 7,
      messageId: 'legacy-default-metadata',
      request: {
        endpoint: '/v1/memories/capture',
        rawContent: 'Remember Vue.',
        eventType: 'user_message',
        source: {
          type: 'codex',
          agent: 'codex',
          conversationId: 'session-1',
          messageId,
          reference: JSON.stringify(['codex', 'desktop', 'default', 'session-1', messageId]),
        },
        scope: { level: 'project', projectId: 'memlume' },
        structuredData: { envelope },
      },
    };
    writeFileSync(outboxPath, `${JSON.stringify(legacy)}\n`, 'utf8');
    const bodies = [];
    const client = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      defaultWriteBrainId: defaultBrainId,
      outboxPath,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(savedCapture()), { status: 201 });
      },
    });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId, content: 'Remember Vue.', brainId: explicitBrainId }), { status: 'saved', memoryStatus: 'active' });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].brainId, explicitBrainId);
    assert.equal(bodies.some((body) => body.brainId === defaultBrainId), false);
    assert.equal(readFileSync(outboxPath, 'utf8'), '');
  });

  test('fails closed when a matching legacy target cannot be persisted before default-brain flushing', async () => {
    const defaultBrainId = '00000000-0000-7000-8000-000000000007';
    const explicitBrainId = '00000000-0000-7000-8000-000000000008';
    const outboxPath = temporaryOutbox();
    const messageId = 'legacy-upgrade-unavailable';
    const legacy = {
      state: 'retry',
      retryCount: 7,
      messageId: 'legacy-unavailable-metadata',
      request: {
        endpoint: '/v1/memories/capture',
        rawContent: 'Remember Vue.',
        eventType: 'user_message',
        source: {
          type: 'codex',
          agent: 'codex',
          conversationId: 'session-1',
          messageId,
          reference: JSON.stringify(['codex', 'desktop', 'default', 'session-1', messageId]),
        },
        scope: { level: 'project', projectId: 'memlume' },
        structuredData: { envelope },
      },
    };
    const original = `${JSON.stringify(legacy)}\n`;
    writeFileSync(outboxPath, original, 'utf8');
    mkdirSync(`${outboxPath}.${process.pid}.tmp`, { recursive: true });
    const bodies = [];
    const client = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      defaultWriteBrainId: defaultBrainId,
      outboxPath,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(savedCapture()), { status: 201 });
      },
      warn: () => undefined,
    });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId, content: 'Remember Vue.', brainId: explicitBrainId }), { status: 'rejected' });
    assert.deepEqual(bodies, []);
    assert.equal(readFileSync(outboxPath, 'utf8'), original);
  });

  test('fails closed when a matching legacy capture lock times out before the default Brain can flush it', async () => {
    const defaultBrainId = '00000000-0000-7000-8000-000000000007';
    const explicitBrainId = '00000000-0000-7000-8000-000000000008';
    const outboxPath = temporaryOutbox();
    const messageId = 'legacy-lock-timeout';
    const legacy = {
      state: 'retry',
      retryCount: 7,
      messageId: 'legacy-lock-timeout-metadata',
      request: {
        endpoint: '/v1/memories/capture',
        rawContent: 'Remember Vue.',
        eventType: 'user_message',
        source: {
          type: 'codex',
          agent: 'codex',
          conversationId: 'session-1',
          messageId,
          reference: JSON.stringify(['codex', 'desktop', 'default', 'session-1', messageId]),
        },
        scope: { level: 'project', projectId: 'memlume' },
        structuredData: { envelope },
      },
    };
    const original = `${JSON.stringify(legacy)}\n`;
    writeFileSync(outboxPath, original, 'utf8');
    const lockPath = `${outboxPath}.lock`;
    mkdirSync(lockPath);
    const releaseLock = setTimeout(() => rmSync(lockPath, { force: true, recursive: true }), 15_100);
    const fake = fakeFetch(
      { status: 201, body: savedCapture() },
      { status: 201, body: savedCapture() },
    );
    const client = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      defaultWriteBrainId: defaultBrainId,
      outboxPath,
      fetch: fake.fetch,
      warn: () => undefined,
    });

    let result;
    try {
      result = await client.onUserMessage(envelope, { messageId, content: 'Remember Vue.', brainId: explicitBrainId });
    } finally {
      clearTimeout(releaseLock);
      rmSync(lockPath, { force: true, recursive: true });
    }
    assert.deepEqual(fake.calls.map(({ init }) => JSON.parse(init.body).brainId), []);
    assert.deepEqual(result, { status: 'rejected' });
    assert.equal(readFileSync(outboxPath, 'utf8'), original);
  });

  test('fails closed when an existing outbox cannot be read before capture delivery', async () => {
    const outboxPath = temporaryOutbox();
    mkdirSync(outboxPath);
    const fake = fakeFetch({ status: 201, body: savedCapture() });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: fake.fetch, warn: () => undefined });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'unreadable-outbox', content: 'Remember Vue.', brainId }), { status: 'rejected' });
    assert.equal(fake.calls.length, 0);
  });

  test('discards a matching legacy capture when its explicit direct delivery is rejected', async () => {
    const explicitBrainId = '00000000-0000-7000-8000-000000000008';
    const outboxPath = temporaryOutbox();
    const messageId = 'legacy-direct-forbidden';
    const legacy = {
      state: 'retry',
      retryCount: 7,
      messageId: 'legacy-forbidden-metadata',
      request: {
        endpoint: '/v1/memories/capture',
        rawContent: 'Remember Vue.',
        eventType: 'user_message',
        source: {
          type: 'codex',
          agent: 'codex',
          conversationId: 'session-1',
          messageId,
          reference: JSON.stringify(['codex', 'desktop', 'default', 'session-1', messageId]),
        },
        scope: { level: 'project', projectId: 'memlume' },
        structuredData: { envelope },
      },
    };
    writeFileSync(outboxPath, `${JSON.stringify(legacy)}\n`, 'utf8');
    const fake = fakeFetch({ status: 403, body: { error: 'mount_denied' } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: fake.fetch });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId, content: 'Remember Vue.', brainId: explicitBrainId }), { status: 'rejected' });
    assert.equal(JSON.parse(fake.calls[0].init.body).brainId, explicitBrainId);
    assert.deepEqual(await client.outboxStatus(), { state: 'discarded', pending: 0, retry: 0, discarded: 1 });
  });

  test('reports rejected and ignored capture outcomes without claiming a saved memory', async () => {
    const fake = fakeFetch(
      { status: 200, body: savedCapture('rejected') },
      { status: 200, body: savedCapture('ignore') },
    );
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxDirectory: temporaryOutboxDirectory(), fetch: fake.fetch });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'rejected-memory', content: 'Remember rejected.', brainId }), { status: 'rejected' });
    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'ignored-memory', content: 'Remember ignored.', brainId }), { status: 'ignored', memoryStatus: 'ignore' });
  });

  test('captures a user message through the governed memory endpoint and reports the memory outcome', async () => {
    const fake = fakeFetch({
      status: 201,
      body: savedCapture(),
    });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxDirectory: temporaryOutboxDirectory(), fetch: fake.fetch });

    assert.deepEqual(
      await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember this project uses pnpm.', brainId }),
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

    await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.', brainId });
    assert.deepEqual(await client.outboxStatus(), { state: 'pending', pending: 1, retry: 0, discarded: 0 });

    const retrying = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: fakeFetch(
        { status: 503, body: { error: 'unavailable' } },
        { status: 200, body: { context: context() } },
      ).fetch,
    });
    await retrying.beforeTask({ ...beforeTask, envelope });
    assert.deepEqual(await retrying.outboxStatus(), { state: 'pending', pending: 1, retry: 1, discarded: 0 });

    const rejecting = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: fakeFetch(
        { status: 403, body: { error: 'forbidden' } },
        { status: 200, body: { context: context() } },
      ).fetch,
    });
    await rejecting.beforeTask({ ...beforeTask, envelope });
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

    const writing = client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.', brainId });
    await started.promise;
    const status = client.outboxStatus();
    release.resolve();

    await writing;
    assert.deepEqual(await status, { state: 'pending', pending: 1, retry: 0, discarded: 0 });
  });

  test('uses the environment token and maps all shared lifecycle callbacks to authenticated daemon requests', async () => {
    process.env.MEMLUME_TOKEN = token;
    const fake = fakeFetch(
      { status: 200, body: { context: context() } },
      { status: 201, body: savedCapture() },
      { status: 200, body: { context: context() } },
    );
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', defaultWriteBrainId: brainId, outboxDirectory: temporaryOutboxDirectory(), fetch: fake.fetch });

    assert.deepEqual(await client.beforeTask(beforeTask), context());
    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.', brainId }), { status: 'saved', memoryStatus: 'active' });
    assert.deepEqual(await client.onSubagentStart({ ...beforeTask, envelope, parentTaskId: 'parent-task', requestedBrainIds: [brainId] }), context());

    assert.equal(fake.calls.length, 3);
    assert.equal(fake.calls.every(({ init }) => init.headers.authorization === `Bearer ${token}`), true);
    assert.deepEqual(fake.calls.map(({ init }) => ({
      callback: init.headers['x-memlume-callback'],
      protocol: init.headers['x-memlume-protocol-version'],
      adapter: init.headers['x-memlume-adapter-version'],
    })), [
      { callback: 'beforeTask', protocol: '1', adapter: '0.2.0' },
      { callback: 'onUserMessage', protocol: '1', adapter: '0.2.0' },
      { callback: 'onSubagentStart', protocol: '1', adapter: '0.2.0' },
    ]);
    assert.equal(fake.calls[0].url.endsWith('/v1/context/resolve'), true);
    assert.equal(fake.calls[1].url.endsWith('/v1/memories/capture'), true);
    assert.equal(fake.calls[2].url.endsWith('/v1/context/resolve'), true);
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
       brainId,
       scope: { level: 'project', projectId: 'memlume' },
      structuredData: { envelope },
    });
    assert.deepEqual(JSON.parse(fake.calls[2].init.body).requestedBrainIds, [brainId]);
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

  test('does not send a credential-shaped task in main or subagent context requests', async () => {
    const secret = 'OPENAI_API_KEY=sk-live-context-secret';
    const warnings = [];
    const fake = fakeFetch({ status: 200, body: { context: context() } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, defaultWriteBrainId: brainId, fetch: fake.fetch, warn: (message) => warnings.push(message) });

    const main = await client.beforeTask({ ...beforeTask, task: `Use ${secret} to deploy.` });
    const child = await client.onSubagentStart({ ...beforeTask, envelope, parentTaskId: 'parent-task', task: `Use ${secret} to test.` });

    assertEmptyContext(main);
    assertEmptyContext(child);
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

    await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Same content.', brainId });
    await client.onUserMessage(envelope, { messageId: 'message-2', content: 'Same content.', brainId });
    await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Same content.', brainId });

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
      assert.deepEqual(await client.onUserMessage(envelope, { messageId: `invalid-${index}`, content: 'Remember only confirmed memories are saved.', brainId }), { status: 'queued' });
    }

    assert.equal(readFileSync(outboxPath, 'utf8').trim().split('\n').length, 3);
  });

  test('queues a 503 in a persistent stable-identity default outbox when no path is specified', async () => {
    const defaultToken = 'default-outbox-token-that-must-not-be-persisted';
    const outboxDirectory = temporaryOutboxDirectory();
    const outboxPath = defaultOutbox(envelope, outboxDirectory);
    const failing = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token: defaultToken, outboxDirectory, fetch: failing.fetch });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.', brainId }), { status: 'queued' });
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

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'ordinary', content: 'Vue is used for the frontend.', brainId }), { status: 'rejected' });
    assert.equal(existsSync(outboxPath), false);
    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'explicit', content: 'Remember Vue is used for the frontend.', brainId }), { status: 'queued' });
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
    assert.deepEqual(await client.onUserMessage(envelope, {
      messageId: 'secret-structured',
      content: 'Remember this safely.',
      brainId,
      structuredData: { nested: { apiKey: 'adapter-structured-secret' } },
    }), { status: 'rejected' });
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

    await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.', brainId });
    await client.onUserMessage(nextSession, { messageId: 'message-1', content: 'Remember Vue.', brainId });

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

    assert.deepEqual(await oldClient.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.', brainId }), { status: 'queued' });

    const recovered = fakeFetch(
      { status: 201, body: savedCapture() },
      { status: 200, body: { context: context() } },
    );
    const newClient = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token: newToken, outboxDirectory, fetch: recovered.fetch });
    assert.deepEqual(await newClient.beforeTask({ ...beforeTask, envelope }), context());
    await newClient.outboxStatus();

    assert.equal(readFileSync(outboxPath, 'utf8'), '');
    assert.equal(outboxPath.includes(oldToken) || outboxPath.includes(newToken), false);
    assert.equal(recovered.calls[0].init.headers.authorization, `Bearer ${newToken}`);
  });

  test('does not bind a default outbox before an envelope establishes its identity', async () => {
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, fetch: fakeFetch().fetch });

    assert.deepEqual(await client.outboxStatus(), { state: 'unbound', pending: 0, retry: 0, discarded: 0 });
  });

  test('binds a default outbox from the next task envelope before flushing a fresh client', async () => {
    const outboxDirectory = temporaryOutboxDirectory();
    const offline = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxDirectory,
      fetch: fakeFetch({ status: 503, body: { error: 'unavailable' } }).fetch,
    });
    await offline.onUserMessage(envelope, { messageId: 'ending-pending', content: 'Remember this project uses pnpm.', brainId });

    const recovered = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxDirectory,
      fetch: fakeFetch(
        { status: 201, body: savedCapture() },
        { status: 200, body: { context: context() } },
      ).fetch,
    });
    await recovered.beforeTask({ ...beforeTask, envelope });
    assert.deepEqual(await recovered.outboxStatus(), { state: 'empty', pending: 0, retry: 0, discarded: 0 });
  });

  test('flushes an existing outbox at the next user-turn callback without waiting for session end', async () => {
    const outboxPath = temporaryOutbox();
    const offline = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: fakeFetch({ status: 503, body: { error: 'unavailable' } }).fetch,
    });
    await offline.onUserMessage(envelope, { messageId: 'old-turn', content: 'Remember Vue.', brainId });

    const recovered = fakeFetch(
      { status: 201, body: savedCapture() },
      { status: 201, body: savedCapture() },
    );
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: recovered.fetch });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'new-turn', content: 'Remember TypeScript.', brainId }), { status: 'saved', memoryStatus: 'active' });
    assert.equal(JSON.parse(recovered.calls[0].init.body).source.messageId, 'old-turn');
    assert.equal(readFileSync(outboxPath, 'utf8'), '');
  });

  test('deduplicates temporary write failures in a token-free JSONL outbox and flushes them later', async () => {
    const outboxPath = temporaryOutbox();
    const failing = fakeFetch({ status: 503, body: { error: 'unavailable' } }, { status: 503, body: { error: 'unavailable' } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: failing.fetch });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.', brainId }), { status: 'queued' });
    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.', brainId }), { status: 'queued' });
    const lines = readFileSync(outboxPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(readFileSync(outboxPath, 'utf8').includes(token), false);

    const recovering = fakeFetch(
      { status: 201, body: savedCapture() },
      { status: 200, body: { context: context() } },
    );
    const retryingClient = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: recovering.fetch });
    await retryingClient.beforeTask({ ...beforeTask, envelope });
    await retryingClient.outboxStatus();
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
    await offline.onUserMessage(envelope, { messageId: 'complete-line', content: 'Remember Vue.', brainId });
    writeFileSync(outboxPath, `${readFileSync(outboxPath, 'utf8')}{"state":"pend`, 'utf8');

    const recovered = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: fakeFetch(
        { status: 201, body: savedCapture() },
        { status: 200, body: { context: context() } },
      ).fetch,
    });

    await recovered.beforeTask({ ...beforeTask, envelope });
    await recovered.outboxStatus();
    assert.equal(readFileSync(outboxPath, 'utf8'), '');
  });

  test('repairs an interrupted final JSONL fragment before appending a later queued event', async () => {
    const outboxPath = temporaryOutbox();
    writeFileSync(outboxPath, '{"state":"pend', 'utf8');
    const unavailable = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: unavailable.fetch });

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'recovered-line', content: 'Remember Vue.', brainId }), { status: 'queued' });
    const entries = readFileSync(outboxPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].messageId, 'recovered-line');

    const recovered = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: fakeFetch(
        { status: 201, body: savedCapture() },
        { status: 200, body: { context: context() } },
      ).fetch,
    });
    await recovered.beforeTask({ ...beforeTask, envelope });
    await recovered.outboxStatus();
    assert.equal(readFileSync(outboxPath, 'utf8'), '');
  });

  test('fails open and preserves the JSONL when a flush cannot rewrite the outbox', async () => {
    const outboxPath = temporaryOutbox();
    const unavailable = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const seedClient = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: unavailable.fetch });
    await seedClient.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.', brainId });
    const original = readFileSync(outboxPath, 'utf8');
    mkdirSync(`${outboxPath}.${process.pid}.tmp`, { recursive: true });

    const warnings = [];
    const accepting = fakeFetch({ status: 201, body: savedCapture() }, { status: 200, body: { context: context() } });
    const client = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: accepting.fetch,
      warn: (message) => warnings.push(message),
    });

    await client.beforeTask({ ...beforeTask, envelope });
    await client.outboxStatus();
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

    assert.deepEqual(await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember Vue.', brainId }), { status: 'rejected' });
    assert.deepEqual(warnings, ['Memlume outbox unavailable; event was not persisted.']);
    assert.equal(warnings.join(' ').includes(token), false);
  });

  test('marks authentication failures discarded instead of retrying or exposing the token', async () => {
    const outboxPath = temporaryOutbox();
    const queued = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: queued.fetch });
    await client.onUserMessage(envelope, { messageId: 'message-2', content: 'Remember the SDK implementation.', brainId });

    const rejected = fakeFetch(
      { status: 401, body: { error: 'unauthorized' } },
      { status: 200, body: { context: context() } },
    );
    const retryingClient = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: rejected.fetch });
    await retryingClient.beforeTask({ ...beforeTask, envelope });
    assert.deepEqual(await retryingClient.outboxStatus(), { state: 'discarded', pending: 0, retry: 0, discarded: 1 });
    assert.equal(readFileSync(outboxPath, 'utf8').includes(token), false);
    assert.equal(readFileSync(outboxPath, 'utf8').includes(token), false);
  });

  test('retains a rate-limited outbox entry for retry instead of discarding it', async () => {
    const outboxPath = temporaryOutbox();
    const offline = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: offline.fetch });
    await client.onUserMessage(envelope, { messageId: 'rate-limited', content: 'Remember Vue.', brainId });

    const rateLimited = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: fakeFetch({ status: 429, body: { error: 'too_many_requests' } }).fetch,
    });

    await rateLimited.beforeTask({ ...beforeTask, envelope });
    assert.deepEqual(await rateLimited.outboxStatus(), { state: 'pending', pending: 1, retry: 1, discarded: 0 });
  });

  test('marks queued entries discarded when the daemon rejects them with 400 or 403', async () => {
    const outboxPath = temporaryOutbox();
    const queued = fakeFetch(
      { status: 503, body: { error: 'unavailable' } },
      { status: 503, body: { error: 'unavailable' } },
    );
    const client = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: queued.fetch });
    await client.onUserMessage(envelope, { messageId: 'message-1', content: 'Remember the first setting.', brainId });
    await client.onUserMessage(envelope, { messageId: 'message-2', content: 'Remember the second setting.', brainId });

    const rejecting = fakeFetch(
      { status: 400, body: { error: 'invalid_request' } },
      { status: 403, body: { error: 'forbidden' } },
      { status: 200, body: { context: context() } },
    );
    const flushingClient = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: rejecting.fetch });
    await flushingClient.beforeTask({ ...beforeTask, envelope });
    assert.deepEqual(await flushingClient.outboxStatus(), { state: 'discarded', pending: 0, retry: 0, discarded: 2 });
  });

  test('serializes an in-flight flush with a queued write from the same client', async () => {
    const outboxPath = temporaryOutbox();
    const seeding = fakeFetch({ status: 503, body: { error: 'unavailable' } });
    const seedClient = new AdapterClient({ daemonUrl: 'http://127.0.0.1:3849', token, outboxPath, fetch: seeding.fetch });
    await seedClient.onUserMessage(envelope, { messageId: 'message-old', content: 'Remember the old pending event.', brainId });

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

    const ending = client.beforeTask({ ...beforeTask, envelope });
    await oldRequestStarted.promise;
    const writing = client.onUserMessage(envelope, { messageId: 'message-new', content: 'Remember the new pending event.', brainId });
    releaseOldRequest.resolve();
    await ending;
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
    await seeding.onUserMessage(envelope, { messageId: 'old-turn', content: 'Remember Vue.', brainId });

    const oldRequestStarted = deferred();
    const releaseOldRequest = deferred();
    const flushing = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: async (input) => {
        if (new URL(String(input)).pathname === '/v1/context/resolve') {
          return new Response(JSON.stringify({ context: context() }), { status: 200 });
        }
        oldRequestStarted.resolve();
        await releaseOldRequest.promise;
        return new Response(JSON.stringify(savedCapture()), { status: 201 });
      },
    });
    const ending = flushing.beforeTask({ ...beforeTask, envelope });
    await oldRequestStarted.promise;

    const concurrent = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: fakeFetch({ status: 503, body: { error: 'unavailable' } }, { status: 503, body: { error: 'unavailable' } }).fetch,
    });
    const writing = concurrent.onUserMessage(envelope, { messageId: 'new-turn', content: 'Remember TypeScript.', brainId });
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
