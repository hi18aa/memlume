import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { DEFAULT_PERSONAL_BRAIN_ID } from '@memlume/contracts';
import * as publicDatabase from '../../database/src/index.js';
import { initialMigration, migrations, openDatabase } from '../../database/src/internal.js';
import { EventBrainConflictError, EventJournal } from '../src/index.js';

const databases: ReturnType<typeof openDatabase>[] = [];
const temporaryDirectories: string[] = [];

function createJournal() {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-event-journal-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, 'memlume.sqlite'));
  databases.push(database);

  return { database, filename: join(directory, 'memlume.sqlite'), journal: new EventJournal(database) };
}

function createBrain(database: ReturnType<typeof openDatabase>, id: string): void {
  database
    .prepare(`
      INSERT INTO brains (id, kind, name, created_at, updated_at)
      VALUES (?, 'project', ?, '2026-07-12T15:00:00.000Z', '2026-07-12T15:00:00.000Z')
    `)
    .run(id, `Test ${id}`);
}

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { force: true, recursive: true });
  }
});

describe('SQLite migration', () => {
  test('keeps raw SQLite access and rollback helpers out of the database root entry', () => {
    expect(publicDatabase).not.toHaveProperty('openDatabase');
    expect(publicDatabase).not.toHaveProperty('initialMigration');
  });

  test('creates the core tables with WAL settings and supports down then up', () => {
    const { database, filename } = createJournal();
    initialMigration.up(database);
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' OR type = 'virtual table'")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'events',
        'memory_items',
        'memory_versions',
        'memory_relations',
        'memory_usage',
        'outcomes',
        'conflicts',
        'tool_registry',
        'memory_search',
      ]),
    );
    expect(String(database.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(database.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(database.pragma('synchronous', { simple: true })).toBe(1);

    initialMigration.down(database);
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").get(),
    ).toBeUndefined();

    initialMigration.up(database);
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").get(),
    ).toMatchObject({ name: 'events' });

    expect(
      database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_content_hash'").get(),
    ).toMatchObject({ sql: expect.stringContaining('WHERE source_reference IS NOT NULL') });

    database.close();
    databases.pop();
    const upgraded = openDatabase(filename);
    databases.push(upgraded);
    expect(upgraded.prepare('SELECT id FROM schema_migrations ORDER BY id').all()).toEqual(
      migrations.map(({ id }) => ({ id })),
    );

    upgraded.exec(`
      DROP TABLE schema_migrations;
      DROP INDEX idx_events_content_hash;
      CREATE UNIQUE INDEX idx_events_content_hash
        ON events(content_hash, COALESCE(source_reference, ''));
    `);
    upgraded.close();
    databases.pop();
    const legacyUpgrade = openDatabase(filename);
    databases.push(legacyUpgrade);
    expect(legacyUpgrade.prepare('SELECT id FROM schema_migrations ORDER BY id').all()).toEqual(
      migrations.map(({ id }) => ({ id })),
    );
    expect(
      legacyUpgrade
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_content_hash'")
        .get(),
    ).toMatchObject({ sql: expect.stringContaining('WHERE source_reference IS NOT NULL') });
  });
});

describe('EventJournal', () => {
  test('appends a schema-validated event and reads it back', () => {
    const { database, journal } = createJournal();
    const event = journal.append({
      rawContent: '  我不喜歡亂花錢。  ',
      eventType: 'user_statement',
      occurredAt: '2026-07-12T15:00:00.000Z',
      source: {
        type: 'cli',
        agent: 'codex-cli',
        conversationId: 'conversation-1',
        messageId: 'message-1',
        reference: 'conversation:1/message:1',
      },
      structuredData: { categories: ['preference'] },
    });

    expect(event).toMatchObject({
      eventType: 'user_statement',
      rawContent: '  我不喜歡亂花錢。  ',
      occurredAt: '2026-07-12T15:00:00.000Z',
      source: { reference: 'conversation:1/message:1', conversationId: 'conversation-1' },
      brainId: DEFAULT_PERSONAL_BRAIN_ID,
    });
    expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(journal.getById(event.id)).toEqual(event);
    expect(journal.findBySourceReference('conversation:1/message:1')).toEqual([event]);
    expect(journal.searchContent('亂花錢')).toEqual([event]);
    expect(
      database.prepare('SELECT content_hash FROM events WHERE id = ?').get(event.id),
    ).toEqual({ content_hash: createHash('sha256').update(event.rawContent).digest('hex') });
    expect(database.prepare('SELECT brain_id FROM event_brains WHERE event_id = ?').get(event.id)).toEqual({
      brain_id: DEFAULT_PERSONAL_BRAIN_ID,
    });
  });

  test('keeps a retried event in its original brain without duplicate mappings', () => {
    const { database, journal } = createJournal();
    const firstBrainId = '018f9d4e-7c20-7b91-8dc0-61749dbcc010';
    const retryBrainId = '018f9d4e-7c21-7b91-8dc0-61749dbcc011';
    createBrain(database, firstBrainId);
    createBrain(database, retryBrainId);

    const input = {
      rawContent: 'Remember the shared brain assignment.',
      eventType: 'user_statement',
      source: { agent: 'codex-cli', reference: 'brain-retry-1' },
      brainId: firstBrainId,
    };
    const first = journal.append(input);
    const retried = journal.append(input);
    let conflict: unknown;
    try {
      journal.append({ ...input, brainId: retryBrainId });
    } catch (error) {
      conflict = error;
    }

    expect(first.brainId).toBe(firstBrainId);
    expect(retried).toEqual(first);
    expect(conflict).toBeInstanceOf(EventBrainConflictError);
    expect((conflict as Error).message).not.toContain(input.rawContent);
    expect(journal.getById(first.id)).toBeUndefined();
    expect(journal.getById(first.id, [retryBrainId])).toBeUndefined();
    expect(journal.getById(first.id, [firstBrainId])).toEqual(first);
    expect(journal.findBySourceReference('brain-retry-1')).toEqual([]);
    expect(journal.findBySourceReference('brain-retry-1', [retryBrainId])).toEqual([]);
    expect(journal.findBySourceReference('brain-retry-1', [firstBrainId])).toEqual([first]);
    expect(journal.searchContent('shared brain')).toEqual([]);
    expect(journal.searchContent('shared brain', [retryBrainId])).toEqual([]);
    expect(journal.searchContent('shared brain', [firstBrainId])).toEqual([first]);
    expect(database.prepare('SELECT brain_id FROM event_brains WHERE event_id = ?').all(first.id)).toEqual([
      { brain_id: firstBrainId },
    ]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 1 });
  });

  test('does not expose an event row without a brain mapping', () => {
    const { database, journal } = createJournal();
    const id = '018f9d4e-7c24-7b91-8dc0-61749dbcc014';
    const rawContent = 'An unmapped event is not a personal memory.';

    database
      .prepare(`
        INSERT INTO events (
          id, event_type, raw_content, structured_data, source_type, source_agent, source_reference,
          source_data, occurred_at, ingested_at, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        'user_statement',
        rawContent,
        null,
        'cli',
        'codex-cli',
        'unmapped-event',
        JSON.stringify({ type: 'cli', agent: 'codex-cli', reference: 'unmapped-event' }),
        '2026-07-12T15:00:00.000Z',
        '2026-07-12T15:00:00.000Z',
        createHash('sha256').update(rawContent).digest('hex'),
      );

    expect(journal.getById(id)).toBeUndefined();
    expect(journal.findBySourceReference('unmapped-event')).toEqual([]);
    expect(journal.searchContent('unmapped event')).toEqual([]);
  });

  test('rejects event input that does not satisfy the shared schema', () => {
    const { journal } = createJournal();

    expect(() =>
      journal.append({
        rawContent: 'A valid event must have a valid source.',
        eventType: 'user_statement',
        source: { type: '' },
      }),
    ).toThrow();
    expect(() =>
      journal.append({
        rawContent: 'Structured data must be JSON.',
        eventType: 'user_statement',
        source: { agent: 'codex-cli' },
        structuredData: BigInt(1) as never,
      }),
    ).toThrow();
    expect(() =>
      journal.append({
        rawContent: 'Null timestamps must be rejected.',
        eventType: 'user_statement',
        source: { agent: 'codex-cli' },
        occurredAt: null as never,
      }),
    ).toThrow();
    expect(() =>
      journal.append({
        rawContent: 'Malformed timestamps must be rejected.',
        eventType: 'user_statement',
        source: { agent: 'codex-cli' },
        occurredAt: '2026-07-12' as never,
      }),
    ).toThrow();
  });

  test('deduplicates only matching content with an explicit source reference', () => {
    const { database, journal } = createJournal();
    const input = {
      rawContent: 'Use local SQLite first.',
      eventType: 'decision',
      source: { agent: 'codex-cli', reference: 'task:4' },
    };
    const first = journal.append(input);
    const duplicate = journal.append({ ...input, occurredAt: '2026-07-12T16:00:00.000Z' });
    const differentReference = journal.append({ ...input, source: { agent: 'codex-cli', reference: 'task:5' } });
    const missingReference = journal.append({ ...input, source: { agent: 'codex-cli' } });
    const differentAgentWithoutReference = journal.append({ ...input, source: { agent: 'another-agent' } });
    const nullReference = journal.append({
      ...input,
      source: { agent: 'third-agent', reference: null },
    });

    expect(duplicate).toEqual(first);
    expect(differentReference.id).not.toBe(first.id);
    expect(differentAgentWithoutReference.id).not.toBe(missingReference.id);
    expect(nullReference.id).not.toBe(missingReference.id);
    expect(database.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 5 });
  });

  test('rejects an event whose stored hash no longer matches its raw content', () => {
    const { database, journal } = createJournal();
    const id = '018f9d4e-7c2a-7b91-8dc0-61749dbcc01e';

    database
      .prepare(`
        INSERT INTO events (
          id, event_type, raw_content, structured_data, source_type, source_agent, source_reference,
          source_data, occurred_at, ingested_at, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        'user_statement',
        'The hash is intentionally wrong.',
        JSON.stringify({ category: 'test' }),
        'cli',
        'codex-cli',
        'tampered-event',
        JSON.stringify({ type: 'cli', agent: 'codex-cli', reference: 'tampered-event' }),
        '2026-07-12T15:00:00.000Z',
        '2026-07-12T15:00:00.000Z',
        '0'.repeat(64),
      );
    database
      .prepare('INSERT INTO event_brains (event_id, brain_id, created_at) VALUES (?, ?, ?)')
      .run(id, DEFAULT_PERSONAL_BRAIN_ID, '2026-07-12T15:00:00.000Z');

    expect(() => journal.getById(id)).toThrow(/content hash/i);
    expect(() => journal.findBySourceReference('tampered-event')).toThrow(/content hash/i);
  });

  test('database triggers reject direct event updates and deletes', () => {
    const { database, journal } = createJournal();
    const event = journal.append({
      rawContent: 'Never mutate an event.',
      eventType: 'user_statement',
      source: { agent: 'codex-cli', reference: 'immutability-test' },
    });

    expect(() => database.prepare('UPDATE events SET raw_content = ? WHERE id = ?').run('mutated', event.id)).toThrow(
      /append-only/,
    );
    expect(() => database.prepare('DELETE FROM events WHERE id = ?').run(event.id)).toThrow(/append-only/);
  });
});
