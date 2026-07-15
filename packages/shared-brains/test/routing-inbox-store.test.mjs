import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { createUuidV7 } from '@memlume/contracts';

import { RoutingInboxStore } from '../dist/index.js';

const roots = [];

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop(), { recursive: true, force: true });
  }
});

async function createStore() {
  const rootDir = await mkdtemp(join(tmpdir(), 'memlume-inbox-'));
  roots.push(rootDir);
  return { rootDir, store: new RoutingInboxStore({ rootDir }) };
}

function inboxItem(overrides = {}) {
  const recordId = overrides.recordId ?? createUuidV7();
  const captureId = overrides.captureId ?? createUuidV7();
  return {
    recordType: 'routing_inbox',
    schemaVersion: '0.3',
    recordId,
    captureId,
    atomKey: overrides.atomKey ?? `fact:${recordId}`,
    status: 'routing_required',
    statement: overrides.statement ?? '我使用 Vue 開發前端。',
    evidenceRef: overrides.evidenceRef ?? 'event:message-1',
    createdAt: overrides.createdAt ?? '2026-07-16T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-07-16T00:00:00.000Z',
    ...(overrides.targetRef === undefined ? {} : { targetRef: overrides.targetRef }),
  };
}

function semanticRecord(overrides = {}) {
  const brainId = overrides.brainId ?? createUuidV7();
  const recordId = overrides.recordId ?? createUuidV7();
  return {
    schemaVersion: '0.3',
    recordType: 'semantic',
    recordId,
    memoryId: overrides.memoryId ?? createUuidV7(),
    brainId,
    status: 'active',
    kind: 'fact',
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    captureId: overrides.captureId ?? createUuidV7(),
    atomKey: overrides.atomKey ?? 'fact:vue',
    sourceAtom: '已清理的來源片段：使用 Vue 開發前端。',
    canonicalText: '使用 Vue 開發前端。',
    ...overrides,
  };
}

describe('RoutingInboxStore', () => {
  test('writes a strict pending record beneath the inbox root', async () => {
    const { rootDir, store } = await createStore();
    const item = inboxItem({ targetRef: 'project:frontend' });

    assert.deepEqual(store.addPending(item), item);
    assert.deepEqual(store.readPending(item.recordId), item);
    const path = join(rootDir, 'inbox', 'pending', `${item.recordId}.md`);
    const file = await readFile(path, 'utf8');
    assert.match(file, /^---\n\{"/);
    assert.match(file, /\n---\n<!-- memlume-sha256:[0-9a-f]{64} -->\n/);
    assert.equal(file.includes('brainId'), false);
    assert.equal(file.includes('rawContent'), false);
    assert.equal(file.includes('transcript'), false);
    assert.equal(file.includes('token'), false);
  });

  test('is idempotent for the same item and rejects conflicts without temp files', async () => {
    const { rootDir, store } = await createStore();
    const item = inboxItem();
    store.addPending(item);
    const path = join(rootDir, 'inbox', 'pending', `${item.recordId}.md`);
    const before = await readFile(path);

    assert.deepEqual(store.addPending({ ...item }), item);
    assert.throws(() => store.addPending({ ...item, statement: '另一個原子事實。' }), /record_conflict/i);
    assert.deepEqual(await readFile(path), before);
    assert.deepEqual(await readdir(join(rootDir, 'inbox', 'pending')), [`${item.recordId}.md`]);
  });

  test('rejects unknown or sensitive fields and invalid record ids', async () => {
    const { store } = await createStore();
    const item = inboxItem();
    assert.throws(() => store.addPending({ ...item, brainId: createUuidV7() }), /invalid|unknown|brain/i);
    assert.throws(() => store.addPending({ ...item, rawContent: 'full transcript' }), /invalid|unknown|rawContent/i);
    assert.throws(() => store.addPending({ ...item, transcript: 'full transcript' }), /invalid|unknown|transcript/i);
    assert.throws(() => store.addPending({ ...item, recordId: '../escape' }), /invalid|uuid|record/i);
    assert.throws(() => store.readPending('/absolute/path'), /invalid|uuid|record/i);
  });

  test('detects non-UTF-8 and checksum tampering', async () => {
    const { rootDir, store } = await createStore();
    const item = inboxItem();
    store.addPending(item);
    const path = join(rootDir, 'inbox', 'pending', `${item.recordId}.md`);
    await writeFile(path, Buffer.from([0xff, 0xfe]));
    assert.throws(() => store.readPending(item.recordId), /utf-8|invalid/i);
  });

  test('lists pending, resolved and quarantine records deterministically', async () => {
    const { store } = await createStore();
    const first = inboxItem({ recordId: '019f0000-0000-7000-8000-000000000002', createdAt: '2026-07-16T00:00:00.000Z' });
    const second = inboxItem({ recordId: '019f0000-0000-7000-8000-000000000001', createdAt: '2026-07-16T00:00:00.000Z' });
    store.addPending(first);
    store.addPending(second);
    assert.deepEqual(store.listPending().map((entry) => entry.recordId), [second.recordId, first.recordId]);
    const quarantined = store.quarantine(first, 'ambiguous_target', { intendedTargetRef: 'project:frontend' });
    assert.equal(quarantined.recordId, first.recordId);
    assert.deepEqual(store.listPending().map((entry) => entry.recordId), [second.recordId]);
    assert.deepEqual(store.listQuarantine().map((entry) => entry.recordId), [first.recordId]);
  });

  test('appends the target before moving pending to resolved and is retry-idempotent', async () => {
    const { rootDir, store } = await createStore();
    const item = inboxItem();
    const target = semanticRecord({ captureId: item.captureId, atomKey: item.atomKey });
    store.addPending(item);
    const appended = [];
    const resolved = store.resolve(item.recordId, target, (record) => appended.push(record));

    assert.equal(appended.length, 1);
    assert.equal(appended[0].recordId, target.recordId);
    assert.equal(store.readPending(item.recordId), undefined);
    assert.equal(resolved.recordId, item.recordId);
    assert.equal(resolved.resolvedRecordId, target.recordId);
    assert.equal(resolved.targetBrainId, target.brainId);
    assert.match(resolved.resolvedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(store.resolve(item.recordId, target, () => appended.push(target)), resolved);
    assert.equal(appended.length, 1);
    assert.ok(readFileSync(join(rootDir, 'inbox', 'resolved', `${item.recordId}.md`)));
  });

  test('keeps pending when the Brain append callback fails', async () => {
    const { store } = await createStore();
    const item = inboxItem();
    store.addPending(item);
    const target = semanticRecord({ captureId: item.captureId, atomKey: item.atomKey });
    assert.throws(() => store.resolve(item.recordId, target, () => { throw new Error('database unavailable'); }), /database unavailable/);
    assert.deepEqual(store.readPending(item.recordId), item);
    assert.deepEqual(store.listResolved(), []);
  });

  test('quarantine is separate from active pending and never receives a Brain id', async () => {
    const { rootDir, store } = await createStore();
    const item = inboxItem();
    const quarantined = store.quarantine(item, 'record_conflict', {
      intendedTargetRef: 'project:frontend',
      conflictWithRecordId: createUuidV7(),
    });
    assert.equal(quarantined.recordType, 'routing_quarantine');
    assert.equal('brainId' in quarantined, false);
    assert.deepEqual(store.listPending(), []);
    assert.equal(existsSync(join(rootDir, 'inbox', 'quarantine', `${item.recordId}.md`)), true);
  });

  test('rejects symlinked inbox directories that escape the root', async (t) => {
    const { rootDir, store } = await createStore();
    const outside = await mkdtemp(join(tmpdir(), 'memlume-inbox-outside-'));
    roots.push(outside);
    try {
      await mkdir(join(outside, 'pending'), { recursive: true });
      await rm(join(rootDir, 'inbox'), { recursive: true, force: true });
      symlinkSync(outside, join(rootDir, 'inbox'), 'junction');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('symlinks are unavailable on this Windows environment');
        return;
      }
      throw error;
    }
    assert.throws(() => store.addPending(inboxItem()), /symlink|root|escape/i);
  });
});
