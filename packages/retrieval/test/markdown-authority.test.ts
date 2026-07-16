import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createUuidV7 } from '@memlume/contracts';
import { openDatabase, type SqliteDatabase } from '@memlume/database/internal';
import { afterEach, describe, expect, test } from 'vitest';

import { MemoryStore, RecordProjector } from '../src/index.js';

const databases: SqliteDatabase[] = [];
const roots: string[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'memlume-authority-'));
  roots.push(root);
  const database = openDatabase(join(root, 'memlume.sqlite'));
  databases.push(database);
  const brainId = createUuidV7();
  database
    .prepare('INSERT INTO brains (id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(brainId, 'project', 'Memlume', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z');
  return { root, database, brainId };
}

function draft(brainId: string) {
  return {
    brainId,
    kind: 'fact' as const,
    canonicalText: '前端使用 Vue。',
    structuredData: { subject: 'frontend', predicate: 'framework', object: 'Vue', confidence: 1 },
    scope: { level: 'project' as const, projectId: 'memlume' },
    title: '前端技術棧',
    priority: 7,
    confidence: 0.8,
    explicitness: 1,
  };
}

describe('MemoryStore Markdown authority mode', () => {
  test('appends Markdown before projecting and restores metadata through reindex', () => {
    const { root, database, brainId } = fixture();
    const store = new MemoryStore(database, { markdownRoot: root });
    const memory = store.save(draft(brainId));

    const recordPath = join(root, 'brains', brainId, 'records', '2026', '07');
    expect(existsSync(recordPath)).toBe(true);
    expect(database.prepare('SELECT COUNT(*) AS count FROM record_projections').get()).toEqual({ count: 1 });
    expect(store.get(memory.id, [brainId])).toMatchObject({
      title: '前端技術棧',
      scope: { level: 'project', projectId: 'memlume' },
      priority: 7,
      confidence: 0.8,
      explicitness: 1,
    });

    const rebuilt = new RecordProjector(database).rebuild([]);
    expect(rebuilt).toEqual([]);
    expect(store.search('Vue', { brainIds: [brainId] })).toHaveLength(0);
    expect(store.get(memory.id, [brainId])?.status).not.toBe('active');
  });

  test('does not use the legacy SQLite mutation path when Markdown authority is configured', () => {
    const { root, database, brainId } = fixture();
    const store = new MemoryStore(database, { markdownRoot: root });
    const memory = store.save(draft(brainId));
    const projection = database
      .prepare('SELECT record_id FROM record_projections WHERE memory_id = ?')
      .get(memory.id) as { record_id: string } | undefined;

    expect(projection?.record_id).toBeTruthy();
    expect(database.prepare('SELECT source_type FROM events WHERE id = ?').get(projection!.record_id)).toEqual({ source_type: 'markdown' });
  });

  test('returns the existing authority memory when the same source event is retried', () => {
    const { root, database, brainId } = fixture();
    const sourceEventId = createUuidV7();
    database.prepare(`
      INSERT INTO events (
        id, event_type, raw_content, structured_data, source_type, source_agent, source_reference,
        source_data, occurred_at, ingested_at, processing_status, content_hash
      ) VALUES (?, 'user_message', ?, NULL, 'adapter', 'test', ?, '{}', ?, ?, 'processed', ?)
    `).run(
      sourceEventId,
      '使用 Vue 開發前端。',
      `capture:${sourceEventId}`,
      '2026-07-16T00:00:00.000Z',
      '2026-07-16T00:00:00.000Z',
      'd'.repeat(64),
    );
    database.prepare('INSERT INTO event_brains (event_id, brain_id, created_at) VALUES (?, ?, ?)')
      .run(sourceEventId, brainId, '2026-07-16T00:00:00.000Z');

    const store = new MemoryStore(database, { markdownRoot: root });
    const first = store.save({ ...draft(brainId), sourceEventId });
    const retry = store.save({ ...draft(brainId), sourceEventId });

    expect(retry.id).toBe(first.id);
    expect(database.prepare('SELECT COUNT(*) AS count FROM record_projections').get()).toEqual({ count: 1 });
    expect(store.list({ brainIds: [brainId], status: 'active' })).toHaveLength(1);
  });

  test('redacts secrets before authority persistence', () => {
    const { root, database, brainId } = fixture();
    const store = new MemoryStore(database, { markdownRoot: root });
    store.save({
      ...draft(brainId),
      canonicalText: 'password = do-not-store',
      structuredData: { subject: 'config', predicate: 'value', object: 'password = do-not-store', confidence: 1 },
    });

    const recordFile = readdirSync(join(root, 'brains', brainId, 'records', '2026', '07'))[0];
    const markdown = readFileSync(join(root, 'brains', brainId, 'records', '2026', '07', recordFile), 'utf8');
    expect(markdown).not.toContain('do-not-store');
    expect(database.prepare("SELECT COUNT(*) AS count FROM events WHERE raw_content LIKE '%do-not-store%'").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_items WHERE canonical_text LIKE '%do-not-store%'").get()).toEqual({ count: 0 });
  });
});
