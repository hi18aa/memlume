import { mkdtempSync, rmSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PERSONAL_BRAIN_ID } from '@memlume/contracts';
import { openDatabase } from '@memlume/database/internal';
import { afterEach, describe, expect, test } from 'vitest';

import { startDaemon, type RunningDaemon } from '../src/index.js';

const directories: string[] = [];
const daemons: RunningDaemon[] = [];
const SETUP_TOKEN = 'setup-token-for-daemon-auth-tests';

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-daemon-auth-'));
  directories.push(directory);
  return join(directory, 'memlume.sqlite');
}

async function start(options: { readonly setupToken?: string } = {}): Promise<RunningDaemon> {
  return startAt(createDatabasePath(), options);
}

async function startAt(databasePath: string, options: { readonly setupToken?: string } = {}): Promise<RunningDaemon> {
  const daemon = await startDaemon({ databasePath, port: 0, ...options });
  daemons.push(daemon);
  return daemon;
}

async function requestJson(
  daemon: RunningDaemon,
  path: string,
  init?: RequestInit,
): Promise<{ readonly response: Response; readonly body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${daemon.address.port}${path}`, init);
  return { response, body: (await response.json()) as Record<string, unknown> };
}

function setupHeaders(token = SETUP_TOKEN): HeadersInit {
  return { 'content-type': 'application/json', 'x-memlume-setup-token': token };
}

function adapterHeaders(token?: string): HeadersInit {
  return {
    'content-type': 'application/json',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  };
}

async function registerInstallation(
  daemon: RunningDaemon,
  installationId = 'desktop',
  clientType = 'test',
): Promise<{ readonly id: string; readonly token: string }> {
  const registration = await requestJson(daemon, '/v1/setup/installations', {
    method: 'POST',
    headers: setupHeaders(),
    body: JSON.stringify({ clientType, installationId, profileId: 'default' }),
  });
  expect(registration.response.status).toBe(201);
  const installation = registration.body.installation as { readonly id: string };
  const token = registration.body.token;
  expect(typeof installation.id).toBe('string');
  expect(typeof token).toBe('string');
  return { id: installation.id, token: token as string };
}

async function createBrain(daemon: RunningDaemon, name: string, kind: 'personal' | 'project' = 'project'): Promise<string> {
  const created = await requestJson(daemon, '/v1/setup/brains', {
    method: 'POST',
    headers: setupHeaders(),
    body: JSON.stringify({ kind, name }),
  });
  expect(created.response.status).toBe(201);
  return (created.body.brain as { readonly id: string }).id;
}

async function mountBrain(
  daemon: RunningDaemon,
  agentInstallationId: string,
  brainId: string,
  access: 'read' | 'read_write',
): Promise<void> {
  const mounted = await requestJson(daemon, '/v1/setup/mounts', {
    method: 'POST',
    headers: setupHeaders(),
    body: JSON.stringify({ agentInstallationId, brainId, access }),
  });
  expect(mounted.response.status).toBe(201);
}

async function savePolicy(daemon: RunningDaemon, token: string, brainId: string, text: string): Promise<void> {
  const saved = await requestJson(daemon, '/v1/memories', {
    method: 'POST',
    headers: adapterHeaders(token),
    body: JSON.stringify({
      brainId,
      kind: 'policy',
      canonicalText: text,
      structuredData: {
        trigger: { intents: ['context_test'] },
        action: { type: 'apply_process', target: text },
        constraints: {},
      },
      scope: { level: 'global' },
    }),
  });
  expect(saved.response.status).toBe(201);
}

async function resolveContext(daemon: RunningDaemon, token: string): Promise<Record<string, unknown>> {
  const resolved = await requestJson(daemon, '/v1/context/resolve', {
    method: 'POST',
    headers: adapterHeaders(token),
    body: JSON.stringify({ intent: 'context_test', scope: { level: 'global' }, task: null, contextBudget: 100 }),
  });
  expect(resolved.response.status).toBe(200);
  return resolved.body.context as Record<string, unknown>;
}

afterEach(async () => {
  while (daemons.length > 0) {
    await daemons.pop()!.stop();
  }
  while (directories.length > 0) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

describe('daemon local authentication and setup API', () => {
  test('keeps direct structured writes from supported agents as candidates without user confirmation', async () => {
    const databasePath = createDatabasePath();
    const daemon = await startAt(databasePath, { setupToken: SETUP_TOKEN });
    const installation = await registerInstallation(daemon, 'governed-agent', 'codex');
    await mountBrain(daemon, installation.id, DEFAULT_PERSONAL_BRAIN_ID, 'read_write');
    const body = {
      brainId: DEFAULT_PERSONAL_BRAIN_ID,
      kind: 'fact',
      canonicalText: 'A direct agent write requires review.',
      structuredData: { subject: 'write', predicate: 'requires', object: 'review', confidence: 1 },
      scope: { level: 'global' },
    };
    const candidate = await requestJson(daemon, '/v1/memories', {
      method: 'POST',
      headers: adapterHeaders(installation.token),
      body: JSON.stringify(body),
    });
    expect(candidate.response.status).toBe(201);
    expect(candidate.body).toMatchObject({ memory: { status: 'candidate' } });

    const confirmationAt = new Date().toISOString();
    const confirmation = createHmac('sha256', SETUP_TOKEN).update(JSON.stringify({
      body: {
        brainId: body.brainId,
        canonicalText: body.canonicalText,
        kind: body.kind,
        scope: body.scope,
        structuredData: { confidence: 1, object: 'review', predicate: 'requires', subject: 'write' },
      },
      issuedAt: confirmationAt,
    })).digest('hex');
    const confirmed = await requestJson(daemon, '/v1/memories', {
      method: 'POST',
      headers: { ...adapterHeaders(installation.token), 'x-memlume-user-confirmation': confirmation, 'x-memlume-user-confirmation-at': confirmationAt },
      body: JSON.stringify(body),
    });
    expect(confirmed.response.status).toBe(201);
    expect(confirmed.body).toMatchObject({ memory: { status: 'active' } });

    await daemon.stop();
    daemons.splice(daemons.indexOf(daemon), 1);
    const restarted = await startAt(databasePath, { setupToken: SETUP_TOKEN });
    const replay = await requestJson(restarted, '/v1/memories', {
      method: 'POST',
      headers: { ...adapterHeaders(installation.token), 'x-memlume-user-confirmation': confirmation, 'x-memlume-user-confirmation-at': confirmationAt },
      body: JSON.stringify(body),
    });
    expect(replay.response.status).toBe(201);
    expect(replay.body).toMatchObject({ memory: { status: 'candidate' } });
  });
  test('keeps health public even when a setup token is configured', async () => {
    const daemon = await start({ setupToken: SETUP_TOKEN });

    const health = await requestJson(daemon, '/v1/health');
    expect(health.response.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok', service: 'memlume' });
  });

  test('does not enable setup routes when no setup token was configured', async () => {
    const daemon = await start();

    const response = await requestJson(daemon, '/v1/setup/brains', {
      method: 'POST',
      headers: setupHeaders(),
      body: JSON.stringify({ kind: 'personal', name: 'Personal' }),
    });
    expect(response.response.status).toBe(503);
    expect(response.body).toEqual({ error: 'setup_unavailable' });
    expect(JSON.stringify(response.body)).not.toContain(SETUP_TOKEN);
  });

  test('rejects an invalid setup token without echoing it', async () => {
    const daemon = await start({ setupToken: SETUP_TOKEN });
    const invalidToken = 'not-the-configured-setup-token';

    const response = await requestJson(daemon, '/v1/setup/brains', {
      method: 'POST',
      headers: setupHeaders(invalidToken),
      body: JSON.stringify({ kind: 'personal', name: 'Personal' }),
    });
    expect(response.response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
    expect(JSON.stringify(response.body)).not.toContain(invalidToken);
  });

  test('creates and lists brains through the setup token', async () => {
    const daemon = await start({ setupToken: SETUP_TOKEN });

    const created = await requestJson(daemon, '/v1/setup/brains', {
      method: 'POST',
      headers: setupHeaders(),
      body: JSON.stringify({ kind: 'project', name: 'Memlume' }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({ brain: { kind: 'project', name: 'Memlume' } });

    const listed = await requestJson(daemon, '/v1/setup/brains', { headers: setupHeaders() });
    expect(listed.response.status).toBe(200);
    expect(listed.body.brains).toContainEqual(expect.objectContaining({ id: (created.body.brain as { id: string }).id }));
  });

  test('registers, mounts, lists, and rotates one installation without exposing token hashes', async () => {
    const daemon = await start({ setupToken: SETUP_TOKEN });
    const brain = await requestJson(daemon, '/v1/setup/brains', {
      method: 'POST',
      headers: setupHeaders(),
      body: JSON.stringify({ kind: 'project', name: 'Memlume' }),
    });
    const registration = await requestJson(daemon, '/v1/setup/installations', {
      method: 'POST',
      headers: setupHeaders(),
      body: JSON.stringify({ clientType: 'codex', installationId: 'desktop', profileId: 'default', displayName: 'Codex Desktop' }),
    });
    expect(registration.response.status).toBe(201);
    expect(registration.body).toMatchObject({ installation: { clientType: 'codex', displayName: 'Codex Desktop' }, token: expect.any(String) });
    expect(Object.keys(registration.body)).toEqual(['installation', 'token']);
    expect(JSON.stringify(registration.body)).not.toMatch(/token_hash|revoked_at/i);

    const installation = registration.body.installation as { readonly id: string };
    const createdBrain = brain.body.brain as { readonly id: string };
    const mounted = await requestJson(daemon, '/v1/setup/mounts', {
      method: 'POST',
      headers: setupHeaders(),
      body: JSON.stringify({ brainId: createdBrain.id, agentInstallationId: installation.id, access: 'read_write' }),
    });
    expect(mounted.response.status).toBe(201);
    expect(mounted.body).toEqual({ mount: { brainId: createdBrain.id, agentInstallationId: installation.id, access: 'read_write' } });

    const listed = await requestJson(daemon, `/v1/setup/installations/${installation.id}/brains`, { headers: setupHeaders() });
    expect(listed.response.status).toBe(200);
    expect(listed.body).toEqual({ brains: [{ brain: expect.objectContaining({ id: createdBrain.id }), access: 'read_write' }] });

    const rotated = await requestJson(daemon, `/v1/setup/installations/${installation.id}/token/rotate`, {
      method: 'POST',
      headers: setupHeaders(),
    });
    expect(rotated.response.status).toBe(201);
    expect(Object.keys(rotated.body)).toEqual(['token']);
    expect(rotated.body.token).toEqual(expect.any(String));
    expect(rotated.body.token).not.toBe(registration.body.token);
  });

  test('requires a bearer token for existing adapter routes and accepts a current token', async () => {
    const daemon = await start({ setupToken: SETUP_TOKEN });
    const registration = await registerInstallation(daemon);

    const absent = await requestJson(daemon, '/v1/context/resolve', {
      method: 'POST',
      headers: adapterHeaders(),
      body: JSON.stringify({ intent: 'test', scope: { level: 'global' }, task: null, contextBudget: 10 }),
    });
    expect(absent.response.status).toBe(401);
    expect(absent.body).toEqual({ error: 'unauthorized' });

    const eventWithoutBearer = await requestJson(daemon, '/v1/events', {
      method: 'POST',
      headers: adapterHeaders(),
      body: JSON.stringify({ rawContent: 'No token.', eventType: 'test', source: { type: 'test' } }),
    });
    expect(eventWithoutBearer.response.status).toBe(401);
    expect(eventWithoutBearer.body).toEqual({ error: 'unauthorized' });

    const memoryWithoutBearer = await requestJson(daemon, '/v1/memories', {
      method: 'POST',
      headers: adapterHeaders(),
      body: JSON.stringify({
        kind: 'fact',
        canonicalText: 'No token memory.',
        structuredData: { subject: 'test', predicate: 'has', object: 'no token', confidence: 1 },
        scope: { level: 'global' },
      }),
    });
    expect(memoryWithoutBearer.response.status).toBe(401);
    expect(memoryWithoutBearer.body).toEqual({ error: 'unauthorized' });

    await mountBrain(daemon, registration.id, DEFAULT_PERSONAL_BRAIN_ID, 'read');

    const valid = await requestJson(daemon, '/v1/context/resolve', {
      method: 'POST',
      headers: adapterHeaders(registration.token),
      body: JSON.stringify({ intent: 'test', scope: { level: 'global' }, task: null, contextBudget: 10 }),
    });
    expect(valid.response.status).toBe(200);
    expect(valid.body).toMatchObject({ context: { intent: 'test' } });
  });

  test('does not accept revoked or unknown bearer tokens and never echoes them', async () => {
    const daemon = await start({ setupToken: SETUP_TOKEN });
    const registration = await registerInstallation(daemon);
    const unknownToken = 'unknown-adapter-token';

    const unknown = await requestJson(daemon, '/v1/memories/search?q=memory', { headers: adapterHeaders(unknownToken) });
    expect(unknown.response.status).toBe(401);
    expect(unknown.body).toEqual({ error: 'unauthorized' });
    expect(JSON.stringify(unknown.body)).not.toContain(unknownToken);

    const rotated = await requestJson(daemon, `/v1/setup/installations/${registration.id}/token/rotate`, {
      method: 'POST',
      headers: setupHeaders(),
    });
    expect(rotated.response.status).toBe(201);

    const revoked = await requestJson(daemon, '/v1/memories/search?q=memory', { headers: adapterHeaders(registration.token) });
    expect(revoked.response.status).toBe(401);
    expect(revoked.body).toEqual({ error: 'unauthorized' });
    expect(JSON.stringify(revoked.body)).not.toContain(registration.token);
  });

  test('does not accept a caller-supplied installation identity on adapter routes', async () => {
    const daemon = await start({ setupToken: SETUP_TOKEN });
    const registration = await registerInstallation(daemon);

    const response = await requestJson(
      daemon,
      `/v1/memories/search?q=memory&installationId=${encodeURIComponent('another-agent-installation')}`,
      { headers: adapterHeaders(registration.token) },
    );
    expect(response.response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_request' });
  });

  test('rejects mounted writes without an explicit brainId and persists nothing', async () => {
    const databasePath = createDatabasePath();
    const daemon = await startAt(databasePath, { setupToken: SETUP_TOKEN });
    const installation = await registerInstallation(daemon);
    await mountBrain(daemon, installation.id, DEFAULT_PERSONAL_BRAIN_ID, 'read_write');

    const event = await requestJson(daemon, '/v1/events', {
      method: 'POST',
      headers: adapterHeaders(installation.token),
      body: JSON.stringify({ rawContent: 'Default brain event.', eventType: 'test', source: { type: 'test' } }),
    });
    expect(event.response.status).toBe(400);
    expect(event.body).toEqual({ error: 'invalid_request' });

    const memory = await requestJson(daemon, '/v1/memories', {
      method: 'POST',
      headers: adapterHeaders(installation.token),
      body: JSON.stringify({
        kind: 'fact',
        canonicalText: 'Default brain memory.',
        structuredData: { subject: 'memory', predicate: 'belongs_to', object: 'personal', confidence: 1 },
        scope: { level: 'global' },
      }),
    });
    expect(memory.response.status).toBe(400);
    expect(memory.body).toEqual({ error: 'invalid_request' });

    const candidate = await requestJson(daemon, '/v1/memories/candidate', {
      method: 'POST',
      headers: adapterHeaders(installation.token),
      body: JSON.stringify({
        kind: 'fact',
        canonicalText: 'Missing brain candidate.',
        structuredData: { subject: 'memory', predicate: 'requires', object: 'brain', confidence: 1 },
        scope: { level: 'global' },
      }),
    });
    expect(candidate.response.status).toBe(400);
    expect(candidate.body).toEqual({ error: 'invalid_request' });

    const database = openDatabase(databasePath);
    try {
      expect(database.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 0 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM memory_items').get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  test('rejects writes for an unmounted or read-only brain without an internal error', async () => {
    const daemon = await start({ setupToken: SETUP_TOKEN });
    const installation = await registerInstallation(daemon);

    const unmountedEvent = await requestJson(daemon, '/v1/events', {
      method: 'POST',
      headers: adapterHeaders(installation.token),
      body: JSON.stringify({ brainId: DEFAULT_PERSONAL_BRAIN_ID, rawContent: 'Must not be stored.', eventType: 'test', source: { type: 'test' } }),
    });
    expect(unmountedEvent.response.status).toBe(403);
    expect(unmountedEvent.body).toEqual({ error: 'forbidden' });

    await mountBrain(daemon, installation.id, DEFAULT_PERSONAL_BRAIN_ID, 'read');
    const readOnlyMemory = await requestJson(daemon, '/v1/memories', {
      method: 'POST',
      headers: adapterHeaders(installation.token),
      body: JSON.stringify({
        brainId: DEFAULT_PERSONAL_BRAIN_ID,
        kind: 'fact',
        canonicalText: 'Must not be stored either.',
        structuredData: { subject: 'memory', predicate: 'write_access', object: 'denied', confidence: 1 },
        scope: { level: 'global' },
      }),
    });
    expect(readOnlyMemory.response.status).toBe(403);
    expect(readOnlyMemory.body).toEqual({ error: 'forbidden' });
  });

  test('keeps candidate review and history inside the authenticated installation mounts', async () => {
    const daemon = await start({ setupToken: SETUP_TOKEN });
    const writer = await registerInstallation(daemon, 'candidate-writer');
    const reader = await registerInstallation(daemon, 'candidate-reader');
    await mountBrain(daemon, writer.id, DEFAULT_PERSONAL_BRAIN_ID, 'read_write');

    const captured = await requestJson(daemon, '/v1/memories/capture', {
      method: 'POST',
      headers: adapterHeaders(writer.token),
      body: JSON.stringify({
        brainId: DEFAULT_PERSONAL_BRAIN_ID,
        rawContent: 'This project uses pnpm.',
        eventType: 'user_statement',
        source: { type: 'test', reference: 'candidate-isolation' },
        scope: { level: 'project', projectId: 'memlume' },
      }),
    });
    expect(captured.response.status).toBe(201);
    const memoryId = ((captured.body.capture as { readonly memoryId: string })).memoryId;

    const unmountedCandidates = await requestJson(daemon, '/v1/memories/candidates', { headers: adapterHeaders(reader.token) });
    expect(unmountedCandidates.response.status).toBe(403);
    expect(unmountedCandidates.body).toEqual({ error: 'forbidden' });
    const unmountedHistory = await requestJson(daemon, `/v1/memories/${memoryId}/history`, { headers: adapterHeaders(reader.token) });
    expect(unmountedHistory.response.status).toBe(404);
    const unmountedReject = await requestJson(daemon, `/v1/memories/${memoryId}/reject`, {
      method: 'POST',
      headers: { ...adapterHeaders(reader.token), 'x-memlume-setup-token': SETUP_TOKEN },
      body: JSON.stringify({ actor: 'reader', reason: 'Must not inspect another brain.' }),
    });
    expect(unmountedReject.response.status).toBe(404);

    const adapterOnlyReview = await requestJson(daemon, `/v1/memories/${memoryId}/reject`, {
      method: 'POST',
      headers: adapterHeaders(writer.token),
      body: JSON.stringify({ actor: 'writer', reason: 'Adapter tokens cannot review candidates.' }),
    });
    expect(adapterOnlyReview.response.status).toBe(401);

    await mountBrain(daemon, reader.id, DEFAULT_PERSONAL_BRAIN_ID, 'read');
    const mountedCandidates = await requestJson(daemon, '/v1/memories/candidates', { headers: adapterHeaders(reader.token) });
    expect(mountedCandidates.body).toMatchObject({ memories: [expect.objectContaining({ id: memoryId, status: 'candidate' })] });
    const readOnlyReject = await requestJson(daemon, `/v1/memories/${memoryId}/reject`, {
      method: 'POST',
      headers: { ...adapterHeaders(reader.token), 'x-memlume-setup-token': SETUP_TOKEN },
      body: JSON.stringify({ actor: 'reader', reason: 'Read access cannot review.' }),
    });
    expect(readOnlyReject.response.status).toBe(403);
  });

  test('writes and searches only the authenticated installation mounted brains', async () => {
    const daemon = await start({ setupToken: SETUP_TOKEN });
    const projectBrainId = await createBrain(daemon, 'Shared Project');
    const writer = await registerInstallation(daemon, 'writer');
    const isolatedReader = await registerInstallation(daemon, 'isolated-reader');
    await mountBrain(daemon, writer.id, projectBrainId, 'read_write');

    const event = await requestJson(daemon, '/v1/events', {
      method: 'POST',
      headers: adapterHeaders(writer.token),
      body: JSON.stringify({
        brainId: projectBrainId,
        rawContent: 'Project brain event.',
        eventType: 'test',
        source: { type: 'test', reference: 'project-brain-event' },
      }),
    });
    expect(event.response.status).toBe(201);
    expect(event.body).toMatchObject({ event: { brainId: projectBrainId } });

    const saved = await requestJson(daemon, '/v1/memories', {
      method: 'POST',
      headers: adapterHeaders(writer.token),
      body: JSON.stringify({
        brainId: projectBrainId,
        kind: 'fact',
        canonicalText: 'Memlume project uses pnpm.',
        structuredData: { subject: 'Memlume', predicate: 'uses', object: 'pnpm', confidence: 1 },
        scope: { level: 'project', projectId: 'memlume' },
      }),
    });
    expect(saved.response.status).toBe(201);
    expect(saved.body).toMatchObject({ memory: { brainId: projectBrainId } });

    const writerSearch = await requestJson(daemon, '/v1/memories/search?q=pnpm', {
      headers: adapterHeaders(writer.token),
    });
    expect(writerSearch.response.status).toBe(200);
    expect(writerSearch.body).toMatchObject({ memories: [expect.objectContaining({ canonicalText: 'Memlume project uses pnpm.' })] });

    const isolatedSearch = await requestJson(daemon, '/v1/memories/search?q=pnpm', {
      headers: adapterHeaders(isolatedReader.token),
    });
    expect(isolatedSearch.response.status).toBe(403);
    expect(isolatedSearch.body).toEqual({ error: 'forbidden' });
  });

  test('rejects direct context resolution for an authenticated installation with no mounts', async () => {
    const daemon = await start({ setupToken: SETUP_TOKEN });
    const writer = await registerInstallation(daemon, 'personal-writer');
    const noMountReader = await registerInstallation(daemon, 'no-mount-reader');
    await mountBrain(daemon, writer.id, DEFAULT_PERSONAL_BRAIN_ID, 'read_write');
    await savePolicy(daemon, writer.token, DEFAULT_PERSONAL_BRAIN_ID, 'Personal directive must stay private.');

    const context = await requestJson(daemon, '/v1/context/resolve', {
      method: 'POST',
      headers: adapterHeaders(noMountReader.token),
      body: JSON.stringify({ intent: 'context_test', scope: { level: 'global' }, task: null, contextBudget: 100 }),
    });
    expect(context.response.status).toBe(403);
    expect(context.body).toEqual({ error: 'forbidden' });
  });

  test('resolves only a project mounted brain and excludes personal and domain brains', async () => {
    const daemon = await start({ setupToken: SETUP_TOKEN });
    const projectBrainId = await createBrain(daemon, 'Project');
    const domainBrainId = await createBrain(daemon, 'Domain', 'project');
    const writer = await registerInstallation(daemon, 'all-brains-writer');
    const projectReader = await registerInstallation(daemon, 'project-reader');
    await mountBrain(daemon, writer.id, DEFAULT_PERSONAL_BRAIN_ID, 'read_write');
    await mountBrain(daemon, writer.id, projectBrainId, 'read_write');
    await mountBrain(daemon, writer.id, domainBrainId, 'read_write');
    await mountBrain(daemon, projectReader.id, projectBrainId, 'read');
    await savePolicy(daemon, writer.token, DEFAULT_PERSONAL_BRAIN_ID, 'Personal directive.');
    await savePolicy(daemon, writer.token, projectBrainId, 'Project directive.');
    await savePolicy(daemon, writer.token, domainBrainId, 'Domain directive.');

    const context = await resolveContext(daemon, projectReader.token);
    expect((context.directives as Array<{ text: string }>).map(({ text }) => text)).toEqual(['Project directive.']);
  });

  test('orders mounted context brains as project, domain, then personal', async () => {
    const daemon = await start({ setupToken: SETUP_TOKEN });
    const projectBrainId = await createBrain(daemon, 'Project');
    const domainBrainId = await createBrain(daemon, 'Domain', 'project');
    const installation = await registerInstallation(daemon, 'ordered-reader');
    await mountBrain(daemon, installation.id, DEFAULT_PERSONAL_BRAIN_ID, 'read_write');
    await mountBrain(daemon, installation.id, domainBrainId, 'read_write');
    await mountBrain(daemon, installation.id, projectBrainId, 'read_write');
    await savePolicy(daemon, installation.token, DEFAULT_PERSONAL_BRAIN_ID, 'Personal directive.');
    await savePolicy(daemon, installation.token, domainBrainId, 'Domain directive.');
    await savePolicy(daemon, installation.token, projectBrainId, 'Project directive.');

    const context = await resolveContext(daemon, installation.token);
    expect((context.directives as Array<{ text: string }>).map(({ text }) => text)).toEqual([
      'Project directive.',
      'Domain directive.',
      'Personal directive.',
    ]);
  });

  test('keeps event retries inside one brain and rejects cross-brain event and source references safely', async () => {
    const daemon = await start({ setupToken: SETUP_TOKEN });
    const firstBrainId = await createBrain(daemon, 'First Brain');
    const secondBrainId = await createBrain(daemon, 'Second Brain');
    const firstAgent = await registerInstallation(daemon, 'first-agent');
    const secondAgent = await registerInstallation(daemon, 'second-agent');
    await mountBrain(daemon, firstAgent.id, firstBrainId, 'read_write');
    await mountBrain(daemon, secondAgent.id, secondBrainId, 'read_write');
    const rawContent = 'First brain private event content.';
    const eventInput = {
      brainId: firstBrainId,
      rawContent,
      eventType: 'test',
      source: { type: 'test', reference: 'shared-event-reference' },
    };

    const firstEvent = await requestJson(daemon, '/v1/events', {
      method: 'POST',
      headers: adapterHeaders(firstAgent.token),
      body: JSON.stringify(eventInput),
    });
    expect(firstEvent.response.status).toBe(201);
    const firstEventId = (firstEvent.body.event as { readonly id: string }).id;

    const retried = await requestJson(daemon, '/v1/events', {
      method: 'POST',
      headers: adapterHeaders(firstAgent.token),
      body: JSON.stringify(eventInput),
    });
    expect(retried.response.status).toBe(201);
    expect((retried.body.event as { readonly id: string }).id).toBe(firstEventId);

    const crossBrainEvent = await requestJson(daemon, '/v1/events', {
      method: 'POST',
      headers: adapterHeaders(secondAgent.token),
      body: JSON.stringify({ ...eventInput, brainId: secondBrainId }),
    });
    expect(crossBrainEvent.response.status).toBe(409);
    expect(crossBrainEvent.body).toEqual({ error: 'event_brain_conflict' });
    const conflictBody = JSON.stringify(crossBrainEvent.body);
    expect(conflictBody).not.toContain(rawContent);
    expect(conflictBody).not.toContain(firstBrainId);
    expect(conflictBody).not.toContain(secondBrainId);
    expect(conflictBody).not.toContain(firstEventId);

    const mismatchedMemory = await requestJson(daemon, '/v1/memories', {
      method: 'POST',
      headers: adapterHeaders(secondAgent.token),
      body: JSON.stringify({
        brainId: secondBrainId,
        kind: 'fact',
        canonicalText: 'Cross brain event memory must not be stored.',
        structuredData: { subject: 'memory', predicate: 'references', object: 'other brain event', confidence: 1 },
        scope: { level: 'global' },
        sourceEventId: firstEventId,
      }),
    });
    expect(mismatchedMemory.response.status).toBe(400);
    expect(mismatchedMemory.body).toEqual({ error: 'invalid_request' });
    expect(JSON.stringify(mismatchedMemory.body)).not.toContain(firstEventId);

    const secondBrainSearch = await requestJson(daemon, '/v1/memories/search?q=cross', {
      headers: adapterHeaders(secondAgent.token),
    });
    expect(secondBrainSearch.response.status).toBe(200);
    expect(secondBrainSearch.body).toEqual({ memories: [] });
  });
});
