import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PERSONAL_BRAIN_ID, createUuidV7 } from '@memlume/contracts';
import { openDatabase } from '@memlume/database/internal';
import { afterEach, describe, expect, test } from 'vitest';

import { startDaemon, type RunningDaemon } from '../src/index.js';

const directories: string[] = [];
const daemons: RunningDaemon[] = [];
const SETUP_TOKEN = 'setup-token-for-server-tests';

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-daemon-'));
  directories.push(directory);
  return join(directory, 'memlume.sqlite');
}

async function requestJson(
  daemon: RunningDaemon,
  path: string,
  init?: RequestInit,
): Promise<{ readonly response: Response; readonly body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${daemon.address.port}${path}`, init);
  return { response, body: await response.json() };
}

async function startAdapterDaemon(): Promise<{ readonly daemon: RunningDaemon; readonly headers: HeadersInit; readonly databasePath: string }> {
  const databasePath = createDatabasePath();
  const daemon = await startDaemon({ databasePath, port: 0, setupToken: SETUP_TOKEN });
  daemons.push(daemon);
  const registration = await requestJson(daemon, '/v1/setup/installations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-memlume-setup-token': SETUP_TOKEN },
    body: JSON.stringify({ clientType: 'test', installationId: 'daemon', profileId: 'default' }),
  });
  expect(registration.response.status).toBe(201);
  const installationId = (registration.body as { readonly installation: { readonly id: string } }).installation.id;
  const mount = await requestJson(daemon, '/v1/setup/mounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-memlume-setup-token': SETUP_TOKEN },
    body: JSON.stringify({ brainId: DEFAULT_PERSONAL_BRAIN_ID, agentInstallationId: installationId, access: 'read_write' }),
  });
  expect(mount.response.status).toBe(201);
  return { daemon, headers: { authorization: `Bearer ${(registration.body as { readonly token: string }).token}` }, databasePath };
}

afterEach(async () => {
  while (daemons.length > 0) {
    await daemons.pop()!.stop();
  }
  while (directories.length > 0) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

describe('localhost daemon API', () => {
  test('captures a redacted audit event for a secret without persisting the secret', async () => {
    const { daemon, headers, databasePath } = await startAdapterDaemon();
    const secret = 'sk-live-never-persist-this';

    const capture = await requestJson(daemon, '/v1/memories/capture', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        rawContent: `remember API_KEY=${secret}`,
        eventType: 'user_statement',
        source: { type: 'test', reference: 'capture:secret' },
        scope: { level: 'global' },
      }),
    });

    expect(capture.response.status).toBe(200);
    expect(JSON.stringify(capture.body)).not.toContain(secret);
    const database = openDatabase(databasePath);
    try {
      const events = database.prepare('SELECT raw_content FROM events').all() as Array<{ readonly raw_content: string }>;
      expect(events).toEqual([{ raw_content: 'remember API_KEY=[redacted]' }]);
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(database.prepare('SELECT COUNT(*) AS count FROM memory_items').get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  test('captures natural memories, requires review for corrections, and exposes only mounted history', async () => {
    const { daemon, headers } = await startAdapterDaemon();
    const scope = { level: 'project', projectId: 'memlume' };

    const first = await requestJson(daemon, '/v1/memories/capture', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        rawContent: 'remember this project uses pnpm',
        eventType: 'user_statement',
        source: { type: 'test', agent: 'daemon-test', reference: 'capture:pnpm' },
        scope,
      }),
    });
    expect(first.response.status).toBe(201);
    expect(first.body).toMatchObject({
      capture: {
        status: 'active',
        brain: DEFAULT_PERSONAL_BRAIN_ID,
        scope,
        requiresConfirmation: false,
        source: { eventId: expect.any(String) },
      },
    });
    const oldMemoryId = (first.body as { readonly capture: { readonly memoryId: string } }).capture.memoryId;

    const duplicate = await requestJson(daemon, '/v1/memories/capture', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        rawContent: 'Remember this   project uses pnpm.',
        eventType: 'user_statement',
        source: { type: 'test', agent: 'daemon-test', reference: 'capture:pnpm:retry' },
        scope,
      }),
    });
    expect(duplicate.response.status).toBe(200);
    expect(duplicate.body).toMatchObject({ capture: { memoryId: oldMemoryId, status: 'active' } });

    const correction = await requestJson(daemon, '/v1/memories/capture', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        rawContent: 'remember this project uses npm',
        eventType: 'user_statement',
        source: { type: 'test', agent: 'daemon-test', reference: 'capture:npm' },
        scope,
      }),
    });
    expect(correction.response.status).toBe(201);
    expect(correction.body).toMatchObject({
      capture: { status: 'candidate', requiresConfirmation: true, source: { eventId: expect.any(String) } },
    });
    const candidateId = (correction.body as { readonly capture: { readonly memoryId: string } }).capture.memoryId;

    const candidates = await requestJson(daemon, '/v1/memories/candidates', { headers });
    expect(candidates.response.status).toBe(200);
    expect(candidates.body).toMatchObject({ memories: [expect.objectContaining({ id: candidateId, status: 'candidate' })] });

    const approved = await requestJson(daemon, `/v1/memories/${candidateId}/approve`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'test-user',
        reason: 'The user corrected the package manager.',
        supersedeMemoryId: oldMemoryId,
      }),
    });
    expect(approved.response.status).toBe(200);
    expect(approved.body).toMatchObject({ memory: { id: candidateId, status: 'active' } });

    const history = await requestJson(daemon, `/v1/memories/${oldMemoryId}/history`, { headers });
    expect(history.response.status).toBe(200);
    expect(history.body).toMatchObject({
      memories: [
        expect.objectContaining({ id: oldMemoryId, status: 'superseded', supersededBy: candidateId }),
        expect.objectContaining({ id: candidateId, status: 'active' }),
      ],
    });
  });

  test('promotes an exact candidate when the user explicitly confirms it', async () => {
    const { daemon, headers, databasePath } = await startAdapterDaemon();
    const scope = { level: 'project', projectId: 'memlume' };
    const candidate = await requestJson(daemon, '/v1/memories/capture', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        rawContent: 'This project uses pnpm.',
        eventType: 'user_statement',
        source: { type: 'test', reference: 'capture:candidate-pnpm' },
        scope,
      }),
    });
    const memoryId = (candidate.body as { readonly capture: { readonly memoryId: string } }).capture.memoryId;

    const confirmed = await requestJson(daemon, '/v1/memories/capture', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        rawContent: 'remember this project uses pnpm.',
        eventType: 'user_statement',
        source: { type: 'test', reference: 'capture:confirmed-pnpm' },
        scope,
      }),
    });

    expect(confirmed.response.status).toBe(200);
    expect(confirmed.body).toMatchObject({ capture: { memoryId, status: 'active', requiresConfirmation: false } });
    const candidates = await requestJson(daemon, '/v1/memories/candidates', { headers });
    expect(candidates.body).toEqual({ memories: [] });
    const database = openDatabase(databasePath);
    try {
      expect(database.prepare('SELECT canonical_text, changed_by, change_reason FROM memory_versions WHERE memory_id = ?').all(memoryId)).toEqual([
        {
          canonical_text: 'This project uses pnpm',
          changed_by: 'memlume',
          change_reason: 'Explicit user request confirms pending candidate.',
        },
      ]);
    } finally {
      database.close();
    }
  });

  test('rejects duplicate candidate approval without creating a second active memory', async () => {
    const { daemon, headers } = await startAdapterDaemon();
    const scope = { level: 'project', projectId: 'memlume' };
    const candidate = await requestJson(daemon, '/v1/memories/capture', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        rawContent: 'This project uses pnpm.',
        eventType: 'user_statement',
        source: { type: 'test', reference: 'capture:duplicate-candidate' },
        scope,
      }),
    });
    const candidateId = (candidate.body as { readonly capture: { readonly memoryId: string } }).capture.memoryId;
    const active = await requestJson(daemon, '/v1/memories', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'fact',
        canonicalText: 'This project uses pnpm',
        structuredData: { subject: 'project', predicate: 'package_manager', object: 'pnpm', confidence: 1 },
        scope,
      }),
    });
    expect(active.response.status).toBe(201);

    const approved = await requestJson(daemon, `/v1/memories/${candidateId}/approve`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test-user', reason: 'Approve the duplicated candidate.' }),
    });

    expect(approved.response.status).toBe(409);
    expect(approved.body).toEqual({ error: 'active_duplicate' });
    const search = await requestJson(daemon, '/v1/memories/search?q=pnpm', { headers });
    expect((search.body as { readonly memories: Array<{ readonly status: string }> }).memories.filter(({ status }) => status === 'active')).toHaveLength(1);
  });

  test('rejects supercession when review is not required and makes review actions idempotent', async () => {
    const { daemon, headers } = await startAdapterDaemon();
    const scope = { level: 'project', projectId: 'memlume' };
    const unrelated = await requestJson(daemon, '/v1/memories', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'fact',
        canonicalText: 'The user lives in Taipei.',
        structuredData: { subject: 'user', predicate: 'location', object: 'Taipei', confidence: 1 },
        scope,
      }),
    });
    const unrelatedId = (unrelated.body as { readonly memory: { readonly id: string } }).memory.id;
    const candidate = await requestJson(daemon, '/v1/memories/capture', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        rawContent: 'This project uses pnpm.',
        eventType: 'user_statement',
        source: { type: 'test', reference: 'capture:non-review' },
        scope,
      }),
    });
    const candidateId = (candidate.body as { readonly capture: { readonly memoryId: string } }).capture.memoryId;

    const invalidSupersede = await requestJson(daemon, `/v1/memories/${candidateId}/approve`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test-user', reason: 'This needs no replacement.', supersedeMemoryId: unrelatedId }),
    });
    expect(invalidSupersede.response.status).toBe(400);
    expect(invalidSupersede.body).toEqual({ error: 'invalid_supersede' });

    const approved = await requestJson(daemon, `/v1/memories/${candidateId}/approve`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test-user', reason: 'Approve the candidate.' }),
    });
    expect(approved.response.status).toBe(200);
    const repeatedApproval = await requestJson(daemon, `/v1/memories/${candidateId}/approve`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test-user', reason: 'Repeat approval.' }),
    });
    expect(repeatedApproval.response.status).toBe(409);
    expect(repeatedApproval.body).toEqual({ error: 'candidate_not_pending' });

    const rejected = await requestJson(daemon, '/v1/memories/capture', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        rawContent: 'This project uses bun.',
        eventType: 'user_statement',
        source: { type: 'test', reference: 'capture:reject-idempotent' },
        scope,
      }),
    });
    const rejectedId = (rejected.body as { readonly capture: { readonly memoryId: string } }).capture.memoryId;
    const firstReject = await requestJson(daemon, `/v1/memories/${rejectedId}/reject`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test-user', reason: 'Reject this inference.' }),
    });
    expect(firstReject.response.status).toBe(200);
    const repeatedReject = await requestJson(daemon, `/v1/memories/${rejectedId}/reject`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test-user', reason: 'Repeat rejection.' }),
    });
    expect(repeatedReject.response.status).toBe(409);
    expect(repeatedReject.body).toEqual({ error: 'candidate_not_pending' });
  });

  test('serves health only over 127.0.0.1 and closes its resources', async () => {
    const daemon = await startDaemon({ databasePath: createDatabasePath(), port: 0 });
    daemons.push(daemon);

    expect(daemon.address.address).toBe('127.0.0.1');

    const { response, body } = await requestJson(daemon, '/v1/health');
    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'ok' });
  });

  test('records events and saves searchable facts through the same daemon store', async () => {
    const { daemon, headers } = await startAdapterDaemon();

    const event = await requestJson(daemon, '/v1/events', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        rawContent: 'Use local SQLite for the first release.',
        eventType: 'decision',
        source: { type: 'test', agent: 'daemon-test', reference: 'daemon:event:1' },
      }),
    });
    expect(event.response.status).toBe(201);
    expect(event.body).toMatchObject({ event: { eventType: 'decision' } });

    const fact = await requestJson(daemon, '/v1/memories', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'fact',
        title: 'Memlume storage',
        canonicalText: 'Memlume uses SQLite FTS5 for the first release.',
        structuredData: {
          subject: 'Memlume',
          predicate: 'uses',
          object: 'SQLite FTS5',
          confidence: 1,
        },
        scope: { level: 'global' },
      }),
    });
    expect(fact.response.status).toBe(201);
    expect(fact.body).toMatchObject({ memory: { kind: 'fact', title: 'Memlume storage' } });

    const search = await requestJson(daemon, '/v1/memories/search?q=SQLite', { headers });
    expect(search.response.status).toBe(200);
    expect(search.body).toMatchObject({
      memories: [expect.objectContaining({ kind: 'fact', canonicalText: expect.stringContaining('SQLite FTS5') })],
    });
  });

  test('resolves a stored policy as a directive', async () => {
    const { daemon, headers } = await startAdapterDaemon();

    const policy = await requestJson(daemon, '/v1/memories', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'policy',
        canonicalText: 'Use the local image route.',
        structuredData: {
          trigger: { intents: ['image_generation'] },
          action: { type: 'route_tool', target: 'local-image-route' },
          constraints: { required: true },
        },
        scope: { level: 'global' },
      }),
    });
    expect(policy.response.status).toBe(201);

    const context = await requestJson(daemon, '/v1/context/resolve', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        intent: 'image_generation',
        scope: { level: 'global' },
        task: null,
        contextBudget: 100,
      }),
    });
    expect(context.response.status).toBe(200);
    expect(context.body).toMatchObject({
      context: {
        directives: [expect.objectContaining({ text: 'Use the local image route.', actionTarget: 'local-image-route' })],
      },
    });
  });

  test('returns safe errors for invalid input and unknown routes', async () => {
    const { daemon, headers } = await startAdapterDaemon();

    const invalid = await requestJson(daemon, '/v1/events', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ rawContent: 'Missing source.', eventType: 'test' }),
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'invalid_request' });

    const missing = await requestJson(daemon, '/v1/not-a-route');
    expect(missing.response.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found' });
  });

  test('returns a safe 400 for an unknown source event UUID', async () => {
    const { daemon, headers } = await startAdapterDaemon();

    const invalid = await requestJson(daemon, '/v1/memories', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'fact',
        canonicalText: 'This fact points to an event that does not exist.',
        structuredData: {
          subject: 'fact',
          predicate: 'references',
          object: 'missing-event',
          confidence: 1,
        },
        scope: { level: 'global' },
        sourceEventId: createUuidV7(),
      }),
    });

    expect(invalid.response.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'invalid_request' });
  });

  test('returns a safe 413 for oversized and 400 for malformed JSON bodies', async () => {
    const daemon = await startDaemon({ databasePath: createDatabasePath(), port: 0 });
    daemons.push(daemon);

    const tooLarge = await requestJson(daemon, '/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rawContent: 'x'.repeat(1024 * 1024), eventType: 'test', source: { type: 'test' } }),
    });
    expect(tooLarge.response.status).toBe(413);
    expect(tooLarge.body).toEqual({ error: 'payload_too_large' });

    const malformed = await requestJson(daemon, '/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad JSON',
    });
    expect(malformed.response.status).toBe(400);
    expect(malformed.body).toEqual({ error: 'invalid_request' });
  });
});
