import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHash } from 'node:crypto';
import { openDatabase } from '@memlume/database/internal';
import { createUuidV7 } from '@memlume/contracts';
import {
  MarkdownRecordStore,
  bootstrapLegacyMemories,
} from '../dist/index.js';

const fixtures = [];

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    fixture.database.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'memlume-legacy-bootstrap-'));
  const database = openDatabase(join(root, 'memlume.sqlite'));
  const fixture = { root, database };
  fixtures.push(fixture);
  return fixture;
}

function insertEvent(database, { id, brainId, rawContent, occurredAt }) {
  database.prepare(`
    INSERT INTO events (
      id, event_type, raw_content, structured_data, source_type, source_agent,
      source_reference, source_data, occurred_at, ingested_at, content_hash
    ) VALUES (?, 'user_statement', ?, ?, 'legacy', 'legacy', ?, ?, ?, ?, ?)
  `).run(
    id,
    rawContent,
    JSON.stringify({ source: 'legacy' }),
    `legacy:${id}`,
    JSON.stringify({ type: 'legacy', reference: `legacy:${id}` }),
    occurredAt,
    occurredAt,
    createHash('sha256').update(rawContent).digest('hex'),
  );
  database.prepare('INSERT INTO event_brains (event_id, brain_id, created_at) VALUES (?, ?, ?)').run(id, brainId, occurredAt);
}

function insertMemory(database, { id, brainId, sourceEventId, status = 'active', supersededBy = null }) {
  const now = '2026-07-15T12:00:00.000Z';
  database.prepare(`
    INSERT INTO memory_items (
      id, kind, title, canonical_text, structured_data, scope_data, status,
      priority, confidence, explicitness, source_event_id, created_at, updated_at,
      valid_from, valid_until, superseded_by
    ) VALUES (?, 'fact', NULL, ?, ?, ?, ?, 2, 0.8, 1, ?, ?, ?, NULL, NULL, ?)
  `).run(
    id,
    'Use Vue for the frontend.',
    JSON.stringify({ subject: 'frontend', predicate: 'framework', object: 'Vue', confidence: 0.8 }),
    JSON.stringify({ level: 'global' }),
    status,
    sourceEventId,
    now,
    now,
    supersededBy,
  );
  database.prepare('INSERT INTO memory_brains (memory_id, brain_id, created_at) VALUES (?, ?, ?)').run(id, brainId, now);
}

function insertVersion(database, { id, memoryId, version, text, createdAt }) {
  database.prepare(`
    INSERT INTO memory_versions (
      id, memory_id, version, canonical_text, structured_data, changed_by, change_reason, created_at
    ) VALUES (?, ?, ?, ?, ?, 'legacy', 'legacy import', ?)
  `).run(
    id,
    memoryId,
    version,
    text,
    JSON.stringify({ subject: 'frontend', predicate: 'framework', object: version === 1 ? 'React' : 'Vue', confidence: 0.8 }),
    createdAt,
  );
}

describe('legacy Markdown bootstrap', () => {
  test('exports memory versions, events, and a tombstone while preserving IDs and chains', () => {
    const { root, database } = createFixture();
    const brainId = '018f9d4e-7c20-7b91-8dc0-61749dbcc010';
    const eventId = '018f9d4e-7c20-7b91-8dc0-61749dbcc011';
    const memoryId = '018f9d4e-7c20-7b91-8dc0-61749dbcc012';
    const versionOneId = '018f9d4e-7c20-7b91-8dc0-61749dbcc014';
    const versionTwoId = '018f9d4e-7c20-7b91-8dc0-61749dbcc015';
    database.prepare("INSERT INTO brains (id, kind, name, created_at, updated_at) VALUES (?, 'project', 'Legacy Project', ?, ?)")
      .run(brainId, '2026-07-15T10:00:00.000Z', '2026-07-15T10:00:00.000Z');
    insertEvent(database, { id: eventId, brainId, rawContent: 'Legacy capture.', occurredAt: '2026-07-15T10:01:00.000Z' });
    insertMemory(database, { id: memoryId, brainId, sourceEventId: eventId, status: 'superseded' });
    insertVersion(database, { id: versionOneId, memoryId, version: 1, text: 'Use React for the frontend.', createdAt: '2026-07-15T10:02:00.000Z' });
    insertVersion(database, { id: versionTwoId, memoryId, version: 2, text: 'Use Vue for the frontend.', createdAt: '2026-07-15T10:03:00.000Z' });

    const result = bootstrapLegacyMemories({ database, dataRoot: root });
    const records = new MarkdownRecordStore({ rootDir: root }).list(brainId);
    const memoryRecords = records.filter((record) => record.memoryId === memoryId && record.recordType === 'semantic');
    const eventRecords = records.filter((record) => record.memoryId === eventId);
    const tombstones = records.filter((record) => record.recordType === 'tombstone');

    assert.equal(result.status, 'completed');
    assert.equal(memoryRecords.length, 2);
    assert.equal(memoryRecords[0].recordId, versionOneId);
    assert.equal(memoryRecords[1].recordId, versionTwoId);
    assert.equal(memoryRecords[1].supersedesRecordId, versionOneId);
    assert.equal(memoryRecords[1].memoryId, memoryId);
    assert.equal(eventRecords.length, 1);
    assert.equal(eventRecords[0].status, 'event_only');
    assert.equal(tombstones.length, 1);
    assert.equal(tombstones[0].memoryId, memoryId);
    assert.equal(tombstones[0].supersedesRecordId, versionTwoId);
  });

  test('is idempotent and retries after an injected append failure', () => {
    const { root, database } = createFixture();
    const brainId = '018f9d4e-7c20-7b91-8dc0-61749dbcc020';
    const memoryId = '018f9d4e-7c20-7b91-8dc0-61749dbcc021';
    database.prepare("INSERT INTO brains (id, kind, name, created_at, updated_at) VALUES (?, 'personal', 'Legacy Personal', ?, ?)")
      .run(brainId, '2026-07-15T10:00:00.000Z', '2026-07-15T10:00:00.000Z');
    insertMemory(database, { id: memoryId, brainId, sourceEventId: null });
    insertVersion(database, {
      id: '018f9d4e-7c20-7b91-8dc0-61749dbcc022',
      memoryId,
      version: 1,
      text: 'Use Vue for the frontend.',
      createdAt: '2026-07-15T10:02:00.000Z',
    });

    assert.throws(
      () => bootstrapLegacyMemories({ database, dataRoot: root, onPhase: (phase) => { if (phase === 'append' ) throw new Error('injected'); } }),
      /injected/,
    );
    const retried = bootstrapLegacyMemories({ database, dataRoot: root });
    const count = new MarkdownRecordStore({ rootDir: root }).list(brainId).length;
    const again = bootstrapLegacyMemories({ database, dataRoot: root });

    assert.equal(retried.status, 'completed');
    assert.equal(again.status, 'already_complete');
    assert.equal(count, 1);
  });

  test('does not invent a Brain for unbound legacy rows', () => {
    const { root, database } = createFixture();
    const memoryId = '018f9d4e-7c20-7b91-8dc0-61749dbcc030';
    const now = '2026-07-15T12:00:00.000Z';
    insertMemory(database, { id: memoryId, brainId: '00000000-0000-7000-8000-000000000001', sourceEventId: null });
    database.prepare('DELETE FROM memory_brains WHERE memory_id = ?').run(memoryId);
    const result = bootstrapLegacyMemories({ database, dataRoot: root });
    assert.equal(result.skippedUnbound, 1);
    assert.equal(new MarkdownRecordStore({ rootDir: root }).list().length, 0);
    assert.equal(database.prepare('SELECT 1 FROM memory_brains WHERE memory_id = ?').get(memoryId), undefined);
    assert.equal(now.length, 24);
  });
});
