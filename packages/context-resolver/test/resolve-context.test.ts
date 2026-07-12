import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ContextPackSchema, type ContextPack, type MemoryItem, type MemoryScope } from '@memlume/contracts';
import { openDatabase, type SqliteDatabase } from '@memlume/database/internal';
import { afterEach, describe, expect, test } from 'vitest';

import * as resolverModule from '../src/index.js';
import * as retrieval from '../../retrieval/src/index.js';

type MemoryDraft = {
  readonly kind: 'policy' | 'preference' | 'fact' | 'decision';
  readonly canonicalText: string;
  readonly structuredData: Record<string, unknown>;
  readonly scope: MemoryScope;
  readonly title?: string;
  readonly priority?: number;
};

type MemoryStore = {
  save(input: MemoryDraft): MemoryItem;
};
type MemoryStoreConstructor = new (database: SqliteDatabase) => MemoryStore;
type ContextResolverConstructor = new (store: MemoryStore) => {
  resolve(input: { readonly intent: string; readonly scope: MemoryScope; readonly task: string | null; readonly contextBudget: number }): ContextPack;
};

const { MemoryStore } = retrieval as { MemoryStore?: MemoryStoreConstructor };
const { ContextResolver } = resolverModule as { ContextResolver?: ContextResolverConstructor };

const databases: SqliteDatabase[] = [];
const directories: string[] = [];

function createResolver(): { database: SqliteDatabase; store: MemoryStore; resolver: InstanceType<ContextResolverConstructor> } {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-context-resolver-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'memlume.sqlite'));
  databases.push(database);

  expect(MemoryStore).toBeTypeOf('function');
  expect(ContextResolver).toBeTypeOf('function');
  const store = new MemoryStore!(database);
  return { database, store, resolver: new ContextResolver!(store) };
}

function policy(target: string, constraints: { readonly exclusive?: boolean; readonly required?: boolean } = {}) {
  return {
    trigger: { intents: ['image_generation'] },
    action: { type: 'route_tool', target },
    constraints,
  };
}

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (directories.length > 0) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

describe('ContextResolver', () => {
  test('places a project policy before a global policy and returns traceable context', () => {
    const { store, resolver } = createResolver();
    const global = store.save({
      kind: 'policy',
      canonicalText: 'Use the general image route.',
      structuredData: policy('general-image-route'),
      scope: { level: 'global' },
      priority: 999,
    });
    const project = store.save({
      kind: 'policy',
      canonicalText: 'Use the Memlume image route.',
      structuredData: policy('memlume-image-route', { required: true }),
      scope: { level: 'project', projectId: 'memlume' },
      priority: 1,
    });

    const pack = resolver.resolve({
      intent: 'image_generation',
      scope: { level: 'project', projectId: 'memlume' },
      task: 'Create a product logo.',
      contextBudget: 100,
    });

    expect(pack.traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(pack.directives.map((directive) => directive.memoryId)).toEqual([project.id, global.id]);
    expect(pack.directives[0]).toMatchObject({ mandatory: true, priority: 1 });
    expect(pack.explanation.sourceMemoryIds).toEqual([project.id, global.id]);
    expect(ContextPackSchema.parse(pack)).toEqual(pack);
  });

  test('excludes inactive and scope-mismatched memories', () => {
    const { database, store, resolver } = createResolver();
    const inactive = store.save({
      kind: 'policy',
      canonicalText: 'This archived route must not be included.',
      structuredData: policy('archived-route'),
      scope: { level: 'global' },
    });
    store.save({
      kind: 'policy',
      canonicalText: 'This belongs to another project.',
      structuredData: policy('other-project-route'),
      scope: { level: 'project', projectId: 'other-project' },
    });
    database.prepare('UPDATE memory_items SET status = ? WHERE id = ?').run('archived', inactive.id);

    const pack = resolver.resolve({
      intent: 'image_generation',
      scope: { level: 'project', projectId: 'memlume' },
      task: null,
      contextBudget: 100,
    });

    expect(pack.directives).toEqual([]);
    expect(pack.explanation.sourceMemoryIds).toEqual([]);
  });

  test('adds applicable preferences, FTS facts, and decisions as traceable evidence', () => {
    const { store, resolver } = createResolver();
    const preference = store.save({
      kind: 'preference',
      canonicalText: 'Prefer a legible mark with clean geometry.',
      structuredData: {
        domain: 'design',
        subject: 'logo',
        dimension: 'style',
        value: 'legible',
        strength: 1,
        confidence: 1,
        contexts: ['image_generation'],
      },
      scope: { level: 'global' },
    });
    const fact = store.save({
      kind: 'fact',
      title: 'Source art size',
      canonicalText: 'Use 1024px source art for a logo image.',
      structuredData: { subject: 'logo', predicate: 'source_size', object: '1024px', confidence: 1 },
      scope: { level: 'global' },
    });
    const decision = store.save({
      kind: 'decision',
      canonicalText: 'Use SVG as the source format.',
      structuredData: {
        title: 'Use SVG as the source format.',
        status: 'active',
        rationale: ['SVG stays sharp at all logo sizes.'],
      },
      scope: { level: 'global' },
    });

    const pack = resolver.resolve({
      intent: 'image_generation',
      scope: { level: 'global' },
      task: 'Make a 1024px source art logo image.',
      contextBudget: 100,
    });

    expect(pack.preferences).toEqual([{ memoryId: preference.id, text: preference.canonicalText }]);
    expect(pack.knowledge).toEqual([{ memoryId: fact.id, title: 'Source art size', summary: fact.canonicalText }]);
    expect(pack.decisions).toEqual([{ memoryId: decision.id, text: decision.canonicalText }]);
    expect(pack.explanation.sourceMemoryIds).toEqual([preference.id, fact.id, decision.id]);
  });

  test('keeps mandatory directives when the explicit context budget is too small', () => {
    const { store, resolver } = createResolver();
    const mandatory = store.save({
      kind: 'policy',
      canonicalText: 'Always use the required image route before any optional advice.',
      structuredData: policy('required-image-route', { exclusive: true }),
      scope: { level: 'global' },
    });
    store.save({
      kind: 'policy',
      canonicalText: 'This optional route should not fit the budget.',
      structuredData: policy('optional-image-route'),
      scope: { level: 'global' },
    });

    const pack = resolver.resolve({
      intent: 'image_generation',
      scope: { level: 'global' },
      task: '',
      contextBudget: 1,
    });
    const validated = ContextPackSchema.parse(pack);

    expect(pack.directives).toEqual([
      expect.objectContaining({ memoryId: mandatory.id, mandatory: true }),
    ]);
    expect(validated.explanation).toHaveProperty(
      'budget',
      expect.objectContaining({ limit: 1, included: [expect.objectContaining({ memoryId: mandatory.id })] }),
    );
  });

  test('records optional memories omitted by a tiny context budget', () => {
    const { store, resolver } = createResolver();
    const optional = store.save({
      kind: 'policy',
      canonicalText: 'This optional route must be omitted.',
      structuredData: policy('optional-image-route'),
      scope: { level: 'global' },
    });

    const pack = resolver.resolve({
      intent: 'image_generation',
      scope: { level: 'global' },
      task: null,
      contextBudget: 1,
    });

    expect(pack.directives).toEqual([]);
    expect(pack.explanation.budget).toMatchObject({
      truncated: true,
      omitted: [{ memoryId: optional.id, reason: 'budget' }],
    });
  });
});
