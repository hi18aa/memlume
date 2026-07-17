import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { openDatabase } from '@memlume/database/internal';

import { BrainStore, DocumentProjectNotReadyError, DocumentProposalConflictError, DocumentProjectStore } from '../dist/index.js';

const roots = [];
const databases = [];

afterEach(async () => {
  while (databases.length > 0) databases.pop().close();
  while (roots.length > 0) await rm(roots.pop(), { recursive: true, force: true });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'memlume-document-project-'));
  roots.push(root);
  const database = openDatabase(':memory:');
  databases.push(database);
  const brains = new BrainStore(database);
  const project = brains.createBrain({ kind: 'project', name: 'Docs' });
  const personal = brains.createBrain({ kind: 'personal', name: 'Personal' });
  const installation = brains.registerInstallation({ clientType: 'codex', installationId: 'desktop', profileId: 'default' });
  const store = new DocumentProjectStore(database);
  return { root, database, brains, project, personal, installation, store };
}

describe('DocumentProjectStore', () => {
  test('scans Markdown into immutable versions, sections, and FTS citations', async () => {
    const { root, project, store } = await setup();
    await mkdir(join(root, 'guide'), { recursive: true });
    await writeFile(join(root, 'guide', 'vue.md'), '---\npriority: 7\ntags: ["frontend"]\n---\n# Frontend\n\nUse Vue for the UI.\n\n## Tests\n\nRun pnpm test.', 'utf8');
    store.configure({ brainId: project.id, sourceRoot: root });

    const first = store.sync(project.id);
    assert.equal(first.documents, 1);
    assert.equal(first.sections, 2);
    const documents = store.listDocuments(project.id);
    assert.equal(documents[0].logicalPath, 'guide/vue.md');
    assert.equal(documents[0].status, 'active');
    assert.match(documents[0].sourceSha256, /^[0-9a-f]{64}$/u);

    const results = store.search({ brainIds: [project.id], query: 'Vue UI' });
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].headingPath, ['Frontend']);
    assert.equal(results[0].logicalPath, 'guide/vue.md');
    assert.equal(results[0].revisionId, first.revisionId);
    assert.match(results[0].sourceSha256, /^[0-9a-f]{64}$/u);
  });

  test('keeps source authoritative and marks removed files missing on the next sync', async () => {
    const { root, project, store } = await setup();
    await writeFile(join(root, 'old.md'), '# Old\n\nKeep this snapshot.', 'utf8');
    store.configure({ brainId: project.id, sourceRoot: root });
    const first = store.sync(project.id);
    await rm(join(root, 'old.md'));
    await writeFile(join(root, 'new.md'), '# New\n\nFresh content.', 'utf8');
    const second = store.sync(project.id);

    assert.notEqual(first.revisionId, second.revisionId);
    assert.deepEqual(store.listDocuments(project.id).map(({ logicalPath, status }) => [logicalPath, status]), [
      ['new.md', 'active'],
      ['old.md', 'missing'],
    ]);
    assert.deepEqual(store.search({ brainIds: [project.id], query: 'Keep snapshot' }), []);
    assert.equal(store.search({ brainIds: [project.id], query: 'Fresh content' }).length, 1);
  });

  test('requires a project Brain and enforces profile attachment budget and modes', async () => {
    const { root, project, personal, installation, brains, store } = await setup();
    await writeFile(join(root, 'core.md'), '# Core\n\nAlways visible project rule.', 'utf8');
    await writeFile(join(root, 'detail.md'), '# Detail\n\nOnly task-specific detail.', 'utf8');
    assert.throws(() => store.configure({ brainId: personal.id, sourceRoot: root }), /project Brain/i);
    store.configure({ brainId: project.id, sourceRoot: root });
    store.sync(project.id);
    brains.mountBrain({ brainId: project.id, agentInstallationId: installation.installation.id, access: 'read' });
    store.upsertBinding({
      agentInstallationId: installation.installation.id,
      brainId: project.id,
      mode: 'task_conditional',
      defaultDocumentPaths: ['detail.md'],
      maxContextBudget: 100,
    });
    const conditional = store.resolveForInstallation({
      agentInstallationId: installation.installation.id,
      query: 'task-specific detail',
      contextBudget: 100,
    });
    assert.equal(conditional.documents.length, 1);
    assert.equal(conditional.documents[0].logicalPath, 'detail.md');

    store.upsertBinding({
      agentInstallationId: installation.installation.id,
      brainId: project.id,
      mode: 'explicit_only',
      maxContextBudget: 1,
    });
    const explicit = store.resolveForInstallation({
      agentInstallationId: installation.installation.id,
      query: '',
      contextBudget: 100,
      explicitDocumentPaths: ['core.md'],
    });
    assert.equal(explicit.documents.length, 0);
    assert.equal(explicit.budget.truncated, true);
    assert.equal(explicit.budget.limitUnits, 1);
  });

  test('rejects unsafe source and document paths', async () => {
    const { root, project, installation, store } = await setup();
    assert.throws(() => store.configure({ brainId: project.id, sourceRoot: 'relative/docs' }), /absolute/i);
    store.configure({ brainId: project.id, sourceRoot: root });
    assert.throws(() => store.upsertBinding({
      agentInstallationId: installation.installation.id,
      brainId: project.id,
      mode: 'always_core',
      defaultDocumentPaths: ['../outside.md'],
    }), /inside|path/i);
  });

  test('requires reconciliation and keeps proposals out of reads until approved and applied', async () => {
    const { root, project, installation, brains, store } = await setup();
    await writeFile(join(root, 'profile.md'), '# Profile\n\nUses Vue.', 'utf8');
    store.configure({ brainId: project.id, sourceRoot: root });
    const synced = store.sync(project.id);
    brains.mountBrain({ brainId: project.id, agentInstallationId: installation.installation.id, access: 'propose' });
    const document = store.listDocuments(project.id)[0];
    const proposal = store.propose({
      agentInstallationId: installation.installation.id,
      brainId: project.id,
      logicalPath: document.logicalPath,
      proposedBody: '# Profile\n\nUses Vue and TypeScript.',
      baseRevisionId: synced.revisionId,
      baseSourceSha256: document.sourceSha256,
      reason: 'Keep the profile current.',
      evidence: { source: 'test' },
    });
    assert.equal(proposal.status, 'pending');
    assert.equal(store.search({ brainIds: [project.id], query: 'TypeScript' }).length, 0);
    brains.mountBrain({ brainId: project.id, agentInstallationId: installation.installation.id, access: 'read_write' });
    const approved = store.reviewProposal({ proposalId: proposal.id, reviewerId: installation.installation.id, decision: 'approve' });
    assert.equal(approved.status, 'approved');
    const applied = store.applyProposal({ proposalId: proposal.id, actorId: installation.installation.id });
    assert.equal(applied.status, 'applied');
    assert.match(await readFile(join(root, 'profile.md'), 'utf8'), /TypeScript/);
    assert.equal(store.search({ brainIds: [project.id], query: 'TypeScript' }).length, 1);
  });

  test('blocks stale proposals and source drift instead of returning stale context', async () => {
    const { root, project, installation, store } = await setup();
    await writeFile(join(root, 'drift.md'), '# Drift\n\nOriginal source.', 'utf8');
    store.configure({ brainId: project.id, sourceRoot: root });
    const synced = store.sync(project.id);
    const document = store.listDocuments(project.id)[0];
    await writeFile(join(root, 'drift.md'), '# Drift\n\nEdited outside Memlume.', 'utf8');
    assert.throws(() => store.search({ brainIds: [project.id], query: 'Original source' }), (error) => error instanceof DocumentProjectNotReadyError && error.state === 'drift');
    assert.throws(() => store.propose({
      agentInstallationId: installation.installation.id,
      brainId: project.id,
      logicalPath: document.logicalPath,
      proposedBody: '# Drift\n\nReplacement.',
      baseRevisionId: synced.revisionId,
      baseSourceSha256: document.sourceSha256,
      reason: 'stale',
    }), /not ready|drift/i);
    store.sync(project.id);
    assert.throws(() => store.propose({
      agentInstallationId: installation.installation.id,
      brainId: project.id,
      logicalPath: document.logicalPath,
      proposedBody: '# Drift\n\nReplacement.',
      baseRevisionId: synced.revisionId,
      baseSourceSha256: document.sourceSha256,
      reason: 'stale revision',
    }), (error) => error instanceof DocumentProposalConflictError);
  });
});
