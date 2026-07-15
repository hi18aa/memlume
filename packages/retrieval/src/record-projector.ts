import { createHash } from 'node:crypto';

import {
  MemoryItemSchema,
  SemanticRecordSchema,
  TombstoneRecordSchema,
  type BrainRecord,
  type MemoryStatus,
  type SemanticRecord,
  type TombstoneRecord,
} from '@memlume/contracts';
import type { SqliteDatabase } from '@memlume/database/internal';

export type ProjectableRecord = SemanticRecord | TombstoneRecord;

export type ProjectionInput = {
  readonly record: ProjectableRecord;
  readonly relativePath: string;
  readonly checksum: string;
};

export type ProjectionResult = {
  readonly recordId: string;
  readonly memoryId: string;
  readonly brainId: string;
  readonly status: MemoryStatus;
  readonly changed: boolean;
};

type ProjectionRow = {
  record_id: string;
  relative_path: string;
  checksum: string;
  memory_id: string | null;
  brain_id: string | null;
  supersedes_record_id: string | null;
};

type MemoryRow = {
  id: string;
  brain_id: string;
  created_at: string;
};

/**
 * Rebuildable SQLite read model for canonical Markdown records.
 * Markdown remains the authority; this class never writes to the record store.
 */
export class RecordProjector {
  constructor(private readonly database: SqliteDatabase) {}

  project(input: ProjectionInput | ProjectableRecord, relativePath?: string, checksum?: string): ProjectionResult {
    const normalized = isProjectionInput(input)
      ? input
      : { record: input, relativePath: relativePath ?? `${input.recordId}.md`, checksum: checksum ?? '' };
    return this.database.transaction(() => this.projectOne(normalized))();
  }

  projectRecords(inputs: readonly ProjectionInput[]): readonly ProjectionResult[] {
    const ordered = orderBySupersession(inputs);
    return this.database.transaction(() => ordered.map((input) => this.projectOne(input)))();
  }

  rebuild(inputs: readonly ProjectionInput[]): readonly ProjectionResult[] {
    return this.database.transaction(() => {
      this.clearProjectedRows();
      return orderBySupersession(inputs).map((input) => this.projectOne(input));
    })();
  }

  private projectOne(input: ProjectionInput): ProjectionResult {
    const record = parseProjectableRecord(input.record);
    const relativePath = normalizeRelativePath(input.relativePath);
    const checksum = normalizeChecksum(input.checksum);
    const existingProjection = this.database
      .prepare('SELECT record_id, relative_path, checksum, memory_id, brain_id, supersedes_record_id FROM record_projections WHERE record_id = ?')
      .get(record.recordId) as ProjectionRow | undefined;
    if (existingProjection !== undefined) {
      if (existingProjection.checksum !== checksum || existingProjection.relative_path !== relativePath) {
        throw new Error(`record_conflict: projection ${record.recordId} has different content or path.`);
      }
      return {
        recordId: record.recordId,
        memoryId: existingProjection.memory_id ?? record.memoryId,
        brainId: existingProjection.brain_id ?? record.brainId,
        status: record.status,
        changed: false,
      };
    }
    const existingPath = this.database
      .prepare('SELECT record_id, checksum FROM record_projections WHERE relative_path = ?')
      .get(relativePath) as { record_id: string; checksum: string } | undefined;
    if (existingPath !== undefined && existingPath.record_id !== record.recordId) {
      throw new Error(`record_conflict: path ${relativePath} is already bound to ${existingPath.record_id}.`);
    }

    const superseded = this.validateSupersession(record);
    this.ensureBrain(record.brainId);
    if (record.recordType === 'tombstone') {
      this.projectTombstone(record, superseded);
    } else {
      this.projectSemantic(record, superseded);
    }

    this.database
      .prepare(`
        INSERT INTO record_projections (
          record_id, relative_path, checksum, memory_id, brain_id, supersedes_record_id, projected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.recordId,
        relativePath,
        checksum,
        record.memoryId,
        record.brainId,
        record.supersedesRecordId ?? null,
        new Date().toISOString(),
      );

    return {
      recordId: record.recordId,
      memoryId: record.memoryId,
      brainId: record.brainId,
      status: record.status,
      changed: true,
    };
  }

  private validateSupersession(record: ProjectableRecord): ProjectionRow | undefined {
    if (record.supersedesRecordId === undefined) {
      return undefined;
    }
    if (record.supersedesRecordId === record.recordId) {
      throw new Error(`supersedes_cycle: record ${record.recordId} cannot supersede itself.`);
    }
    const target = this.database
      .prepare('SELECT record_id, relative_path, checksum, memory_id, brain_id, supersedes_record_id FROM record_projections WHERE record_id = ?')
      .get(record.supersedesRecordId) as ProjectionRow | undefined;
    if (target === undefined) {
      throw new Error(`supersedes_missing: record ${record.supersedesRecordId} is not projected yet.`);
    }
    if (target.brain_id !== record.brainId) {
      throw new Error(`cross_brain_supersession: ${record.recordId} cannot supersede a record in another Brain.`);
    }

    const visited = new Set<string>([record.recordId]);
    let cursor: ProjectionRow | undefined = target;
    while (cursor !== undefined) {
      if (visited.has(cursor.record_id)) {
        throw new Error(`supersedes_cycle: record ${record.recordId} creates a supersession cycle.`);
      }
      visited.add(cursor.record_id);
      if (cursor.supersedes_record_id === null) {
        break;
      }
      cursor = this.database
        .prepare('SELECT record_id, relative_path, checksum, memory_id, brain_id, supersedes_record_id FROM record_projections WHERE record_id = ?')
        .get(cursor.supersedes_record_id) as ProjectionRow | undefined;
    }
    return target;
  }

  private projectSemantic(record: SemanticRecord, superseded: ProjectionRow | undefined): void {
    this.ensureSourceEvent(record, record.sourceAtom);
    const existingMemory = this.database
      .prepare('SELECT memory_items.id, memory_brains.brain_id, memory_items.created_at FROM memory_items JOIN memory_brains ON memory_brains.memory_id = memory_items.id WHERE memory_items.id = ?')
      .get(record.memoryId) as MemoryRow | undefined;
    if (existingMemory !== undefined && existingMemory.brain_id !== record.brainId) {
      throw new Error(`cross_brain_memory: memory ${record.memoryId} is already bound to another Brain.`);
    }

    const structuredData = memoryStructuredData(record);
    const createdAt = existingMemory?.created_at ?? record.createdAt;
    const values = [
      record.memoryId,
      record.kind,
      null,
      record.canonicalText,
      JSON.stringify(structuredData),
      JSON.stringify({ level: 'global' }),
      record.status,
      0,
      1,
      1,
      record.recordId,
      createdAt,
      record.updatedAt,
      null,
      null,
      null,
    ] as const;
    if (existingMemory === undefined) {
      this.database
        .prepare(`
          INSERT INTO memory_items (
            id, kind, title, canonical_text, structured_data, scope_data, status, priority,
            confidence, explicitness, source_event_id, created_at, updated_at, valid_from,
            valid_until, superseded_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(...values);
      this.database
        .prepare('INSERT INTO memory_brains (memory_id, brain_id, created_at) VALUES (?, ?, ?)')
        .run(record.memoryId, record.brainId, createdAt);
    } else {
      this.database
        .prepare(`
          UPDATE memory_items
          SET kind = ?, title = ?, canonical_text = ?, structured_data = ?, scope_data = ?, status = ?,
              priority = ?, confidence = ?, explicitness = ?, source_event_id = ?, updated_at = ?,
              valid_from = ?, valid_until = ?, superseded_by = ?
          WHERE id = ?
        `)
        .run(
          record.kind,
          null,
          record.canonicalText,
          JSON.stringify(structuredData),
          JSON.stringify({ level: 'global' }),
          record.status,
          0,
          1,
          1,
          record.recordId,
          record.updatedAt,
          null,
          null,
          null,
          record.memoryId,
        );
    }

    if (superseded !== undefined && superseded.memory_id !== null && superseded.memory_id !== record.memoryId) {
      this.database
        .prepare('UPDATE memory_items SET status = ?, superseded_by = ?, updated_at = ? WHERE id = ?')
        .run('superseded', record.memoryId, record.updatedAt, superseded.memory_id);
      this.replaceSearch(superseded.memory_id, 'superseded');
    }
    this.replaceSearch(record.memoryId, record.status);
  }

  private projectTombstone(record: TombstoneRecord, superseded: ProjectionRow | undefined): void {
    if (superseded === undefined || superseded.memory_id === null) {
      throw new Error(`supersedes_missing: tombstone ${record.recordId} has no projected target.`);
    }
    if (superseded.memory_id !== record.memoryId) {
      throw new Error(`tombstone_memory_mismatch: ${record.recordId} does not identify its target memory.`);
    }
    this.ensureSourceEvent(record, record.reason);
    const target = this.database
      .prepare('SELECT id FROM memory_items WHERE id = ?')
      .get(record.memoryId) as { id: string } | undefined;
    if (target === undefined) {
      throw new Error(`memory_missing: tombstone target ${record.memoryId} is not projected.`);
    }
    this.database
      .prepare('UPDATE memory_items SET status = ?, superseded_by = NULL, updated_at = ? WHERE id = ?')
      .run('superseded', record.updatedAt, record.memoryId);
    this.replaceSearch(record.memoryId, 'superseded');
  }

  private ensureSourceEvent(record: ProjectableRecord, rawContent: string): void {
    const contentHash = createHash('sha256').update(rawContent, 'utf8').digest('hex');
    const existing = this.database
      .prepare('SELECT raw_content, content_hash FROM events WHERE id = ?')
      .get(record.recordId) as { raw_content: string; content_hash: string } | undefined;
    if (existing !== undefined) {
      if (existing.raw_content !== rawContent || existing.content_hash !== contentHash) {
        throw new Error(`record_conflict: source event ${record.recordId} has different content.`);
      }
    } else {
      this.database
        .prepare(`
          INSERT INTO events (
            id, event_type, raw_content, structured_data, source_type, source_agent, source_reference,
            source_data, occurred_at, ingested_at, processing_status, content_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          record.recordId,
          record.recordType,
          rawContent,
          'structuredData' in record && record.structuredData === undefined ? null : JSON.stringify('structuredData' in record ? record.structuredData : {}),
          'markdown',
          null,
          record.recordId,
          JSON.stringify({ captureId: record.captureId, atomKey: record.atomKey }),
          record.createdAt,
          record.updatedAt,
          'processed',
          contentHash,
        );
    }
    const binding = this.database
      .prepare('SELECT brain_id FROM event_brains WHERE event_id = ?')
      .get(record.recordId) as { brain_id: string } | undefined;
    if (binding !== undefined && binding.brain_id !== record.brainId) {
      throw new Error(`cross_brain_event: source event ${record.recordId} is already bound to another Brain.`);
    }
    if (binding === undefined) {
      this.database
        .prepare('INSERT INTO event_brains (event_id, brain_id, created_at) VALUES (?, ?, ?)')
        .run(record.recordId, record.brainId, record.updatedAt);
    }
  }

  private ensureBrain(brainId: string): void {
    const brain = this.database.prepare('SELECT 1 FROM brains WHERE id = ?').get(brainId);
    if (brain === undefined) {
      throw new Error(`brain_missing: Brain ${brainId} does not exist.`);
    }
  }

  private replaceSearch(memoryId: string, status: MemoryStatus): void {
    this.database.prepare('DELETE FROM memory_search WHERE memory_id = ?').run(memoryId);
    if (status !== 'active' && status !== 'candidate') {
      return;
    }
    const row = this.database
      .prepare('SELECT title, canonical_text FROM memory_items WHERE id = ?')
      .get(memoryId) as { title: string | null; canonical_text: string } | undefined;
    if (row === undefined) {
      return;
    }
    this.database
      .prepare(`
        INSERT INTO memory_search (memory_id, title, canonical_text, summary, keywords, entities, content)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(memoryId, row.title ?? '', row.canonical_text, row.canonical_text, '', '', row.canonical_text);
  }

  private clearProjectedRows(): void {
    const memoryIds = this.database
      .prepare('SELECT memory_id FROM record_projections WHERE memory_id IS NOT NULL')
      .pluck()
      .all() as string[];
    this.database.prepare('DELETE FROM record_projections').run();
    if (memoryIds.length === 0) {
      return;
    }
    const placeholders = memoryIds.map(() => '?').join(', ');
    this.database.prepare(`DELETE FROM memory_usage WHERE memory_id IN (${placeholders})`).run(...memoryIds);
    this.database.prepare(`DELETE FROM memory_relations WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`).run(...memoryIds, ...memoryIds);
    this.database.prepare(`DELETE FROM memory_versions WHERE memory_id IN (${placeholders})`).run(...memoryIds);
    this.database.prepare(`DELETE FROM memory_search WHERE memory_id IN (${placeholders})`).run(...memoryIds);
    this.database.prepare(`DELETE FROM memory_brains WHERE memory_id IN (${placeholders})`).run(...memoryIds);
    this.database.prepare(`DELETE FROM memory_items WHERE id IN (${placeholders})`).run(...memoryIds);
  }
}

export function projectRecords(database: SqliteDatabase, inputs: readonly ProjectionInput[]): readonly ProjectionResult[] {
  return new RecordProjector(database).projectRecords(inputs);
}

function parseProjectableRecord(input: BrainRecord): ProjectableRecord {
  if (input.recordType === 'semantic') {
    return SemanticRecordSchema.parse(input);
  }
  if (input.recordType === 'tombstone') {
    return TombstoneRecordSchema.parse(input);
  }
  throw new Error(`Unsupported authority record for SQLite projection: ${input.recordType}`);
}

function isProjectionInput(input: ProjectionInput | ProjectableRecord): input is ProjectionInput {
  return typeof input === 'object' && input !== null && 'record' in input && 'relativePath' in input && 'checksum' in input;
}

function normalizeRelativePath(value: string): string {
  const path = value.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (path.length === 0 || path === '..' || path.startsWith('../') || path.startsWith('/')) {
    throw new Error(`Invalid projection path: ${value}`);
  }
  return path;
}

function normalizeChecksum(value: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error('Invalid record checksum.');
  }
  return value;
}

function memoryStructuredData(record: SemanticRecord): unknown {
  const candidate = {
    id: record.memoryId,
    brainId: record.brainId,
    kind: record.kind,
    canonicalText: record.canonicalText,
    structuredData: record.structuredData,
    scope: { level: 'global' as const },
    status: record.status,
    priority: 0,
    confidence: 1,
    explicitness: 1,
    sourceEventId: record.recordId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.structuredData !== undefined && MemoryItemSchema.safeParse(candidate).success) {
    return record.structuredData;
  }
  switch (record.kind) {
    case 'policy':
      return { trigger: { intents: [record.atomKey] }, action: { type: 'prefer_strategy', target: record.canonicalText }, constraints: {} };
    case 'procedure':
      return { trigger: { intents: [record.atomKey] }, steps: [{ order: 1, action: record.canonicalText }] };
    case 'preference':
      return { domain: 'general', subject: record.atomKey, dimension: 'statement', value: record.canonicalText, strength: 1, confidence: 1 };
    case 'fact':
      return { subject: record.atomKey, predicate: 'statement', object: record.canonicalText, confidence: 1 };
    case 'decision':
      return { title: record.canonicalText, status: record.status, rationale: [record.canonicalText] };
    case 'capability':
      return { toolId: record.atomKey, intents: [record.atomKey], inputModalities: ['text'], outputModalities: ['text'], availability: 'unknown' };
    case 'event':
      return { event: record.canonicalText };
  }
}

function orderBySupersession(inputs: readonly ProjectionInput[]): ProjectionInput[] {
  const byId = new Map(inputs.map((input) => [input.record.recordId, input]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: ProjectionInput[] = [];
  const visit = (input: ProjectionInput): void => {
    const id = input.record.recordId;
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`supersedes_cycle: record ${id} creates a supersession cycle.`);
    visiting.add(id);
    const supersedes = input.record.supersedesRecordId;
    if (supersedes !== undefined) {
      const dependency = byId.get(supersedes);
      if (dependency !== undefined) visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(input);
  };
  for (const input of inputs) visit(input);
  return ordered;
}
