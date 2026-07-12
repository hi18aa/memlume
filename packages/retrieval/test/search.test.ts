import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryItemSchema, type MemoryItem, type MemoryScope } from '@memlume/contracts';
import { openDatabase, type SqliteDatabase } from '@memlume/database/internal';
import { afterEach, describe, expect, test } from 'vitest';

import * as retrieval from '../src/index.js';

type MemoryDraft = {
  readonly kind: 'policy' | 'preference' | 'fact' | 'decision';
  readonly canonicalText: string;
  readonly structuredData: Record<string, unknown>;
  readonly scope: MemoryScope;
  readonly title?: string;
  readonly priority?: number;
  readonly confidence?: number;
  readonly explicitness?: number;
};

type MemoryStore = {
  save(input: MemoryDraft): MemoryItem;
  update(id: string, input: Partial<Omit<MemoryDraft, 'kind'>>): MemoryItem;
  get(id: string): MemoryItem | undefined;
  list(filters?: { readonly scope?: MemoryScope; readonly status?: string; readonly kinds?: readonly string[] }): MemoryItem[];
  search(query: string, filters?: { readonly status?: string; readonly kinds?: readonly string[] }): MemoryItem[];
};

type MemoryStoreConstructor = new (database: SqliteDatabase) => MemoryStore;
const { MemoryStore } = retrieval as { MemoryStore?: MemoryStoreConstructor };

const databases: SqliteDatabase[] = [];
const directories: string[] = [];

function createStore(): { database: SqliteDatabase; store: MemoryStore } {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-retrieval-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'memlume.sqlite'));
  databases.push(database);

  expect(MemoryStore).toBeTypeOf('function');
  return { database, store: new MemoryStore!(database) };
}

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (directories.length > 0) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

describe('MemoryStore', () => {
  test('saves only manual active memories, validates stored JSON, and refreshes FTS5 on update', () => {
    const { store } = createStore();
    const fact = store.save({
      kind: 'fact',
      title: 'Storage choice',
      canonicalText: 'SQLite is the local durable memory store.',
      structuredData: { subject: 'Memlume', predicate: 'uses', object: 'SQLite', confidence: 1 },
      scope: { level: 'global' },
      priority: 10,
    });

    expect(MemoryItemSchema.parse(fact)).toEqual(fact);
    expect(store.get(fact.id)).toEqual(fact);
    expect(store.search('SQLite durable memory', { status: 'active', kinds: ['fact'] })).toEqual([fact]);

    const updated = store.update(fact.id, { canonicalText: 'PostgreSQL is not the local durable memory store.' });
    expect(updated.createdAt).toBe(fact.createdAt);
    expect(updated.updatedAt >= fact.updatedAt).toBe(true);
    expect(store.search('SQLite', { kinds: ['fact'] })).toEqual([]);
    expect(store.search('PostgreSQL durable memory', { kinds: ['fact'] })).toEqual([updated]);
    expect(store.list({ scope: { level: 'global' }, status: 'active', kinds: ['fact'] })).toEqual([updated]);

    expect(() =>
      store.save({
        kind: 'procedure' as never,
        canonicalText: 'This cannot be manually saved in v0.1.',
        structuredData: {},
        scope: { level: 'global' },
      }),
    ).toThrow(/policy|preference|fact|decision/i);
  });
});
