import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { startDaemon, type RunningDaemon } from '../src/index.js';

const SETUP_TOKEN = 'document-project-e2e-setup';
const daemons: RunningDaemon[] = [];
const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-document-e2e-'));
  directories.push(directory);
  return directory;
}

function url(daemon: RunningDaemon): string {
  return `http://127.0.0.1:${daemon.address.port}`;
}

async function json(daemon: RunningDaemon, path: string, init?: RequestInit): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${url(daemon)}${path}`, init);
  return { response, body: (await response.json()) as Record<string, unknown> };
}

function setupHeaders(): HeadersInit {
  return { 'content-type': 'application/json', 'x-memlume-setup-token': SETUP_TOKEN };
}

async function createBrain(daemon: RunningDaemon): Promise<string> {
  const result = await json(daemon, '/v1/setup/brains', {
    method: 'POST',
    headers: setupHeaders(),
    body: JSON.stringify({ kind: 'project', name: 'Documents' }),
  });
  expect(result.response.status).toBe(201);
  return (result.body.brain as { id: string }).id;
}

async function register(daemon: RunningDaemon): Promise<{ id: string; token: string }> {
  const result = await json(daemon, '/v1/setup/installations', {
    method: 'POST',
    headers: setupHeaders(),
    body: JSON.stringify({ clientType: 'codex', installationId: 'document-reader', profileId: 'default' }),
  });
  expect(result.response.status).toBe(201);
  return { id: (result.body.installation as { id: string }).id, token: result.body.token as string };
}

async function mount(daemon: RunningDaemon, agentInstallationId: string, brainId: string): Promise<void> {
  const result = await json(daemon, '/v1/setup/mounts', {
    method: 'POST',
    headers: setupHeaders(),
    body: JSON.stringify({ agentInstallationId, brainId, access: 'read' }),
  });
  expect(result.response.status).toBe(201);
}

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.stop();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('document project read-only integration', () => {
  test('configures, syncs, mounts, attaches, searches, and injects cited sections within budget', async () => {
    const sourceRoot = tempDirectory();
    writeFileSync(join(sourceRoot, 'architecture.md'), '# Architecture\n\nUse Markdown as authority.\n\n## Retrieval\n\nUse bounded FTS context.', 'utf8');
    const databasePath = join(tempDirectory(), 'memlume.sqlite');
    const daemon = await startDaemon({ databasePath, port: 0, setupToken: SETUP_TOKEN });
    daemons.push(daemon);
    const brainId = await createBrain(daemon);
    const installation = await register(daemon);
    await mount(daemon, installation.id, brainId);

    const configured = await json(daemon, `/v1/setup/document-projects/${brainId}`, {
      method: 'POST',
      headers: setupHeaders(),
      body: JSON.stringify({ sourceRoot }),
    });
    expect(configured.response.status).toBe(201);
    const synced = await json(daemon, `/v1/setup/document-projects/${brainId}/sync`, { method: 'POST', headers: setupHeaders(), body: '{}' });
    expect(synced.response.status).toBe(201);
    expect(synced.body.sync).toMatchObject({ documents: 1, sections: 2 });
    const attached = await json(daemon, `/v1/setup/installations/${installation.id}/document-bindings`, {
      method: 'POST',
      headers: setupHeaders(),
      body: JSON.stringify({ brainId, mode: 'task_conditional', defaultDocumentPaths: ['architecture.md'], maxContextBudget: 30 }),
    });
    expect(attached.response.status).toBe(201);

    const search = await json(daemon, '/v1/documents/search?q=bounded%20FTS', { headers: { authorization: `Bearer ${installation.token}` } });
    expect(search.response.status).toBe(200);
    expect(search.body.sections).toMatchObject([{ logicalPath: 'architecture.md', headingPath: ['Architecture', 'Retrieval'] }]);

    const context = await json(daemon, '/v1/context/resolve', {
      method: 'POST',
      headers: { authorization: `Bearer ${installation.token}`, 'content-type': 'application/json', 'x-memlume-callback': 'beforeTask', 'x-memlume-protocol-version': '1', 'x-memlume-adapter-version': '0.3.0' },
      body: JSON.stringify({ intent: 'implementation', scope: { level: 'global' }, task: 'bounded FTS context', contextBudget: 30 }),
    });
    expect(context.response.status).toBe(200);
    expect(context.body.context).toMatchObject({ documents: [{ logicalPath: 'architecture.md', headingPath: ['Architecture', 'Retrieval'] }] });
    expect((context.body.context as { explanation: { documentBudget: { usedUnits: number; limitUnits: number } } }).explanation.documentBudget.usedUnits).toBeLessThanOrEqual(30);
  });

  test('does not let an unmounted installation search or read the document project', async () => {
    const sourceRoot = tempDirectory();
    writeFileSync(join(sourceRoot, 'private.md'), '# Private\n\nDo not expose.', 'utf8');
    const daemon = await startDaemon({ databasePath: join(tempDirectory(), 'memlume.sqlite'), port: 0, setupToken: SETUP_TOKEN });
    daemons.push(daemon);
    const brainId = await createBrain(daemon);
    const owner = await register(daemon);
    const outsiderRegistration = await json(daemon, '/v1/setup/installations', {
      method: 'POST', headers: setupHeaders(), body: JSON.stringify({ clientType: 'hermes', installationId: 'outsider', profileId: 'default' }),
    });
    const outsider = { token: outsiderRegistration.body.token as string, id: (outsiderRegistration.body.installation as { id: string }).id };
    await mount(daemon, owner.id, brainId);
    await json(daemon, `/v1/setup/document-projects/${brainId}`, { method: 'POST', headers: setupHeaders(), body: JSON.stringify({ sourceRoot }) });
    await json(daemon, `/v1/setup/document-projects/${brainId}/sync`, { method: 'POST', headers: setupHeaders(), body: '{}' });
    const result = await json(daemon, '/v1/documents/search?q=private', { headers: { authorization: `Bearer ${outsider.token}` } });
    expect(result.response.status).toBe(403);
    expect(outsider.id).not.toBe(owner.id);
  });
});
