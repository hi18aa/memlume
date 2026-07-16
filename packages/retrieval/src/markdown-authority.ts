import {
  DEFAULT_PERSONAL_BRAIN_ID,
  MemoryItemSchema,
  NonEmptyTextSchema,
  UuidV7Schema,
  createUuidV7,
  type MemoryItem,
  type MemoryScope,
  type MemoryStatus,
} from '@memlume/contracts';
import type { SqliteDatabase } from '@memlume/database/internal';
import { MarkdownRecordStore, scanMarkdownRecords } from '@memlume/shared-brains';

import { RecordProjector } from './record-projector.js';
import { SourceEventBrainMismatchError } from './search.js';
import type {
  MemoryWriteAuthority,
  ReviewCandidateInput,
  SaveMemoryInput,
  UpdateMemoryInput,
} from './search.js';
import type { MemoryStore } from './search.js';

/**
 * The single semantic write path used by the daemon. Markdown append is
 * durable first; RecordProjector is the only component that writes the SQL
 * semantic read model.
 */
export class MarkdownMemoryAuthority implements MemoryWriteAuthority {
  private readonly records: MarkdownRecordStore;
  private readonly projector: RecordProjector;
  private readonly rootDir: string;

  constructor(
    private readonly database: SqliteDatabase,
    rootDir: string,
    private readonly query: MemoryStore,
  ) {
    this.rootDir = rootDir;
    this.records = new MarkdownRecordStore({ rootDir });
    this.projector = new RecordProjector(database);
  }

  save(input: SaveMemoryInput): MemoryItem {
    return this.persistNew(input, 'active');
  }

  saveCandidate(input: SaveMemoryInput): MemoryItem {
    return this.persistNew(input, 'candidate');
  }

  approveCandidate(id: string, input: ReviewCandidateInput, brainIds?: readonly string[]): MemoryItem {
    const allowedBrainIds = normalizeBrainIds(brainIds);
    const candidate = this.requireMemory(id, allowedBrainIds);
    if (candidate.status !== 'candidate') {
      throw new Error('Only candidate memories can be approved.');
    }
    const changedBy = NonEmptyTextSchema.parse(input.actor);
    const changeReason = NonEmptyTextSchema.parse(input.reason);
    const active = this.query.list({ brainIds: allowedBrainIds, status: 'active' });
    if (active.some((memory) =>
      memory.brainId === candidate.brainId &&
      memory.kind === candidate.kind &&
      sameScope(memory.scope, candidate.scope) &&
      sameCanonicalText(memory.canonicalText, candidate.canonicalText),
    )) {
      throw new Error('Candidate duplicates an active memory.');
    }
    const conflicting = active.filter((memory) =>
      memory.brainId === candidate.brainId &&
      memory.kind === candidate.kind &&
      sameScope(memory.scope, candidate.scope) &&
      sameSupersessionSubject(memory, candidate),
    );
    if (conflicting.some((memory) => memory.id !== input.supersedeMemoryId)) {
      throw new Error('Candidate conflicts with an active memory and must supersede the matching memory.');
    }
    let supersedesRecordId = this.latestRecordId(candidate.id);
    if (input.supersedeMemoryId !== undefined) {
      const existing = this.requireMemory(input.supersedeMemoryId, allowedBrainIds);
      if (
        existing.status !== 'active' ||
        existing.brainId !== candidate.brainId ||
        existing.kind !== candidate.kind ||
        !sameScope(existing.scope, candidate.scope) ||
        !sameSupersessionSubject(existing, candidate)
      ) {
        throw new Error('Candidate can only supersede an active memory with the same subject in the same brain, kind, and scope.');
      }
      supersedesRecordId = this.latestRecordId(existing.id);
    }
    const now = new Date().toISOString();
    const approved = MemoryItemSchema.parse({ ...candidate, status: 'active', updatedAt: now });
    const projected = this.persistRecord(memoryRecord(approved, {
      supersedesRecordId,
    }));
    if (projected) {
      this.appendVersion(candidate, changedBy, changeReason, now);
      if (input.supersedeMemoryId !== undefined) {
        const existing = this.requireMemory(input.supersedeMemoryId, allowedBrainIds);
        this.appendVersion(existing, changedBy, changeReason, now);
      }
    }
    return this.requireMemory(approved.id, [approved.brainId]);
  }

  rejectCandidate(id: string, input: Omit<ReviewCandidateInput, 'supersedeMemoryId'>, brainIds?: readonly string[]): MemoryItem {
    const allowedBrainIds = normalizeBrainIds(brainIds);
    const candidate = this.requireMemory(id, allowedBrainIds);
    if (candidate.status !== 'candidate') {
      throw new Error('Only candidate memories can be rejected.');
    }
    const changedBy = NonEmptyTextSchema.parse(input.actor);
    const changeReason = NonEmptyTextSchema.parse(input.reason);
    const rejected = MemoryItemSchema.parse({ ...candidate, status: 'rejected', updatedAt: new Date().toISOString() });
    const projected = this.persistRecord(memoryRecord(rejected, {
      supersedesRecordId: this.latestRecordId(candidate.id),
    }));
    if (projected) {
      this.appendVersion(candidate, changedBy, changeReason, rejected.updatedAt);
    }
    return this.requireMemory(rejected.id, [rejected.brainId]);
  }

  update(id: string, input: UpdateMemoryInput, brainIds?: readonly string[]): MemoryItem {
    const existing = this.requireMemory(id, normalizeBrainIds(brainIds));
    if (!isManualMemoryKind(existing.kind) || existing.status !== 'active') {
      throw new Error('Only active manual memories can be updated.');
    }
    const { actor, reason, ...unsafeChanges } = input;
    const { brainId: _ignoredBrainId, ...changes } = unsafeChanges as typeof unsafeChanges & { readonly brainId?: unknown };
    const changedBy = NonEmptyTextSchema.parse(actor);
    const changeReason = NonEmptyTextSchema.parse(reason);
    const updated = MemoryItemSchema.parse({
      ...existing,
      ...changes,
      id: existing.id,
      kind: existing.kind,
      status: 'active',
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    });
    const projected = this.persistRecord(memoryRecord(updated, {
      supersedesRecordId: this.latestRecordId(existing.id),
    }));
    if (projected) {
      this.appendVersion(existing, changedBy, changeReason, updated.updatedAt);
    }
    return this.requireMemory(updated.id, [updated.brainId]);
  }

  private persistNew(input: SaveMemoryInput, status: Extract<MemoryStatus, 'active' | 'candidate'>): MemoryItem {
    if (!isManualMemoryKind(input.kind)) {
      throw new Error('Manual memory must be a policy, preference, fact, or decision.');
    }
    const brainId = UuidV7Schema.parse(input.brainId);
    const retry = this.findRetry(input, brainId, status);
    if (retry !== undefined) {
      return retry;
    }
    const now = new Date().toISOString();
    const memory = MemoryItemSchema.parse({
      id: createUuidV7(),
      ...input,
      brainId,
      status,
      priority: input.priority ?? 0,
      confidence: input.confidence ?? 1,
      explicitness: input.explicitness ?? 1,
      createdAt: now,
      updatedAt: now,
    });
    this.ensureBrain(memory.brainId);
    this.ensureSourceEvent(memory);
    this.persistRecord(memoryRecord(memory));
    return this.requireMemory(memory.id, [memory.brainId]);
  }

  private findRetry(
    input: SaveMemoryInput,
    brainId: string,
    status: Extract<MemoryStatus, 'active' | 'candidate'>,
  ): MemoryItem | undefined {
    if (input.sourceEventId === undefined) {
      return undefined;
    }
    const sourceEventId = UuidV7Schema.parse(input.sourceEventId);
    return this.query.list({ brainIds: [brainId], status }).find((memory) =>
      memory.sourceEventId === sourceEventId &&
      memory.kind === input.kind &&
      sameScope(memory.scope, input.scope) &&
      sameCanonicalText(memory.canonicalText, input.canonicalText),
    );
  }

  private persistRecord(record: ReturnType<typeof memoryRecord>): boolean {
    this.records.ensureBrainDocument(record.brainId);
    this.records.append(record);
    const scanned = scanMarkdownRecords(this.recordsRoot()).find((item) => item.record.recordId === record.recordId);
    if (scanned === undefined) {
      throw new Error(`markdown_authority_missing: record ${record.recordId} was not readable after append.`);
    }
    return this.projector.project(scanned).changed;
  }

  private recordsRoot(): string {
    // MarkdownRecordStore intentionally does not expose its root; the scanner
    // receives the same root captured at construction by this closure.
    return this.rootDir;
  }

  private requireMemory(id: string, brainIds: readonly string[]): MemoryItem {
    const memory = this.query.get(id, brainIds);
    if (memory === undefined) {
      throw new Error(`Memory not found: ${id}`);
    }
    return memory;
  }

  private latestRecordId(memoryId: string): string {
    const row = this.database
      .prepare('SELECT record_id FROM record_projections WHERE memory_id = ? ORDER BY projected_at DESC, rowid DESC LIMIT 1')
      .get(UuidV7Schema.parse(memoryId)) as { record_id: string } | undefined;
    if (row === undefined) {
      throw new Error(`markdown_authority_missing: no record projection for memory ${memoryId}.`);
    }
    return UuidV7Schema.parse(row.record_id);
  }

  private ensureBrain(brainId: string): void {
    if (this.database.prepare('SELECT 1 FROM brains WHERE id = ?').get(brainId) === undefined) {
      throw new Error(`brain_missing: Brain ${brainId} does not exist.`);
    }
  }

  private ensureSourceEvent(memory: MemoryItem): void {
    if (memory.sourceEventId === undefined) return;
    if (this.database.prepare('SELECT 1 FROM event_brains WHERE event_id = ? AND brain_id = ?').get(memory.sourceEventId, memory.brainId) === undefined) {
      throw new SourceEventBrainMismatchError();
    }
  }

  private appendVersion(memory: MemoryItem, changedBy: string, changeReason: string, createdAt: string): void {
    const version = (
      this.database
        .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM memory_versions WHERE memory_id = ?')
        .get(memory.id) as { version: number }
    ).version;
    this.database
      .prepare(`
        INSERT INTO memory_versions (
          id, memory_id, version, canonical_text, structured_data, changed_by, change_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        createUuidV7(),
        memory.id,
        version,
        memory.canonicalText,
        JSON.stringify(memory.structuredData),
        changedBy,
        changeReason,
        createdAt,
      );
  }
}

function memoryRecord(memory: MemoryItem, options: { readonly supersedesRecordId?: string; readonly sourceAtom?: string } = {}) {
  return {
    schemaVersion: '0.3',
    recordType: 'semantic' as const,
    recordId: createUuidV7(),
    memoryId: memory.id,
    brainId: memory.brainId,
    status: memory.status,
    kind: memory.kind,
    createdAt: new Date().toISOString(),
    updatedAt: memory.updatedAt,
    captureId: memory.sourceEventId ?? memory.id,
    atomKey: `${memory.kind}:${memory.id}`,
    sourceAtom: options.sourceAtom ?? memory.canonicalText,
    canonicalText: memory.canonicalText,
    ...(memory.title === undefined ? {} : { title: memory.title }),
    scope: memory.scope,
    priority: memory.priority,
    confidence: memory.confidence,
    explicitness: memory.explicitness,
    ...(memory.sourceEventId === undefined ? {} : { sourceEventId: memory.sourceEventId }),
    ...(memory.validFrom === undefined ? {} : { validFrom: memory.validFrom }),
    ...(memory.validUntil === undefined ? {} : { validUntil: memory.validUntil }),
    structuredData: memory.structuredData,
    ...(options.supersedesRecordId === undefined ? {} : { supersedesRecordId: UuidV7Schema.parse(options.supersedesRecordId) }),
  };
}

function normalizeBrainIds(brainIds: readonly string[] | undefined): readonly string[] {
  return brainIds === undefined
    ? [DEFAULT_PERSONAL_BRAIN_ID]
    : brainIds.map((brainId) => UuidV7Schema.parse(brainId));
}

function isManualMemoryKind(kind: string): kind is SaveMemoryInput['kind'] {
  return kind === 'policy' || kind === 'preference' || kind === 'fact' || kind === 'decision';
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameCanonicalText(left: string, right: string): boolean {
  return left.trim().replace(/\s+/gu, ' ').replace(/[。.!！?？]+$/gu, '').toLowerCase() ===
    right.trim().replace(/\s+/gu, ' ').replace(/[。.!！?？]+$/gu, '').toLowerCase();
}

function sameSupersessionSubject(left: MemoryItem, right: MemoryItem): boolean {
  const leftData: Record<string, unknown> | undefined = isRecord(left.structuredData) ? left.structuredData : undefined;
  const rightData: Record<string, unknown> | undefined = isRecord(right.structuredData) ? right.structuredData : undefined;
  if (left.kind !== right.kind || leftData === undefined || rightData === undefined) return false;
  const fields = left.kind === 'fact'
    ? ['subject', 'predicate']
    : left.kind === 'preference'
      ? ['domain', 'subject', 'dimension']
      : [];
  return fields.length > 0 && fields.every((field) => leftData[field] === rightData[field]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
