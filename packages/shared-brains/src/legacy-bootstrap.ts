import { createUuidV7, IsoUtcDateTimeSchema, JsonValueSchema, MemoryScopeSchema, SemanticRecordSchema, TombstoneRecordSchema, UuidV7Schema, type BrainRecord, type JsonValue, type MemoryKind, type MemoryScope, type MemoryStatus } from '@memlume/contracts';
import { setDatabaseAuthority, type SqliteDatabase } from '@memlume/database/internal';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { MarkdownRecordStore } from './markdown-record-store.js';

export type LegacyBootstrapPhase = 'lock' | 'snapshot' | 'parse' | 'append' | 'complete';

export type LegacyBootstrapOptions = {
  readonly database: SqliteDatabase;
  readonly dataRoot: string;
  readonly lockPath?: string;
  /** Set only when the caller has already completed reindex/verification. */
  readonly markAuthority?: boolean;
  readonly onPhase?: (phase: LegacyBootstrapPhase) => void;
};

export type LegacyBootstrapResult = {
  readonly status: 'completed' | 'already_complete';
  readonly exported: number;
  readonly semanticRecords: number;
  readonly tombstoneRecords: number;
  readonly eventRecords: number;
  readonly skippedUnbound: number;
};

type LegacyMemoryRow = {
  id: string;
  kind: string;
  title: string | null;
  canonical_text: string;
  structured_data: string;
  scope_data: string;
  status: string;
  priority: number;
  confidence: number;
  explicitness: number;
  source_event_id: string | null;
  created_at: string;
  updated_at: string;
  valid_from: string | null;
  valid_until: string | null;
  superseded_by: string | null;
  brain_id: string | null;
  brain_name: string | null;
};

type LegacyVersionRow = {
  id: string;
  memory_id: string;
  version: number;
  canonical_text: string;
  structured_data: string;
  created_at: string;
};

type LegacyEventRow = {
  id: string;
  event_type: string;
  raw_content: string;
  structured_data: string | null;
  occurred_at: string;
  ingested_at: string;
  brain_id: string | null;
  brain_name: string | null;
};

type LegacySnapshot = {
  readonly memories: readonly LegacyMemoryRow[];
  readonly versions: readonly LegacyVersionRow[];
  readonly events: readonly LegacyEventRow[];
};

/**
 * Export pre-v0.3 semantic rows into immutable Markdown authority records.
 * The operation is deliberately synchronous: better-sqlite3 and the record
 * store are synchronous, so a process crash leaves an idempotent append set.
 */
export function bootstrapLegacyMemories(options: LegacyBootstrapOptions): LegacyBootstrapResult {
  const dataRoot = absoluteRoot(options.dataRoot);
  const store = new MarkdownRecordStore({ rootDir: dataRoot });
  const lockPath = absolutePath(options.lockPath ?? join(dataRoot, '.memlume-bootstrap.lock'));
  const release = acquireLock(lockPath);
  try {
    options.onPhase?.('lock');
    const snapshot = readSnapshot(options.database, options.onPhase);
    const existing = store.list();
    const plan = buildPlan(snapshot, existing, store);
    options.onPhase?.('parse');

    let exported = 0;
    for (const record of plan.records) {
      options.onPhase?.('append');
      if (hasEquivalentRecord(existing, record)) {
        continue;
      }
      if ('brainId' in record) {
        store.ensureBrainDocument(record.brainId, { name: plan.brainNames.get(record.brainId) });
      }
      store.append(record);
      exported += 1;
    }
    options.onPhase?.('complete');
    if (options.markAuthority === true) {
      setDatabaseAuthority(options.database, 'markdown');
    }
    return {
      status: exported === 0 && plan.records.length > 0 ? 'already_complete' : 'completed',
      exported,
      semanticRecords: plan.records.filter((record) => record.recordType === 'semantic' && record.kind !== 'event').length,
      tombstoneRecords: plan.records.filter((record) => record.recordType === 'tombstone').length,
      eventRecords: plan.records.filter((record) => record.recordType === 'semantic' && record.kind === 'event').length,
      skippedUnbound: plan.skippedUnbound,
    };
  } finally {
    release();
  }
}

export const bootstrapLegacy = bootstrapLegacyMemories;

function readSnapshot(database: SqliteDatabase, onPhase: LegacyBootstrapOptions['onPhase']): LegacySnapshot {
  onPhase?.('snapshot');
  try {
    database.exec('BEGIN IMMEDIATE');
    const memories = database.prepare(`
      SELECT memory_items.id, memory_items.kind, memory_items.title, memory_items.canonical_text,
             memory_items.structured_data, memory_items.scope_data, memory_items.status,
             memory_items.priority, memory_items.confidence, memory_items.explicitness,
             memory_items.source_event_id, memory_items.created_at, memory_items.updated_at,
             memory_items.valid_from, memory_items.valid_until, memory_items.superseded_by,
             memory_brains.brain_id, brains.name AS brain_name
      FROM memory_items
      LEFT JOIN memory_brains ON memory_brains.memory_id = memory_items.id
      LEFT JOIN brains ON brains.id = memory_brains.brain_id
      ORDER BY memory_items.created_at, memory_items.id
    `).all() as LegacyMemoryRow[];
    const versions = database.prepare(`
      SELECT id, memory_id, version, canonical_text, structured_data, created_at
      FROM memory_versions
      ORDER BY memory_id, version, created_at, id
    `).all() as LegacyVersionRow[];
    const events = database.prepare(`
      SELECT events.id, events.event_type, events.raw_content, events.structured_data,
             events.occurred_at, events.ingested_at, event_brains.brain_id,
             brains.name AS brain_name
      FROM events
      LEFT JOIN event_brains ON event_brains.event_id = events.id
      LEFT JOIN brains ON brains.id = event_brains.brain_id
      ORDER BY events.ingested_at, events.id
    `).all() as LegacyEventRow[];
    database.exec('COMMIT');
    return { memories, versions, events };
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original snapshot error.
    }
    throw error;
  }
}

function buildPlan(snapshot: LegacySnapshot, existing: readonly BrainRecord[], store: MarkdownRecordStore): {
  readonly records: readonly BrainRecord[];
  readonly brainNames: ReadonlyMap<string, string>;
  readonly skippedUnbound: number;
} {
  const existingByAtom = new Map(existing.filter((record) => 'brainId' in record && 'atomKey' in record).map((record) => [`${record.brainId}\u0000${record.atomKey}`, record]));
  const brainNames = new Map<string, string>();
  const records: BrainRecord[] = [];
  const versionsByMemory = new Map<string, LegacyVersionRow[]>();
  for (const version of snapshot.versions) {
    const list = versionsByMemory.get(version.memory_id) ?? [];
    list.push(version);
    versionsByMemory.set(version.memory_id, list);
  }

  let skippedUnbound = 0;
  const latestRecordByMemory = new Map<string, string>();
  for (const memory of snapshot.memories) {
    if (memory.brain_id === null || UuidV7Schema.safeParse(memory.brain_id).success === false) {
      skippedUnbound += 1;
      continue;
    }
    const brainId = UuidV7Schema.parse(memory.brain_id);
    if (memory.brain_name !== null && memory.brain_name.trim() !== '') brainNames.set(brainId, memory.brain_name);
    const kind = parseKind(memory.kind);
    const status = parseStatus(memory.status);
    const scope = parseScope(memory.scope_data);
    const sourceEventId = validUuid(memory.source_event_id);
    const versions = [...(versionsByMemory.get(memory.id) ?? [])].sort((left, right) => left.version - right.version || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
    let previousRecordId: string | undefined;
    if (versions.length === 0) {
      const record = semanticRecord({
        recordId: recordIdFor(existingByAtom, brainId, `legacy-memory:${memory.id}:base`),
        memory,
        brainId,
        kind,
        status,
        scope,
        sourceEventId,
        canonicalText: memory.canonical_text,
        structuredData: parseJson(memory.structured_data),
        createdAt: utc(memory.created_at),
        atomKey: `legacy-memory:${memory.id}:base`,
      });
      records.push(record);
      previousRecordId = record.recordId;
    } else {
      for (const [index, version] of versions.entries()) {
        const atomKey = `legacy-memory:${memory.id}:version:${version.version}`;
        const record = semanticRecord({
          recordId: recordIdFor(existingByAtom, brainId, atomKey, version.id, memory.id),
          memory,
          brainId,
          kind,
          status: index === versions.length - 1 ? status : 'superseded',
          scope,
          sourceEventId,
          canonicalText: version.canonical_text,
          structuredData: parseJson(version.structured_data),
          createdAt: utc(version.created_at),
          atomKey,
          ...(previousRecordId === undefined ? {} : { supersedesRecordId: previousRecordId }),
        });
        records.push(record);
        previousRecordId = record.recordId;
      }
    }
    latestRecordByMemory.set(memory.id, previousRecordId!);
    if (status === 'superseded' || memory.superseded_by !== null) {
      const tombstoneAtomKey = `legacy-memory:${memory.id}:tombstone`;
      records.push(tombstoneRecord({
        recordId: recordIdFor(existingByAtom, brainId, tombstoneAtomKey),
        memory,
        brainId,
        kind,
        createdAt: utc(memory.updated_at),
        supersedesRecordId: previousRecordId!,
        atomKey: tombstoneAtomKey,
        reason: memory.superseded_by === null ? 'Legacy memory was superseded.' : `Legacy memory superseded by ${memory.superseded_by}.`,
      }));
    }
  }

  for (const event of snapshot.events) {
    if (event.brain_id === null || UuidV7Schema.safeParse(event.brain_id).success === false) {
      continue;
    }
    const brainId = UuidV7Schema.parse(event.brain_id);
    if (event.brain_name !== null && event.brain_name.trim() !== '') brainNames.set(brainId, event.brain_name);
    const atomKey = `legacy-event:${event.id}`;
    const previous = existingByAtom.get(`${brainId}\u0000${atomKey}`);
    const eventMemoryId = validUuid(event.id)
      ?? (previous !== undefined && 'memoryId' in previous ? previous.memoryId : createUuidV7());
    const eventRecord = SemanticRecordSchema.parse({
      schemaVersion: '0.3',
      recordType: 'semantic',
      recordId: recordIdFor(existingByAtom, brainId, atomKey, event.id, eventMemoryId),
      memoryId: eventMemoryId,
      brainId,
      status: 'event_only',
      kind: 'event',
      createdAt: utc(event.occurred_at),
      updatedAt: utc(event.ingested_at),
      captureId: event.id,
      atomKey,
      sourceAtom: event.raw_content,
      canonicalText: event.raw_content,
      ...(event.structured_data === null ? {} : { structuredData: parseJson(event.structured_data) }),
    });
    records.push(eventRecord);
  }

  return { records, brainNames, skippedUnbound };
}

function semanticRecord(input: {
  readonly recordId: string;
  readonly memory: LegacyMemoryRow;
  readonly brainId: string;
  readonly kind: MemoryKind;
  readonly status: MemoryStatus;
  readonly scope: MemoryScope;
  readonly sourceEventId: string | undefined;
  readonly canonicalText: string;
  readonly structuredData: JsonValue;
  readonly createdAt: string;
  readonly atomKey: string;
  readonly supersedesRecordId?: string;
}): BrainRecord {
  return SemanticRecordSchema.parse({
    schemaVersion: '0.3',
    recordType: 'semantic',
    recordId: input.recordId,
    memoryId: input.memory.id,
    brainId: input.brainId,
    status: input.status,
    kind: input.kind,
    createdAt: input.createdAt,
    updatedAt: utc(input.memory.updated_at),
    captureId: input.sourceEventId ?? input.memory.id,
    atomKey: input.atomKey,
    sourceAtom: input.canonicalText,
    canonicalText: input.canonicalText,
    ...(input.memory.title === null ? {} : { title: input.memory.title }),
    scope: input.scope,
    priority: input.memory.priority,
    confidence: input.memory.confidence,
    explicitness: input.memory.explicitness,
    ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
    ...(input.memory.valid_from === null ? {} : { validFrom: input.memory.valid_from }),
    ...(input.memory.valid_until === null ? {} : { validUntil: input.memory.valid_until }),
    structuredData: input.structuredData,
    ...(input.supersedesRecordId === undefined ? {} : { supersedesRecordId: input.supersedesRecordId }),
  });
}

function tombstoneRecord(input: {
  readonly recordId: string;
  readonly memory: LegacyMemoryRow;
  readonly brainId: string;
  readonly kind: MemoryKind;
  readonly createdAt: string;
  readonly supersedesRecordId: string;
  readonly atomKey: string;
  readonly reason: string;
}): BrainRecord {
  return TombstoneRecordSchema.parse({
    schemaVersion: '0.3',
    recordType: 'tombstone',
    recordId: input.recordId,
    memoryId: input.memory.id,
    brainId: input.brainId,
    status: 'superseded',
    kind: input.kind,
    createdAt: input.createdAt,
    updatedAt: utc(input.memory.updated_at),
    captureId: input.memory.source_event_id ?? input.memory.id,
    atomKey: input.atomKey,
    supersedesRecordId: input.supersedesRecordId,
    reason: input.reason,
  });
}

function recordIdFor(existing: Map<string, BrainRecord>, brainId: string, atomKey: string, legacyId?: string, avoidId?: string): string {
  const previous = existing.get(`${brainId}\u0000${atomKey}`);
  if (previous !== undefined) return previous.recordId;
  if (legacyId !== undefined && legacyId !== avoidId && UuidV7Schema.safeParse(legacyId).success) return legacyId;
  return createUuidV7();
}

function hasEquivalentRecord(existing: readonly BrainRecord[], record: BrainRecord): boolean {
  return existing.some((candidate) => candidate.recordId === record.recordId && canonicalJson(candidate) === canonicalJson(record));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseKind(value: string): MemoryKind {
  const allowed = new Set<MemoryKind>(['policy', 'procedure', 'preference', 'fact', 'decision', 'capability', 'event']);
  if (!allowed.has(value as MemoryKind)) throw new Error(`legacy_schema_invalid: unsupported memory kind ${value}`);
  return value as MemoryKind;
}

function parseStatus(value: string): MemoryStatus {
  const allowed = new Set<MemoryStatus>(['candidate', 'active', 'event_only', 'superseded', 'expired', 'rejected', 'archived']);
  if (!allowed.has(value as MemoryStatus)) throw new Error(`legacy_schema_invalid: unsupported memory status ${value}`);
  return value as MemoryStatus;
}

function parseScope(value: string): MemoryScope {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (error) { throw new Error('legacy_schema_invalid: malformed scope JSON.', { cause: error }); }
  return MemoryScopeSchema.parse(parsed);
}

function parseJson(value: string): JsonValue {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (error) { throw new Error('legacy_schema_invalid: malformed structured data JSON.', { cause: error }); }
  return JsonValueSchema.parse(parsed);
}

function validUuid(value: string | null): string | undefined {
  return value !== null && UuidV7Schema.safeParse(value).success ? value : undefined;
}

function utc(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`legacy_schema_invalid: invalid timestamp ${value}`);
  return IsoUtcDateTimeSchema.parse(parsed.toISOString());
}

function absoluteRoot(value: string): string {
  if (!isAbsolute(value)) throw new Error('Storage rootDir must be absolute.');
  const root = resolve(value);
  mkdirSync(root, { recursive: true });
  return root;
}

function absolutePath(value: string): string {
  if (!isAbsolute(value)) throw new Error('Bootstrap lock path must be absolute.');
  return resolve(value);
}

function acquireLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  let descriptor: number | undefined;
  try {
    try {
      descriptor = openSync(path, 'wx', 0o600);
    } catch (error) {
      if (!isStaleLock(path)) {
        throw new Error('bootstrap_locked: another legacy bootstrap is running.', { cause: error });
      }
      unlinkSync(path);
      descriptor = openSync(path, 'wx', 0o600);
    }
    writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
    fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw new Error('bootstrap_locked: another legacy bootstrap is running.', { cause: error });
  }
  const heldDescriptor = descriptor;
  return () => {
    try { closeSync(heldDescriptor); } finally {
      if (existsSync(path)) unlinkSync(path);
    }
  };
}

function isStaleLock(path: string): boolean {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}
