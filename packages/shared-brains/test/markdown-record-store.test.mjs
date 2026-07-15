import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { createUuidV7 } from '@memlume/contracts';

import { MarkdownRecordStore } from '../dist/index.js';

const roots = [];

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop(), { recursive: true, force: true });
  }
});

async function createStore(options = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'memlume-records-'));
  roots.push(rootDir);
  return { rootDir, store: new MarkdownRecordStore({ rootDir, ...options }) };
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

describe('MarkdownRecordStore', () => {
  test('requires an absolute storage root', () => {
    assert.throws(() => new MarkdownRecordStore({ rootDir: 'relative/../memlume-records' }), /absolute/i);
  });

  test('writes canonical immutable records and round-trips them', async () => {
    const { rootDir, store } = await createStore();
    const record = semanticRecord();

    assert.deepEqual(store.append(record), record);
    assert.deepEqual(store.read(record.recordId), record);

    const [year] = record.createdAt.split('-');
    const month = record.createdAt.slice(5, 7);
    const path = join(rootDir, 'brains', record.brainId, 'records', year, month, `${record.recordId}.md`);
    const file = await readFile(path, 'utf8');
    assert.match(file, /^---\n\{"/);
    assert.match(file, /\n---\n<!-- memlume-sha256:[0-9a-f]{64} -->\n/);
    assert.equal(file.includes('rawContent'), false);
    assert.deepEqual(await readdir(join(rootDir, 'brains', record.brainId, 'records', year, month)), [
      `${record.recordId}.md`,
    ]);
  });

  test('is idempotent for the same canonical record and rejects conflicts without overwriting', async () => {
    const { rootDir, store } = await createStore();
    const record = semanticRecord();
    store.append(record);
    const path = join(rootDir, 'brains', record.brainId, 'records', '2026', '07', `${record.recordId}.md`);
    const before = await readFile(path);

    assert.deepEqual(store.append({ ...record, canonicalText: record.canonicalText }), record);
    assert.throws(() => store.append({ ...record, canonicalText: '另一個事實。' }), /record_conflict/i);
    assert.deepEqual(await readFile(path), before);
    assert.equal((await readdir(join(rootDir, 'brains', record.brainId, 'records', '2026', '07'))).some((name) => name.endsWith('.tmp')), false);
  });

  test('uses deterministic canonical JSON independent of input key order', async () => {
    const { store } = await createStore();
    const record = semanticRecord({ structuredData: { z: 'last', a: 'first' } });
    store.append(record);
    const reordered = {
      canonicalText: record.canonicalText,
      sourceAtom: record.sourceAtom,
      structuredData: { a: 'first', z: 'last' },
      atomKey: record.atomKey,
      captureId: record.captureId,
      updatedAt: record.updatedAt,
      createdAt: record.createdAt,
      kind: record.kind,
      status: record.status,
      brainId: record.brainId,
      memoryId: record.memoryId,
      recordId: record.recordId,
      recordType: record.recordType,
      schemaVersion: record.schemaVersion,
    };
    assert.deepEqual(store.append(reordered), record);
  });

  test('rejects unknown transcript fields and a target brain mismatch', async () => {
    const brainId = createUuidV7();
    const { store } = await createStore({ brainId });
    const record = semanticRecord({ brainId: createUuidV7() });
    assert.throws(() => store.append(record), /brain.*mismatch/i);
    assert.throws(() => store.append({ ...semanticRecord({ brainId }), transcript: 'full conversation' }), /invalid.*record|unknown/i);
  });

  test('detects tampering and does not auto-repair the record', async () => {
    const { rootDir, store } = await createStore();
    const record = semanticRecord();
    store.append(record);
    const path = join(rootDir, 'brains', record.brainId, 'records', '2026', '07', `${record.recordId}.md`);
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace('使用 Vue 開發前端。', '使用 React 開發前端。'));
    assert.throws(() => store.read(record.recordId), /checksum|integrity|corrupt/i);
    assert.equal(existsSync(path), true);
  });

  test('creates a minimal brain document only when missing', async () => {
    const { rootDir, store } = await createStore();
    const brainId = createUuidV7();
    const path = store.ensureBrainDocument(brainId, { name: 'Personal' });
    assert.equal(path, join(rootDir, 'brains', brainId, 'brain.md'));
    const original = readFileSync(path, 'utf8');
    assert.match(original, /Memlume Brain/);
    assert.equal(store.ensureBrainDocument(brainId, { name: 'Changed' }), path);
    assert.equal(readFileSync(path, 'utf8'), original);
  });

  test('lists records deterministically by UTC creation and record id', async () => {
    const { store } = await createStore();
    const brainId = createUuidV7();
    const later = semanticRecord({ brainId, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' });
    const earlier = semanticRecord({ brainId, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' });
    store.append(later);
    store.append(earlier);
    assert.deepEqual(store.list(brainId).map((record) => record.recordId), [earlier.recordId, later.recordId]);
  });

  test('rejects records copied into another Brain directory', async () => {
    const { rootDir, store } = await createStore();
    const sourceBrainId = '018f9d4e-7c2a-7b91-8dc0-61749dbcc030';
    const targetBrainId = '018f9d4e-7c2a-7b91-8dc0-61749dbcc020';
    const record = semanticRecord({ brainId: sourceBrainId });
    store.append(record);

    const sourcePath = join(rootDir, 'brains', sourceBrainId, 'records', '2026', '07', `${record.recordId}.md`);
    const targetDir = join(rootDir, 'brains', targetBrainId, 'records', '2026', '07');
    await mkdir(targetDir, { recursive: true });
    await copyFile(sourcePath, join(targetDir, `${record.recordId}.md`));

    assert.throws(() => store.list(targetBrainId), /brain.*mismatch|integrity|record_conflict/i);
    assert.throws(() => store.read(record.recordId), /brain.*mismatch|integrity|record_conflict/i);
  });

  test('rejects duplicate record ids across Brain directories without overwriting', async () => {
    const { rootDir, store } = await createStore();
    const firstBrainId = '018f9d4e-7c2a-7b91-8dc0-61749dbcc020';
    const secondBrainId = '018f9d4e-7c2a-7b91-8dc0-61749dbcc030';
    const record = semanticRecord({ brainId: firstBrainId });
    store.append(record);
    const duplicate = semanticRecord({ ...record, brainId: secondBrainId });

    assert.throws(() => store.append(duplicate), /record_conflict/i);
    assert.equal(
      existsSync(join(rootDir, 'brains', secondBrainId, 'records', '2026', '07', `${record.recordId}.md`)),
      false,
    );
  });

  test('rejects symlinked brain directories that escape the root', async (t) => {
    const { rootDir, store } = await createStore();
    const brainId = createUuidV7();
    const outside = await mkdtemp(join(tmpdir(), 'memlume-outside-'));
    roots.push(outside);
    try {
      symlinkSync(outside, join(rootDir, 'brains'), 'junction');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('symlinks are unavailable on this Windows environment');
        return;
      }
      throw error;
    }
    assert.throws(() => store.append(semanticRecord({ brainId })), /symlink|root|escape/i);
  });
});
