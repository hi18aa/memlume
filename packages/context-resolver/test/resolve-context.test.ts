import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ContextPackSchema, MemoryItemSchema, createUuidV7, type ContextPack, type MemoryItem, type MemoryScope } from '@memlume/contracts';
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
  readonly validFrom?: string;
  readonly validUntil?: string;
};

type MemoryStore = {
  save(input: MemoryDraft): MemoryItem;
};
type MemoryStoreConstructor = new (database: SqliteDatabase) => MemoryStore;
type ContextResolverConstructor = new (store: MemoryStore) => {
  resolve(input: {
    readonly intent: string;
    readonly scope: MemoryScope;
    readonly task: string | null;
    readonly contextBudget: number;
    readonly entities?: readonly string[];
    readonly availableTools?: readonly string[];
  }): ContextPack;
};

const { MemoryStore } = retrieval as { MemoryStore?: MemoryStoreConstructor };
const { ContextResolver, ESTIMATED_TEXT_UNIT_CHARS } = resolverModule as {
  ContextResolver?: ContextResolverConstructor;
  ESTIMATED_TEXT_UNIT_CHARS?: number;
};

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

function insertProcedure(
  database: SqliteDatabase,
  trigger: Record<string, unknown>,
  scope: MemoryScope = { level: 'global' },
): MemoryItem {
  const now = new Date().toISOString();
  const memory = MemoryItemSchema.parse({
    id: createUuidV7(),
    kind: 'procedure',
    title: 'Image workflow',
    canonicalText: 'Run the image workflow.',
    structuredData: { trigger, steps: [{ order: 1, action: 'Prepare the image.' }] },
    scope,
    status: 'active',
    priority: 0,
    confidence: 1,
    explicitness: 1,
    createdAt: now,
    updatedAt: now,
  });
  database
    .prepare(`
      INSERT INTO memory_items (
        id, kind, title, canonical_text, structured_data, scope_data, status, priority,
        confidence, explicitness, source_event_id, created_at, updated_at, valid_from,
        valid_until, superseded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      memory.id,
      memory.kind,
      memory.title ?? null,
      memory.canonicalText,
      JSON.stringify(memory.structuredData),
      JSON.stringify(memory.scope),
      memory.status,
      memory.priority,
      memory.confidence,
      memory.explicitness,
      memory.sourceEventId ?? null,
      memory.createdAt,
      memory.updatedAt,
      memory.validFrom ?? null,
      memory.validUntil ?? null,
      memory.supersededBy ?? null,
    );
  return memory;
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
    expect(ESTIMATED_TEXT_UNIT_CHARS).toBe(4);
    expect(pack.directives.map((directive) => directive.memoryId)).toEqual([project.id, global.id]);
    expect(pack.directives[0]).toMatchObject({ mandatory: true, priority: 1 });
    expect(pack.explanation.sourceMemoryIds).toEqual([project.id, global.id]);
    expect(ContextPackSchema.parse(pack)).toEqual(pack);
  });

  test('requires every policy and procedure trigger entity and available tool', () => {
    const { database, store, resolver } = createResolver();
    const trigger = {
      intents: ['image_generation'],
      entities: ['logo'],
      requiredToolAvailability: ['image-tool'],
    };
    const guardedPolicy = store.save({
      kind: 'policy',
      canonicalText: 'Use the guarded image route.',
      structuredData: { ...policy('guarded-image-route'), trigger },
      scope: { level: 'global' },
    });
    const guardedProcedure = insertProcedure(database, trigger);

    const missing = resolver.resolve({
      intent: 'image_generation',
      scope: { level: 'global' },
      task: null,
      contextBudget: 100,
    });
    expect(missing.directives).toEqual([]);
    expect(missing.procedures).toEqual([]);

    const missingTool = resolver.resolve({
      intent: 'image_generation',
      scope: { level: 'global' },
      task: null,
      contextBudget: 100,
      entities: ['logo'],
    });
    expect(missingTool.directives).toEqual([]);
    expect(missingTool.procedures).toEqual([]);

    const missingEntity = resolver.resolve({
      intent: 'image_generation',
      scope: { level: 'global' },
      task: null,
      contextBudget: 100,
      availableTools: ['image-tool'],
    });
    expect(missingEntity.directives).toEqual([]);
    expect(missingEntity.procedures).toEqual([]);

    const matching = resolver.resolve({
      intent: 'image_generation',
      scope: { level: 'global' },
      task: null,
      contextBudget: 100,
      entities: ['logo'],
      availableTools: ['image-tool'],
    });
    expect(matching.directives.map((directive) => directive.memoryId)).toEqual([guardedPolicy.id]);
    expect(matching.procedures.map((procedure) => procedure.memoryId)).toEqual([guardedProcedure.id]);
  });

  test('excludes future and expired memories while keeping the inclusive current-date fact', () => {
    const { store, resolver } = createResolver();
    const today = new Date().toISOString().slice(0, 10);
    store.save({
      kind: 'policy',
      canonicalText: 'This future route must not be included.',
      structuredData: policy('future-route'),
      scope: { level: 'global' },
      validFrom: '2999-01-01',
    });
    store.save({
      kind: 'policy',
      canonicalText: 'This expired route must not be included.',
      structuredData: policy('expired-route'),
      scope: { level: 'global' },
      validUntil: '2000-01-01',
    });
    store.save({
      kind: 'fact',
      title: 'Future fact',
      canonicalText: 'The timed logo fact is only true in the future.',
      structuredData: { subject: 'logo', predicate: 'timed', object: 'future', confidence: 1 },
      scope: { level: 'global' },
      validFrom: '2999-01-01',
    });
    store.save({
      kind: 'fact',
      title: 'Expired fact',
      canonicalText: 'The timed logo fact is no longer true.',
      structuredData: { subject: 'logo', predicate: 'timed', object: 'expired', confidence: 1 },
      scope: { level: 'global' },
      validUntil: '2000-01-01',
    });
    const current = store.save({
      kind: 'fact',
      title: 'Current fact',
      canonicalText: 'The timed logo fact is true today.',
      structuredData: { subject: 'logo', predicate: 'timed', object: 'current', confidence: 1 },
      scope: { level: 'global' },
      validFrom: today,
      validUntil: today,
    });

    const pack = resolver.resolve({
      intent: 'image_generation',
      scope: { level: 'global' },
      task: 'timed logo fact',
      contextBudget: 100,
    });

    expect(pack.directives).toEqual([]);
    expect(pack.knowledge).toEqual([{ memoryId: current.id, title: 'Current fact', summary: current.canonicalText }]);
  });

  test('applies fact payload validity dates to FTS results', () => {
    const { store, resolver } = createResolver();
    store.save({
      kind: 'fact',
      title: 'Future payload fact',
      canonicalText: 'The payload timed logo fact only applies in the future.',
      structuredData: {
        subject: 'logo',
        predicate: 'payload_timed',
        object: 'future',
        validFrom: '2999-01-01',
        confidence: 1,
      },
      scope: { level: 'global' },
    });
    store.save({
      kind: 'fact',
      title: 'Expired payload fact',
      canonicalText: 'The payload timed logo fact no longer applies.',
      structuredData: {
        subject: 'logo',
        predicate: 'payload_timed',
        object: 'expired',
        validUntil: '2000-01-01',
        confidence: 1,
      },
      scope: { level: 'global' },
    });

    const pack = resolver.resolve({
      intent: 'image_generation',
      scope: { level: 'global' },
      task: 'payload timed logo fact',
      contextBudget: 100,
    });

    expect(pack.knowledge).toEqual([]);
  });

  test('lets the highest-ranked exclusive route tool exclude conflicting routes', () => {
    const { store, resolver } = createResolver();
    const global = store.save({
      kind: 'policy',
      canonicalText: 'Use the global image route.',
      structuredData: policy('global-image-route', { exclusive: true }),
      scope: { level: 'global' },
      priority: 999,
    });
    const project = store.save({
      kind: 'policy',
      canonicalText: 'Use the exclusive project image route.',
      structuredData: policy('project-image-route', { exclusive: true }),
      scope: { level: 'project', projectId: 'memlume' },
      priority: 1,
    });

    const pack = resolver.resolve({
      intent: 'image_generation',
      scope: { level: 'project', projectId: 'memlume' },
      task: null,
      contextBudget: 100,
    });

    expect(pack.directives).toEqual([
      expect.objectContaining({ memoryId: project.id, actionTarget: 'project-image-route', mandatory: true }),
    ]);
    expect(pack.explanation.exclusions).toEqual([{ memoryId: global.id, reason: 'exclusive_conflict' }]);
  });

  test('prioritizes a project route over a global exclusive route and explains the winner', () => {
    const { store, resolver } = createResolver();
    const global = store.save({
      kind: 'policy',
      canonicalText: 'Use the global route even when a project route is more specific.',
      structuredData: policy('global-image-route', { exclusive: true }),
      scope: { level: 'global' },
      priority: 999,
    });
    const project = store.save({
      kind: 'policy',
      canonicalText: 'Use the project route, whose long text exceeds the tiny budget.',
      structuredData: policy('project-image-route'),
      scope: { level: 'project', projectId: 'memlume' },
      priority: 1,
    });

    const pack = resolver.resolve({
      intent: 'image_generation',
      scope: { level: 'project', projectId: 'memlume' },
      task: null,
      contextBudget: 1,
    });

    expect(pack.directives).toEqual([
      expect.objectContaining({ memoryId: project.id, actionTarget: 'project-image-route', mandatory: true }),
    ]);
    expect(pack.explanation.exclusions).toEqual([{ memoryId: global.id, reason: 'exclusive_conflict' }]);
    expect(pack.explanation.toolSelection).toContain('project-image-route');
    expect(pack.explanation.toolSelection).toContain(project.id);
    expect(pack.explanation.toolSelection).toContain('scope_then_priority');
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
      priority: 1,
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
      expect.objectContaining({
        limitUnits: 1,
        included: [expect.objectContaining({ memoryId: mandatory.id, estimatedTextUnits: expect.any(Number) })],
      }),
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
