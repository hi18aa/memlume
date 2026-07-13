import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createUuidV7 } from '@memlume/contracts';
import type { SqliteDatabase } from '@memlume/database/internal';
import Database from 'better-sqlite3';

import { readVerifiedBackup, type VerifyBackupOptions } from './verify-backup.js';

export type ImportBrainOptions = VerifyBackupOptions & {
  readonly database: SqliteDatabase;
  readonly name?: string;
};

export type ImportedBrain = {
  readonly brain: { readonly id: string; readonly kind: string; readonly name: string };
  readonly source: { readonly brainId: string; readonly name: string };
  readonly mountsImported: false;
  readonly eventCount: number;
  readonly memoryCount: number;
};

export class BrainImportConflictError extends Error {
  constructor() {
    super('The Brain export conflicts with an existing event source.');
    this.name = 'BrainImportConflictError';
  }
}

export class FullRestoreRequiredError extends Error {
  constructor() {
    super('A complete backup must use the restore command instead of Brain import.');
    this.name = 'FullRestoreRequiredError';
  }
}

export async function importBrain(options: ImportBrainOptions): Promise<ImportedBrain> {
  const verified = await readVerifiedBackup(options);
  if (verified.manifest.scope === 'full') {
    throw new FullRestoreRequiredError();
  }
  if (verified.manifest.brainIds.length !== 1 || verified.manifest.mappings.brains.length !== 1) {
    throw new Error('Only a single Brain export can be imported.');
  }
  const sourceBrainId = verified.manifest.brainIds[0]!;
  const directory = mkdtempSync(join(tmpdir(), 'memlume-brain-import-'));
  const snapshotPath = join(directory, 'snapshot.sqlite');
  try {
    writeFileSync(snapshotPath, verified.snapshot);
    const source = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      return importSnapshot(options.database, source, sourceBrainId, options.name);
    } finally {
      source.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function importSnapshot(target: SqliteDatabase, source: Database.Database, sourceBrainId: string, requestedName: string | undefined): ImportedBrain {
  const sourceBrain = source.prepare('SELECT id, kind, name FROM brains WHERE id = ?').get(sourceBrainId) as BrainRow | undefined;
  if (sourceBrain === undefined) {
    throw new Error('Brain export does not contain its declared Brain.');
  }
  const name = requestedName === undefined ? sourceBrain.name : requestedName.trim();
  if (name === '') {
    throw new Error('Imported Brain name must not be empty.');
  }
  const events = source.prepare(`${eventColumns} FROM events JOIN event_brains ON event_brains.event_id = events.id WHERE event_brains.brain_id = ? ORDER BY events.id`).all(sourceBrainId) as EventRow[];
  const memories = source.prepare(`${memoryColumns} FROM memory_items JOIN memory_brains ON memory_brains.memory_id = memory_items.id WHERE memory_brains.brain_id = ? ORDER BY memory_items.id`).all(sourceBrainId) as MemoryRow[];
  const versions = source.prepare(`${versionColumns} FROM memory_versions JOIN memory_brains ON memory_brains.memory_id = memory_versions.memory_id WHERE memory_brains.brain_id = ? ORDER BY memory_versions.id`).all(sourceBrainId) as VersionRow[];
  const relations = source.prepare(`${relationColumns} FROM memory_relations JOIN memory_brains ON memory_brains.memory_id = memory_relations.source_id WHERE memory_brains.brain_id = ? ORDER BY memory_relations.source_id, memory_relations.target_id, memory_relations.relation_type`).all(sourceBrainId) as RelationRow[];
  const usage = source.prepare(`${usageColumns} FROM memory_usage JOIN memory_brains ON memory_brains.memory_id = memory_usage.memory_id WHERE memory_brains.brain_id = ? ORDER BY memory_usage.id`).all(sourceBrainId) as UsageRow[];
  const searchRows = source.prepare(`${searchColumns} FROM memory_search JOIN memory_brains ON memory_brains.memory_id = memory_search.memory_id WHERE memory_brains.brain_id = ? ORDER BY memory_search.memory_id`).all(sourceBrainId) as SearchRow[];
  const eventIds = new Set(events.map(({ id }) => id));
  const memoryIds = new Set(memories.map(({ id }) => id));
  if (memories.some(({ source_event_id }) => source_event_id !== null && !eventIds.has(source_event_id))
    || memories.some(({ superseded_by }) => superseded_by !== null && !memoryIds.has(superseded_by))
    || versions.some(({ memory_id }) => !memoryIds.has(memory_id))
    || relations.some(({ source_id, target_id, source_event_id }) => !memoryIds.has(source_id) || !memoryIds.has(target_id) || source_event_id !== null && !eventIds.has(source_event_id))
    || usage.some(({ memory_id }) => !memoryIds.has(memory_id))
    || searchRows.some(({ memory_id }) => !memoryIds.has(memory_id))) {
    throw new Error('Brain export has references outside its declared Brain.');
  }
  const searchesByMemory = new Map<string, SearchRow[]>();
  for (const search of searchRows) {
    const rows = searchesByMemory.get(search.memory_id) ?? [];
    rows.push(search);
    searchesByMemory.set(search.memory_id, rows);
  }

  const brainId = createUuidV7();
  const eventIdsBySource = new Map(events.map(({ id }) => [id, createUuidV7()]));
  const memoryIdsBySource = new Map(memories.map(({ id }) => [id, createUuidV7()]));
  const now = new Date().toISOString();

  target.transaction(() => {
    const eventExists = target.prepare('SELECT 1 FROM events WHERE content_hash = ? AND source_reference = ?');
    if (events.some(({ content_hash, source_reference }) => source_reference !== null && eventExists.get(content_hash, source_reference) !== undefined)) {
      throw new BrainImportConflictError();
    }
    target.prepare('INSERT INTO brains (id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(brainId, sourceBrain.kind, name, now, now);
    const insertEvent = target.prepare(`INSERT INTO events (id, event_type, raw_content, structured_data, source_type, source_agent, source_reference, source_data, occurred_at, ingested_at, processing_status, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertEventBrain = target.prepare('INSERT INTO event_brains (event_id, brain_id, created_at) VALUES (?, ?, ?)');
    for (const event of events) {
      const eventId = eventIdsBySource.get(event.id)!;
      insertEvent.run(eventId, event.event_type, event.raw_content, event.structured_data, event.source_type, event.source_agent, event.source_reference, event.source_data, event.occurred_at, event.ingested_at, event.processing_status, event.content_hash);
      insertEventBrain.run(eventId, brainId, event.ingested_at);
    }
    const insertMemory = target.prepare(`INSERT INTO memory_items (id, kind, name, title, canonical_text, structured_data, scope_data, status, priority, confidence, explicitness, source_event_id, created_at, updated_at, valid_from, valid_until, last_used_at, superseded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertMemoryBrain = target.prepare('INSERT INTO memory_brains (memory_id, brain_id, created_at) VALUES (?, ?, ?)');
    const insertSearch = target.prepare('INSERT INTO memory_search (memory_id, title, canonical_text, summary, keywords, entities, content) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const memory of memories) {
      const memoryId = memoryIdsBySource.get(memory.id)!;
      insertMemory.run(memoryId, memory.kind, memory.name, memory.title, memory.canonical_text, memory.structured_data, memory.scope_data, memory.status, memory.priority, memory.confidence, memory.explicitness, memory.source_event_id === null ? null : eventIdsBySource.get(memory.source_event_id)!, memory.created_at, memory.updated_at, memory.valid_from, memory.valid_until, memory.last_used_at, memory.superseded_by === null ? null : memoryIdsBySource.get(memory.superseded_by)!);
      insertMemoryBrain.run(memoryId, brainId, memory.created_at);
      const searches = searchesByMemory.get(memory.id);
      if (searches === undefined || searches.length === 0) {
        insertSearch.run(memoryId, memory.title ?? '', memory.canonical_text, memory.canonical_text, '', '', memory.canonical_text);
      } else {
        for (const search of searches) {
          insertSearch.run(memoryId, search.title, search.canonical_text, search.summary, search.keywords, search.entities, search.content);
        }
      }
    }
    const insertVersion = target.prepare('INSERT INTO memory_versions (id, memory_id, version, canonical_text, structured_data, changed_by, change_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const version of versions) {
      insertVersion.run(createUuidV7(), memoryIdsBySource.get(version.memory_id)!, version.version, version.canonical_text, version.structured_data, version.changed_by, version.change_reason, version.created_at);
    }
    const insertRelation = target.prepare('INSERT INTO memory_relations (source_id, target_id, relation_type, confidence, source_event_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const relation of relations) {
      insertRelation.run(memoryIdsBySource.get(relation.source_id)!, memoryIdsBySource.get(relation.target_id)!, relation.relation_type, relation.confidence, relation.source_event_id === null ? null : eventIdsBySource.get(relation.source_event_id)!, relation.created_at);
    }
    const insertUsage = target.prepare('INSERT INTO memory_usage (id, memory_id, task_id, agent_id, retrieval_rank, was_included, outcome, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const use of usage) {
      insertUsage.run(createUuidV7(), memoryIdsBySource.get(use.memory_id)!, use.task_id, use.agent_id, use.retrieval_rank, use.was_included, use.outcome, use.used_at);
    }
  }).immediate();

  return {
    brain: { id: brainId, kind: sourceBrain.kind, name },
    source: { brainId: sourceBrain.id, name: sourceBrain.name },
    mountsImported: false,
    eventCount: events.length,
    memoryCount: memories.length,
  };
}

const eventColumns = `SELECT events.id, events.event_type, events.raw_content, events.structured_data, events.source_type, events.source_agent, events.source_reference, events.source_data, events.occurred_at, events.ingested_at, events.processing_status, events.content_hash`;
const memoryColumns = `SELECT memory_items.id, memory_items.kind, memory_items.name, memory_items.title, memory_items.canonical_text, memory_items.structured_data, memory_items.scope_data, memory_items.status, memory_items.priority, memory_items.confidence, memory_items.explicitness, memory_items.source_event_id, memory_items.created_at, memory_items.updated_at, memory_items.valid_from, memory_items.valid_until, memory_items.last_used_at, memory_items.superseded_by`;
const versionColumns = `SELECT memory_versions.id, memory_versions.memory_id, memory_versions.version, memory_versions.canonical_text, memory_versions.structured_data, memory_versions.changed_by, memory_versions.change_reason, memory_versions.created_at`;
const relationColumns = `SELECT memory_relations.source_id, memory_relations.target_id, memory_relations.relation_type, memory_relations.confidence, memory_relations.source_event_id, memory_relations.created_at`;
const usageColumns = `SELECT memory_usage.id, memory_usage.memory_id, memory_usage.task_id, memory_usage.agent_id, memory_usage.retrieval_rank, memory_usage.was_included, memory_usage.outcome, memory_usage.used_at`;
const searchColumns = `SELECT memory_search.memory_id, memory_search.title, memory_search.canonical_text, memory_search.summary, memory_search.keywords, memory_search.entities, memory_search.content`;

type BrainRow = { readonly id: string; readonly kind: string; readonly name: string };
type EventRow = { readonly id: string; readonly event_type: string; readonly raw_content: string; readonly structured_data: string | null; readonly source_type: string; readonly source_agent: string | null; readonly source_reference: string | null; readonly source_data: string; readonly occurred_at: string; readonly ingested_at: string; readonly processing_status: string; readonly content_hash: string };
type MemoryRow = { readonly id: string; readonly kind: string; readonly name: string | null; readonly title: string | null; readonly canonical_text: string; readonly structured_data: string; readonly scope_data: string; readonly status: string; readonly priority: number; readonly confidence: number; readonly explicitness: number; readonly source_event_id: string | null; readonly created_at: string; readonly updated_at: string; readonly valid_from: string | null; readonly valid_until: string | null; readonly last_used_at: string | null; readonly superseded_by: string | null };
type VersionRow = { readonly id: string; readonly memory_id: string; readonly version: number; readonly canonical_text: string; readonly structured_data: string; readonly changed_by: string; readonly change_reason: string | null; readonly created_at: string };
type RelationRow = { readonly source_id: string; readonly target_id: string; readonly relation_type: string; readonly confidence: number; readonly source_event_id: string | null; readonly created_at: string };
type UsageRow = { readonly id: string; readonly memory_id: string; readonly task_id: string; readonly agent_id: string; readonly retrieval_rank: number | null; readonly was_included: number; readonly outcome: string | null; readonly used_at: string };
type SearchRow = { readonly memory_id: string; readonly title: string; readonly canonical_text: string; readonly summary: string; readonly keywords: string; readonly entities: string; readonly content: string };
