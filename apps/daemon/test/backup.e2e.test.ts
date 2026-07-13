import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { startDaemon, type RunningDaemon } from '../src/index.js';

const SETUP_TOKEN = 'setup-token-for-backup-daemon-e2e';
const directories: string[] = [];
const daemons: RunningDaemon[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-daemon-backup-e2e-'));
  directories.push(directory);
  return join(directory, 'memlume.sqlite');
}

function setupHeaders(): HeadersInit {
  return { 'content-type': 'application/json', 'x-memlume-setup-token': SETUP_TOKEN };
}

function daemonUrl(daemon: RunningDaemon): string {
  return `http://127.0.0.1:${daemon.address.port}`;
}

async function requestJson(daemon: RunningDaemon, path: string, init?: RequestInit): Promise<{ readonly response: Response; readonly body: Record<string, unknown> }> {
  const response = await fetch(`${daemonUrl(daemon)}${path}`, init);
  return { response, body: (await response.json()) as Record<string, unknown> };
}

async function setupWriter(daemon: RunningDaemon): Promise<{ readonly brainId: string; readonly token: string }> {
  const brain = await requestJson(daemon, '/v1/setup/brains', {
    method: 'POST', headers: setupHeaders(), body: JSON.stringify({ kind: 'project', name: 'Backup project' }),
  });
  expect(brain.response.status).toBe(201);
  const brainId = (brain.body.brain as { readonly id: string }).id;
  const registration = await requestJson(daemon, '/v1/setup/installations', {
    method: 'POST', headers: setupHeaders(), body: JSON.stringify({ clientType: 'test', installationId: 'backup-writer', profileId: 'default' }),
  });
  expect(registration.response.status).toBe(201);
  const installationId = (registration.body.installation as { readonly id: string }).id;
  const mounted = await requestJson(daemon, '/v1/setup/mounts', {
    method: 'POST', headers: setupHeaders(), body: JSON.stringify({ brainId, agentInstallationId: installationId, access: 'read_write' }),
  });
  expect(mounted.response.status).toBe(201);
  return { brainId, token: registration.body.token as string };
}

async function saveFact(daemon: RunningDaemon, token: string, brainId: string, text: string): Promise<Response> {
  return fetch(`${daemonUrl(daemon)}/v1/memories`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      brainId,
      kind: 'fact',
      canonicalText: text,
      structuredData: { subject: 'backup', predicate: 'contains', object: text, confidence: 1 },
      scope: { level: 'project', projectId: 'backup-project' },
    }),
  });
}

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.stop();
  while (directories.length > 0) rmSync(directories.pop()!, { force: true, recursive: true });
});

describe('daemon backup maintenance lifecycle', () => {
  test('exports and restores a live daemon, then reopens it for safe reads and writes', async () => {
    const daemon = await startDaemon({ databasePath: databasePath(), port: 0, setupToken: SETUP_TOKEN });
    daemons.push(daemon);
    const writer = await setupWriter(daemon);
    expect((await saveFact(daemon, writer.token, writer.brainId, 'Snapshot fact.')).status).toBe(201);

    const exported = await fetch(`${daemonUrl(daemon)}/v1/setup/backups`, {
      method: 'POST', headers: setupHeaders(), body: JSON.stringify({ brainId: writer.brainId }),
    });
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-type')).toContain('application/vnd.memlume');
    const bundle = new Uint8Array(await exported.arrayBuffer());
    expect(bundle.byteLength).toBeGreaterThan(0);

    expect((await saveFact(daemon, writer.token, writer.brainId, 'Transient fact.')).status).toBe(201);
    const restored = await requestJson(daemon, '/v1/setup/backups/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.memlume', 'x-memlume-setup-token': SETUP_TOKEN },
      body: bundle,
    });
    expect(restored.response.status).toBe(200);
    expect(restored.body).toEqual({ status: 'restored' });

    const diagnostics = await requestJson(daemon, '/v1/setup/diagnostics', { headers: setupHeaders() });
    expect(diagnostics.response.status).toBe(200);
    expect(diagnostics.body).toMatchObject({ health: 'ok', integrity: 'ok', brains: [expect.objectContaining({ id: writer.brainId })] });
    expect(JSON.stringify(diagnostics.body)).not.toContain(writer.token);

    const oldToken = await fetch(`${daemonUrl(daemon)}/v1/memories/search?q=Snapshot`, { headers: { authorization: `Bearer ${writer.token}` } });
    expect(oldToken.status).toBe(401);

    const reopened = await setupWriterForExistingBrain(daemon, writer.brainId, 'after-restore');
    const snapshot = await requestJson(daemon, '/v1/memories/search?q=Snapshot', { headers: { authorization: `Bearer ${reopened.token}` } });
    expect(snapshot.response.status).toBe(200);
    expect(snapshot.body).toMatchObject({ memories: [expect.objectContaining({ canonicalText: 'Snapshot fact.' })] });
    const transient = await requestJson(daemon, '/v1/memories/search?q=Transient', { headers: { authorization: `Bearer ${reopened.token}` } });
    expect(transient.body).toEqual({ memories: [] });
    expect((await saveFact(daemon, reopened.token, writer.brainId, 'Fact after restore.')).status).toBe(201);
  });

  test('keeps the active daemon database usable when a restore bundle is invalid', async () => {
    const daemon = await startDaemon({ databasePath: databasePath(), port: 0, setupToken: SETUP_TOKEN });
    daemons.push(daemon);
    const writer = await setupWriter(daemon);
    expect((await saveFact(daemon, writer.token, writer.brainId, 'Fact before rejected restore.')).status).toBe(201);

    const rejected = await requestJson(daemon, '/v1/setup/backups/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.memlume', 'x-memlume-setup-token': SETUP_TOKEN },
      body: new Uint8Array([0, 1, 2, 3]),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body).toEqual({ error: 'invalid_backup' });
    const existing = await requestJson(daemon, '/v1/memories/search?q=rejected', { headers: { authorization: `Bearer ${writer.token}` } });
    expect(existing.response.status).toBe(200);
    expect(existing.body).toMatchObject({ memories: [expect.objectContaining({ canonicalText: 'Fact before rejected restore.' })] });
  });

  test('rejects new requests after an authenticated restore has been admitted but before its body completes', async () => {
    const daemon = await startDaemon({ databasePath: databasePath(), port: 0, setupToken: SETUP_TOKEN });
    daemons.push(daemon);
    const writer = await setupWriter(daemon);
    const exported = await fetch(`${daemonUrl(daemon)}/v1/setup/backups`, {
      method: 'POST', headers: setupHeaders(), body: JSON.stringify({ brainId: writer.brainId }),
    });
    const bundle = new Uint8Array(await exported.arrayBuffer());
    let release: (() => void) | undefined;
    const releaseBody = new Promise<void>((resolve) => { release = resolve; });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(bundle.subarray(0, 1));
        await releaseBody;
        controller.enqueue(bundle.subarray(1));
        controller.close();
      },
    });
    const restoring = fetch(`${daemonUrl(daemon)}/v1/setup/backups/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.memlume', 'x-memlume-setup-token': SETUP_TOKEN },
      body,
      duplex: 'half',
    } as RequestInit);

    try {
      await waitForRestoreGate(daemon);
      const blocked = await requestJson(daemon, '/v1/health');
      expect(blocked.response.status).toBe(503);
      expect(blocked.body).toEqual({ error: 'restore_in_progress' });
    } finally {
      release!();
    }
    expect((await restoring).status).toBe(200);
  });

  test('waits for an already-active write before closing and reopening the SQLite runtime', async () => {
    const daemon = await startDaemon({ databasePath: databasePath(), port: 0, setupToken: SETUP_TOKEN });
    daemons.push(daemon);
    const writer = await setupWriter(daemon);
    const exported = await fetch(`${daemonUrl(daemon)}/v1/setup/backups`, {
      method: 'POST', headers: setupHeaders(), body: JSON.stringify({ brainId: writer.brainId }),
    });
    const bundle = new Uint8Array(await exported.arrayBuffer());
    const eventBody = JSON.stringify({
      brainId: writer.brainId,
      rawContent: 'Write that started before restore.',
      eventType: 'test',
      source: { type: 'test', reference: 'pre-restore-inflight' },
    });
    let release: (() => void) | undefined;
    const releaseBody = new Promise<void>((resolve) => { release = resolve; });
    const writing = fetch(`${daemonUrl(daemon)}/v1/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${writer.token}`, 'content-type': 'application/json' },
      body: new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(eventBody.slice(0, -1)));
          await releaseBody;
          controller.enqueue(new TextEncoder().encode('}'));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const restoring = fetch(`${daemonUrl(daemon)}/v1/setup/backups/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.memlume', 'x-memlume-setup-token': SETUP_TOKEN },
      body: bundle,
    });

    try {
      const stillWaiting = await Promise.race([
        restoring.then(() => false),
        new Promise<true>((resolve) => setTimeout(() => resolve(true), 20)),
      ]);
      expect(stillWaiting).toBe(true);
    } finally {
      release!();
    }
    expect((await writing).status).toBe(201);
    expect((await restoring).status).toBe(200);
  });
});

async function setupWriterForExistingBrain(daemon: RunningDaemon, brainId: string, installationId: string): Promise<{ readonly token: string }> {
  const registration = await requestJson(daemon, '/v1/setup/installations', {
    method: 'POST', headers: setupHeaders(), body: JSON.stringify({ clientType: 'test', installationId, profileId: 'default' }),
  });
  expect(registration.response.status).toBe(201);
  const mounted = await requestJson(daemon, '/v1/setup/mounts', {
    method: 'POST',
    headers: setupHeaders(),
    body: JSON.stringify({ brainId, agentInstallationId: (registration.body.installation as { readonly id: string }).id, access: 'read_write' }),
  });
  expect(mounted.response.status).toBe(201);
  return { token: registration.body.token as string };
}

async function waitForRestoreGate(daemon: RunningDaemon): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${daemonUrl(daemon)}/v1/health`);
    if (response.status === 503) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Restore admission gate did not activate.');
}
