import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { initialMigration, openDatabase } from '../../database/src/index.js';
import { EventJournal } from '../src/index.js';

const databases: ReturnType<typeof openDatabase>[] = [];
const temporaryDirectories: string[] = [];

function createJournal() {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-event-journal-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, 'memlume.sqlite'));
  databases.push(database);

  return { database, journal: new EventJournal(database) };
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
  test('creates the core tables with WAL settings and supports down then up', () => {
    const { database } = createJournal();
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
    });
    expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(journal.getById(event.id)).toEqual(event);
    expect(journal.findBySourceReference('conversation:1/message:1')).toEqual([event]);
    expect(journal.searchContent('亂花錢')).toEqual([event]);
    expect(
      database.prepare('SELECT content_hash FROM events WHERE id = ?').get(event.id),
    ).toEqual({ content_hash: createHash('sha256').update(event.rawContent).digest('hex') });
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
  });

  test('deduplicates matching content and source reference, including missing references', () => {
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
    const duplicateMissingReference = journal.append({ ...input, source: { agent: 'codex-cli' } });

    expect(duplicate).toEqual(first);
    expect(differentReference.id).not.toBe(first.id);
    expect(duplicateMissingReference).toEqual(missingReference);
    expect(database.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 3 });
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
