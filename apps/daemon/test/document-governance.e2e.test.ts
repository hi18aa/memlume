import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { startDaemon, type RunningDaemon } from '../src/index.js';

const SETUP_TOKEN = 'document-governance-setup';
const daemons: RunningDaemon[] = [];
const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-document-governance-'));
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

async function register(daemon: RunningDaemon, installationId: string): Promise<{ id: string; token: string }> {
  const result = await json(daemon, '/v1/setup/installations', {
    method: 'POST', headers: setupHeaders(),
    body: JSON.stringify({ clientType: 'codex', installationId, profileId: 'default' }),
  });
  expect(result.response.status).toBe(201);
  return { id: (result.body.installation as { id: string }).id, token: result.body.token as string };
}

async function createProject(daemon: RunningDaemon): Promise<string> {
  const result = await json(daemon, '/v1/setup/brains', {
    method: 'POST', headers: setupHeaders(), body: JSON.stringify({ kind: 'project', name: 'Governed docs' }),
  });
  expect(result.response.status).toBe(201);
  return (result.body.brain as { id: string }).id;
}

async function mount(daemon: RunningDaemon, installationId: string, brainId: string, access: 'read' | 'propose' | 'read_write'): Promise<void> {
  const result = await json(daemon, '/v1/setup/mounts', {
    method: 'POST', headers: setupHeaders(), body: JSON.stringify({ agentInstallationId: installationId, brainId, access }),
  });
  expect(result.response.status).toBe(201);
}

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.stop();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('document project governance', () => {
  test('shares a proposal across agents while keeping review/apply write-gated', async () => {
    const sourceRoot = tempDirectory();
    writeFileSync(join(sourceRoot, 'profile.md'), '# Profile\n\nUses Vue.', 'utf8');
    const daemon = await startDaemon({ databasePath: join(tempDirectory(), 'memlume.sqlite'), port: 0, setupToken: SETUP_TOKEN });
    daemons.push(daemon);
    const brainId = await createProject(daemon);
    const proposer = await register(daemon, 'proposer');
    const reviewer = await register(daemon, 'reviewer');
    await mount(daemon, proposer.id, brainId, 'propose');
    await mount(daemon, reviewer.id, brainId, 'read_write');
    expect((await json(daemon, `/v1/setup/document-projects/${brainId}`, { method: 'POST', headers: setupHeaders(), body: JSON.stringify({ sourceRoot }) })).response.status).toBe(201);
    expect((await json(daemon, `/v1/setup/document-projects/${brainId}/sync`, { method: 'POST', headers: setupHeaders(), body: '{}' })).response.status).toBe(201);
    const listing = await json(daemon, `/v1/setup/document-projects/${brainId}/documents`, { headers: setupHeaders() });
    const document = (listing.body.documents as Array<{ logicalPath: string; sourceSha256: string; revisionId: string }>)[0];
    const proposal = await json(daemon, '/v1/documents/proposals', {
      method: 'POST',
      headers: { authorization: `Bearer ${proposer.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ brainId, logicalPath: document.logicalPath, proposedBody: '# Profile\n\nUses Vue and TypeScript.', baseRevisionId: document.revisionId, baseSourceSha256: document.sourceSha256, reason: 'Keep profile current.' }),
    });
    expect(proposal.response.status).toBe(201);
    const proposalId = (proposal.body.proposal as { id: string }).id;
    const proposerReview = await json(daemon, `/v1/documents/proposals/${proposalId}/review`, {
      method: 'POST', headers: { authorization: `Bearer ${proposer.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }),
    });
    expect(proposerReview.response.status).toBe(403);
    const approved = await json(daemon, `/v1/documents/proposals/${proposalId}/review`, {
      method: 'POST', headers: { authorization: `Bearer ${reviewer.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }),
    });
    expect(approved.response.status).toBe(200);
    const applied = await json(daemon, `/v1/documents/proposals/${proposalId}/apply`, {
      method: 'POST', headers: { authorization: `Bearer ${reviewer.token}` },
    });
    expect(applied.response.status).toBe(200);
    const search = await json(daemon, '/v1/documents/search?q=TypeScript', { headers: { authorization: `Bearer ${proposer.token}` } });
    expect(search.response.status).toBe(200);
    expect(search.body.sections).toMatchObject([{ logicalPath: 'profile.md' }]);
  });

  test('reports source drift and restores reads only after an explicit sync', async () => {
    const sourceRoot = tempDirectory();
    writeFileSync(join(sourceRoot, 'drift.md'), '# Drift\n\nOriginal.', 'utf8');
    const daemon = await startDaemon({ databasePath: join(tempDirectory(), 'memlume.sqlite'), port: 0, setupToken: SETUP_TOKEN });
    daemons.push(daemon);
    const brainId = await createProject(daemon);
    const reader = await register(daemon, 'reader');
    await mount(daemon, reader.id, brainId, 'read');
    await json(daemon, `/v1/setup/document-projects/${brainId}`, { method: 'POST', headers: setupHeaders(), body: JSON.stringify({ sourceRoot }) });
    await json(daemon, `/v1/setup/document-projects/${brainId}/sync`, { method: 'POST', headers: setupHeaders(), body: '{}' });
    writeFileSync(join(sourceRoot, 'drift.md'), '# Drift\n\nEdited outside Memlume.', 'utf8');
    const blocked = await json(daemon, '/v1/documents/search?q=Original', { headers: { authorization: `Bearer ${reader.token}` } });
    expect(blocked.response.status).toBe(409);
    expect(blocked.body).toMatchObject({ error: 'document_project_not_ready', state: 'drift' });
    await json(daemon, `/v1/setup/document-projects/${brainId}/sync`, { method: 'POST', headers: setupHeaders(), body: '{}' });
    const restored = await json(daemon, '/v1/documents/search?q=Edited', { headers: { authorization: `Bearer ${reader.token}` } });
    expect(restored.response.status).toBe(200);
    expect(restored.body.sections).toMatchObject([{ logicalPath: 'drift.md' }]);
  });
});
