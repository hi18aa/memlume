import {
  DEFAULT_PERSONAL_BRAIN_ID,
  MemoryItemSchema,
  MemoryKindSchema,
  MemoryScopeSchema,
  MemoryStatusSchema,
  NonEmptyTextSchema,
  UuidV7Schema,
  createUuidV7,
  type JsonValue,
  type MemoryItem,
  type MemoryKind,
  type MemoryScope,
  type MemoryStatus,
} from '@memlume/contracts';
import type { SqliteDatabase } from '@memlume/database/internal';

import { MarkdownMemoryAuthority } from './markdown-authority.js';

const manualMemoryKinds = ['policy', 'preference', 'fact', 'decision'] as const;
const scopeLevels = ['global', 'domain', 'agent', 'workspace', 'project', 'task'] as const;
const scopeFields = ['domain', 'agentId', 'workspace', 'projectId', 'taskId'] as const;

export type ManualMemoryKind = (typeof manualMemoryKinds)[number];

export interface SaveMemoryInput {
  readonly brainId?: string;
  readonly kind: ManualMemoryKind;
  readonly canonicalText: string;
  readonly structuredData: JsonValue;
  readonly scope: MemoryScope;
  readonly title?: string;
  readonly priority?: number;
  readonly confidence?: number;
  readonly explicitness?: number;
  readonly sourceEventId?: string;
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly supersededBy?: string;
}

export type UpdateMemoryInput = Partial<Omit<SaveMemoryInput, 'brainId' | 'kind'>> & {
  readonly actor: string;
  readonly reason: string;
};

export interface ReviewCandidateInput {
  readonly actor: string;
  readonly reason: string;
  readonly supersedeMemoryId?: string;
}

export interface MemoryWriteAuthority {
  save(input: SaveMemoryInput): MemoryItem;
  saveCandidate(input: SaveMemoryInput): MemoryItem;
  approveCandidate(id: string, input: ReviewCandidateInput, brainIds?: readonly string[]): MemoryItem;
  rejectCandidate(id: string, input: Omit<ReviewCandidateInput, 'supersedeMemoryId'>, brainIds?: readonly string[]): MemoryItem;
  update(id: string, input: UpdateMemoryInput, brainIds?: readonly string[]): MemoryItem;
}

export interface MemoryStoreOptions {
  readonly authority?: MemoryWriteAuthority;
  readonly markdownRoot?: string;
  /**
   * Compatibility switch for v0.2 fixtures. Production instances must use
   * `authority`/`markdownRoot`; this switch will be removed after migration.
   */
  readonly allowLegacyWrites?: boolean;
}

export interface MemoryQuery {
  readonly brainIds?: readonly string[];
  readonly scope?: MemoryScope;
  readonly status?: MemoryStatus;
  readonly kinds?: readonly MemoryKind[];
}

export interface MemoryVersion {
  readonly id: string;
  readonly memoryId: string;
  readonly version: number;
  readonly canonicalText: string;
  readonly structuredData: JsonValue;
  readonly changedBy: string;
  readonly changeReason: string;
  readonly createdAt: string;
}

export class SourceEventBrainMismatchError extends Error {
  constructor() {
    super('Source event is not available in the selected brain.');
    this.name = 'SourceEventBrainMismatchError';
  }
}

type MemoryRow = {
  id: string;
  kind: MemoryKind;
  title: string | null;
  canonical_text: string;
  structured_data: string;
  scope_data: string;
  status: MemoryStatus;
  priority: number;
  confidence: number;
  explicitness: number;
  source_event_id: string | null;
  created_at: string;
  updated_at: string;
  valid_from: string | null;
  valid_until: string | null;
  superseded_by: string | null;
  brain_id: string;
};

type MemoryVersionRow = {
  id: string;
  memory_id: string;
  version: number;
  canonical_text: string;
  structured_data: string;
  changed_by: string;
  change_reason: string;
  created_at: string;
};

const memoryColumns = `
  id,
  kind,
  title,
  canonical_text,
  structured_data,
  scope_data,
  status,
  priority,
  confidence,
  explicitness,
  source_event_id,
  created_at,
  updated_at,
  valid_from,
  valid_until,
  superseded_by
`;
const memoryItemColumns = memoryColumns
  .split(',')
  .map((column) => `memory_items.${column.trim()}`)
  .join(', ');
const memorySelectColumns = `${memoryItemColumns}, memory_brains.brain_id`;
const memoryFrom = 'FROM memory_items JOIN memory_brains ON memory_brains.memory_id = memory_items.id';

export class MemoryStore {
  private readonly authority?: MemoryWriteAuthority;
  private readonly allowLegacyWrites: boolean;

  constructor(private readonly database: SqliteDatabase, options: MemoryStoreOptions = {}) {
    if (options.authority !== undefined && options.markdownRoot !== undefined) {
      throw new Error('MemoryStore accepts either authority or markdownRoot, not both.');
    }
    this.authority = options.authority ?? (options.markdownRoot === undefined
      ? undefined
      : new MarkdownMemoryAuthority(database, options.markdownRoot, this));
    // SQLite is a rebuildable read model. Legacy writes remain available only
    // to explicit v0.2 callers while authority-backed instances write Markdown.
    this.allowLegacyWrites = options.allowLegacyWrites ?? false;
  }

  save(input: SaveMemoryInput): MemoryItem {
    if (this.authority !== undefined) {
      return this.authority.save(input);
    }
    return this.saveWithStatus(input, 'active');
  }

  saveCandidate(input: SaveMemoryInput): MemoryItem {
    if (this.authority !== undefined) {
      return this.authority.saveCandidate(input);
    }
    return this.saveWithStatus(input, 'candidate');
  }

  approveCandidate(id: string, input: ReviewCandidateInput, brainIds?: readonly string[]): MemoryItem {
    if (this.authority !== undefined) {
      return this.authority.approveCandidate(id, input, brainIds);
    }
    this.assertLegacyWriter();
    const allowedBrainIds = normalizeBrainIds(brainIds);
    const candidate = this.getStored(id, allowedBrainIds);
    if (candidate === undefined) {
      throw new Error(`Memory not found: ${id}`);
    }
    if (candidate.status !== 'candidate') {
      throw new Error('Only candidate memories can be approved.');
    }
    const changedBy = NonEmptyTextSchema.parse(input.actor);
    const changeReason = NonEmptyTextSchema.parse(input.reason);
    const now = new Date().toISOString();
    const approved = MemoryItemSchema.parse({ ...candidate, status: 'active', updatedAt: now });

    this.database.transaction(() => {
      const active = this.list({ brainIds: allowedBrainIds, status: 'active' });
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
      this.insertVersion(candidate, changedBy, changeReason, now);
      if (input.supersedeMemoryId !== undefined) {
        const existing = this.getStored(input.supersedeMemoryId, allowedBrainIds);
        if (
          existing === undefined ||
          existing.status !== 'active' ||
          existing.brainId !== candidate.brainId ||
          existing.kind !== candidate.kind ||
          !sameScope(existing.scope, candidate.scope) ||
          !sameSupersessionSubject(existing, candidate)
        ) {
          throw new Error('Candidate can only supersede an active memory with the same subject in the same brain, kind, and scope.');
        }
        this.insertVersion(existing, changedBy, changeReason, now);
        this.replace(MemoryItemSchema.parse({
          ...existing,
          status: 'superseded',
          supersededBy: candidate.id,
          updatedAt: now,
        }));
      }
      this.replace(approved);
    }).immediate();
    return approved;
  }

  rejectCandidate(id: string, input: Omit<ReviewCandidateInput, 'supersedeMemoryId'>, brainIds?: readonly string[]): MemoryItem {
    if (this.authority !== undefined) {
      return this.authority.rejectCandidate(id, input, brainIds);
    }
    this.assertLegacyWriter();
    const candidate = this.getStored(id, normalizeBrainIds(brainIds));
    if (candidate === undefined) {
      throw new Error(`Memory not found: ${id}`);
    }
    if (candidate.status !== 'candidate') {
      throw new Error('Only candidate memories can be rejected.');
    }
    const changedBy = NonEmptyTextSchema.parse(input.actor);
    const changeReason = NonEmptyTextSchema.parse(input.reason);
    const now = new Date().toISOString();
    const rejected = MemoryItemSchema.parse({ ...candidate, status: 'rejected', updatedAt: now });
    this.database.transaction(() => {
      this.insertVersion(candidate, changedBy, changeReason, now);
      this.replace(rejected);
    }).immediate();
    return rejected;
  }

  listHistory(id: string, brainIds?: readonly string[]): MemoryItem[] {
    const memoryId = UuidV7Schema.parse(id);
    const memories = this.list({ brainIds });
    const byId = new Map(memories.map((memory) => [memory.id, memory]));
    const selected = byId.get(memoryId);
    if (selected === undefined) {
      return [];
    }
    let oldest: MemoryItem = selected;
    const ancestors = new Set<string>();
    while (!ancestors.has(oldest.id)) {
      ancestors.add(oldest.id);
      const predecessor = memories.find((memory) => memory.supersededBy === oldest.id);
      if (predecessor === undefined) {
        break;
      }
      oldest = predecessor;
    }

    const history: MemoryItem[] = [];
    let current: MemoryItem | undefined = oldest;
    const path = new Set<string>();
    while (current !== undefined && !path.has(current.id)) {
      path.add(current.id);
      history.push(current);
      current = current.supersededBy === undefined ? undefined : byId.get(current.supersededBy);
    }
    return history;
  }

  private saveWithStatus(input: SaveMemoryInput, status: 'active' | 'candidate'): MemoryItem {
    this.assertLegacyWriter();
    if (!isManualMemoryKind(input.kind)) {
      throw new Error('Manual memory must be a policy, preference, fact, or decision.');
    }

    const now = new Date().toISOString();
    const memory = MemoryItemSchema.parse({
      id: createUuidV7(),
      ...input,
      status,
      priority: input.priority ?? 0,
      confidence: input.confidence ?? 1,
      explicitness: input.explicitness ?? 1,
      createdAt: now,
      updatedAt: now,
    });

    this.database.transaction(() => {
      this.ensureSourceEventBelongsToBrain(memory);
      this.insert(memory);
    }).immediate();
    return memory;
  }

  update(id: string, input: UpdateMemoryInput, brainIds?: readonly string[]): MemoryItem {
    if (this.authority !== undefined) {
      return this.authority.update(id, input, brainIds);
    }
    this.assertLegacyWriter();
    const existing = this.getStored(id, normalizeBrainIds(brainIds));
    if (!existing) {
      throw new Error(`Memory not found: ${id}`);
    }
    if (!isManualMemoryKind(existing.kind) || existing.status !== 'active') {
      throw new Error('Only active manual memories can be updated.');
    }
    const { actor, reason, ...unsafeChanges } = input;
    const { brainId: _, ...changes } = unsafeChanges as typeof unsafeChanges & { readonly brainId?: unknown };
    const changedBy = NonEmptyTextSchema.parse(actor);
    const changeReason = NonEmptyTextSchema.parse(reason);
    const now = new Date().toISOString();

    const updated = MemoryItemSchema.parse({
      ...existing,
      ...changes,
      id: existing.id,
      kind: existing.kind,
      status: 'active',
      createdAt: existing.createdAt,
      updatedAt: now,
    });

    this.database.transaction(() => {
      this.insertVersion(existing, changedBy, changeReason, now);
      this.replace(updated);
    }).immediate();
    return updated;
  }

  listVersions(id: string, brainIds?: readonly string[]): MemoryVersion[] {
    const allowedBrainIds = normalizeBrainIds(brainIds);
    if (allowedBrainIds.length === 0) {
      return [];
    }
    const rows = this.database
      .prepare(`
        SELECT memory_versions.id, memory_versions.memory_id, version, canonical_text, structured_data,
               changed_by, change_reason, memory_versions.created_at
        FROM memory_versions
        JOIN memory_brains ON memory_brains.memory_id = memory_versions.memory_id
        WHERE memory_versions.memory_id = ? AND ${brainFilter(allowedBrainIds)}
        ORDER BY memory_versions.version
      `)
      .all(UuidV7Schema.parse(id), ...allowedBrainIds) as MemoryVersionRow[];
    return rows.map(toMemoryVersion);
  }

  get(id: string, brainIds?: readonly string[]): MemoryItem | undefined {
    const allowedBrainIds = normalizeBrainIds(brainIds);
    if (allowedBrainIds.length === 0) {
      return undefined;
    }
    const row = this.database
      .prepare(`
        SELECT ${memorySelectColumns} ${memoryFrom}
        WHERE memory_items.id = ? AND ${brainFilter(allowedBrainIds)}
      `)
      .get(UuidV7Schema.parse(id), ...allowedBrainIds) as MemoryRow | undefined;
    return row === undefined ? undefined : toMemoryItem(row);
  }

  list(filters: MemoryQuery = {}): MemoryItem[] {
    const query = normalizeQuery(filters);
    if (query.brainIds!.length === 0) {
      return [];
    }
    const { where, values } = sqlFilters(query);
    const rows = this.database
      .prepare(`SELECT ${memorySelectColumns} ${memoryFrom}${where} ORDER BY memory_items.updated_at DESC, memory_items.id`)
      .all(...values) as MemoryRow[];

    return rows.map(toMemoryItem).filter((memory) => matchesQuery(memory, query));
  }

  search(queryText: string, filters: MemoryQuery = {}): MemoryItem[] {
    const ftsQuery = toFtsQuery(queryText);
    const query = normalizeQuery(filters);
    if (query.brainIds!.length === 0) {
      return [];
    }
    const { where, values } = sqlFilters(query, 'memory_items');
    const rows = this.database
      .prepare(`
        SELECT ${memorySelectColumns}
        FROM memory_search
        JOIN memory_items ON memory_items.id = memory_search.memory_id
        JOIN memory_brains ON memory_brains.memory_id = memory_items.id
        WHERE memory_search MATCH ?${where === '' ? '' : ` AND ${where.slice(' WHERE '.length)}`}
        ORDER BY bm25(memory_search), memory_items.id
      `)
      .all(ftsQuery, ...values) as MemoryRow[];

    return rows.map(toMemoryItem).filter((memory) => matchesQuery(memory, query));
  }

  findApplicable(scope: MemoryScope, filters: MemoryQuery = {}): MemoryItem[] {
    const requestedScope = MemoryScopeSchema.parse(scope);
    return this.list(filters)
      .filter((memory) => isScopeApplicable(memory.scope, requestedScope))
      .sort(compareMemorySpecificity);
  }

  private insert(memory: MemoryItem): void {
    this.database
      .prepare(`
        INSERT INTO memory_items (
          id, kind, title, canonical_text, structured_data, scope_data, status, priority,
          confidence, explicitness, source_event_id, created_at, updated_at, valid_from,
          valid_until, superseded_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(...memoryValues(memory));
    this.database
      .prepare('INSERT INTO memory_brains (memory_id, brain_id, created_at) VALUES (?, ?, ?)')
      .run(memory.id, memory.brainId, memory.createdAt);
    this.replaceSearch(memory);
  }

  private ensureSourceEventBelongsToBrain(memory: MemoryItem): void {
    if (memory.sourceEventId === undefined) {
      return;
    }
    const sourceEvent = this.database
      .prepare('SELECT 1 FROM event_brains WHERE event_id = ? AND brain_id = ?')
      .get(memory.sourceEventId, memory.brainId);
    if (sourceEvent === undefined) {
      throw new SourceEventBrainMismatchError();
    }
  }

  private getStored(id: string, brainIds: readonly string[]): MemoryItem | undefined {
    if (brainIds.length === 0) {
      return undefined;
    }
    const row = this.database
      .prepare(`SELECT ${memorySelectColumns} ${memoryFrom} WHERE memory_items.id = ? AND ${brainFilter(brainIds)}`)
      .get(UuidV7Schema.parse(id), ...brainIds) as MemoryRow | undefined;
    return row === undefined ? undefined : toMemoryItem(row);
  }

  private replace(memory: MemoryItem): void {
    this.database
      .prepare(`
        UPDATE memory_items
        SET title = ?, canonical_text = ?, structured_data = ?, scope_data = ?, status = ?, priority = ?,
            confidence = ?, explicitness = ?, source_event_id = ?, updated_at = ?, valid_from = ?,
            valid_until = ?, superseded_by = ?
        WHERE id = ?
      `)
      .run(
        memory.title ?? null,
        memory.canonicalText,
        JSON.stringify(memory.structuredData),
        JSON.stringify(memory.scope),
        memory.status,
        memory.priority,
        memory.confidence,
        memory.explicitness,
        memory.sourceEventId ?? null,
        memory.updatedAt,
        memory.validFrom ?? null,
        memory.validUntil ?? null,
        memory.supersededBy ?? null,
        memory.id,
      );
    this.replaceSearch(memory);
  }

  private insertVersion(memory: MemoryItem, changedBy: string, changeReason: string, createdAt: string): void {
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

  private replaceSearch(memory: MemoryItem): void {
    this.database.prepare('DELETE FROM memory_search WHERE memory_id = ?').run(memory.id);
    this.database
      .prepare(`
        INSERT INTO memory_search (memory_id, title, canonical_text, summary, keywords, entities, content)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(memory.id, memory.title ?? '', memory.canonicalText, memory.canonicalText, '', '', memory.canonicalText);
  }

  private assertLegacyWriter(): void {
    if (!this.allowLegacyWrites) {
      throw new Error('markdown_authority_required: semantic writes must use Markdown authority.');
    }
  }
}

export function isScopeApplicable(memoryScope: MemoryScope, requestedScope: MemoryScope): boolean {
  const memory = MemoryScopeSchema.parse(memoryScope) as Record<string, unknown>;
  const requested = MemoryScopeSchema.parse(requestedScope) as Record<string, unknown>;

  return scopeFields.every(
    (field) => !Object.hasOwn(memory, field) || memory[field] === requested[field],
  );
}

export function scopeSpecificity(scope: MemoryScope): number {
  return scopeLevels.indexOf(MemoryScopeSchema.parse(scope).level);
}

export function compareMemorySpecificity(left: MemoryItem, right: MemoryItem): number {
  return (
    scopeSpecificity(right.scope) - scopeSpecificity(left.scope) ||
    right.priority - left.priority ||
    left.id.localeCompare(right.id)
  );
}

function isManualMemoryKind(kind: unknown): kind is ManualMemoryKind {
  return typeof kind === 'string' && manualMemoryKinds.includes(kind as ManualMemoryKind);
}

function memoryValues(memory: MemoryItem): readonly unknown[] {
  return [
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
  ];
}

function toMemoryItem(row: MemoryRow): MemoryItem {
  return MemoryItemSchema.parse({
    id: row.id,
    brainId: row.brain_id,
    kind: row.kind,
    title: row.title ?? undefined,
    canonicalText: row.canonical_text,
    structuredData: JSON.parse(row.structured_data),
    scope: JSON.parse(row.scope_data),
    status: row.status,
    priority: row.priority,
    confidence: row.confidence,
    explicitness: row.explicitness,
    sourceEventId: row.source_event_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    validFrom: row.valid_from ?? undefined,
    validUntil: row.valid_until ?? undefined,
    supersededBy: row.superseded_by ?? undefined,
  });
}

function toMemoryVersion(row: MemoryVersionRow): MemoryVersion {
  return {
    id: UuidV7Schema.parse(row.id),
    memoryId: UuidV7Schema.parse(row.memory_id),
    version: row.version,
    canonicalText: row.canonical_text,
    structuredData: JSON.parse(row.structured_data) as JsonValue,
    changedBy: NonEmptyTextSchema.parse(row.changed_by),
    changeReason: NonEmptyTextSchema.parse(row.change_reason),
    createdAt: row.created_at,
  };
}

function normalizeQuery(filters: MemoryQuery): MemoryQuery {
  return {
    brainIds: normalizeBrainIds(filters.brainIds),
    scope: filters.scope === undefined ? undefined : MemoryScopeSchema.parse(filters.scope),
    status: filters.status === undefined ? undefined : MemoryStatusSchema.parse(filters.status),
    kinds: filters.kinds === undefined ? undefined : filters.kinds.map((kind) => MemoryKindSchema.parse(kind)),
  };
}

function sqlFilters(filters: MemoryQuery, tableName = ''): { where: string; values: unknown[] } {
  const prefix = tableName === '' ? '' : `${tableName}.`;
  const clauses: string[] = [];
  const values: unknown[] = [];
  const brainIds = filters.brainIds!;
  clauses.push(brainFilter(brainIds));
  values.push(...brainIds);
  if (filters.status !== undefined) {
    clauses.push(`${prefix}status = ?`);
    values.push(filters.status);
  }
  if (filters.kinds !== undefined && filters.kinds.length > 0) {
    clauses.push(`${prefix}kind IN (${filters.kinds.map(() => '?').join(', ')})`);
    values.push(...filters.kinds);
  }
  return { where: clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`, values };
}

function normalizeBrainIds(brainIds: readonly string[] | undefined): readonly string[] {
  return brainIds === undefined
    ? [DEFAULT_PERSONAL_BRAIN_ID]
    : brainIds.map((brainId) => UuidV7Schema.parse(brainId));
}

function brainFilter(brainIds: readonly string[]): string {
  return `memory_brains.brain_id IN (${brainIds.map(() => '?').join(', ')})`;
}

function matchesQuery(memory: MemoryItem, filters: MemoryQuery): boolean {
  return (
    (filters.status === undefined || memory.status === filters.status) &&
    (filters.kinds === undefined || filters.kinds.includes(memory.kind)) &&
    (filters.scope === undefined || sameScope(memory.scope, filters.scope))
  );
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  const leftScope = left as Record<string, unknown>;
  const rightScope = right as Record<string, unknown>;
  return (
    left.level === right.level &&
    scopeFields.every(
      (field) => Object.hasOwn(leftScope, field) === Object.hasOwn(rightScope, field) && leftScope[field] === rightScope[field],
    )
  );
}

function sameCanonicalText(left: string, right: string): boolean {
  return left.trim().replace(/\s+/gu, ' ').replace(/[。.!！?？]+$/gu, '').toLowerCase() ===
    right.trim().replace(/\s+/gu, ' ').replace(/[。.!！?？]+$/gu, '').toLowerCase();
}

function sameSupersessionSubject(left: MemoryItem, right: MemoryItem): boolean {
  if (!isRecord(left.structuredData) || !isRecord(right.structuredData)) {
    return false;
  }
  if (left.kind === 'fact' && right.kind === 'fact') {
    return sameSemanticText(left.structuredData.subject, right.structuredData.subject) &&
      sameSemanticText(left.structuredData.predicate, right.structuredData.predicate);
  }
  if (left.kind === 'preference' && right.kind === 'preference') {
    return sameSemanticText(left.structuredData.domain, right.structuredData.domain) &&
      sameSemanticText(left.structuredData.subject, right.structuredData.subject) &&
      sameSemanticText(left.structuredData.dimension, right.structuredData.dimension);
  }
  return false;
}

function sameSemanticText(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return typeof left === 'string' && typeof right === 'string' &&
    left.trim().replace(/\s+/gu, ' ').toLowerCase() === right.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toFtsQuery(value: string): string {
  const tokens = value.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (tokens.length === 0) {
    throw new Error('FTS search requires non-empty text.');
  }
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
}
