import {
  MemoryItemSchema,
  MemoryKindSchema,
  MemoryScopeSchema,
  MemoryStatusSchema,
  UuidV7Schema,
  createUuidV7,
  type JsonValue,
  type MemoryItem,
  type MemoryKind,
  type MemoryScope,
  type MemoryStatus,
} from '@memlume/contracts';
import type { SqliteDatabase } from '@memlume/database/internal';

const manualMemoryKinds = ['policy', 'preference', 'fact', 'decision'] as const;
const scopeLevels = ['global', 'domain', 'agent', 'workspace', 'project', 'task'] as const;
const scopeFields = ['domain', 'agentId', 'workspace', 'projectId', 'taskId'] as const;

export type ManualMemoryKind = (typeof manualMemoryKinds)[number];

export interface SaveMemoryInput {
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

export type UpdateMemoryInput = Partial<Omit<SaveMemoryInput, 'kind'>>;

export interface MemoryQuery {
  readonly scope?: MemoryScope;
  readonly status?: MemoryStatus;
  readonly kinds?: readonly MemoryKind[];
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

export class MemoryStore {
  constructor(private readonly database: SqliteDatabase) {}

  save(input: SaveMemoryInput): MemoryItem {
    if (!isManualMemoryKind(input.kind)) {
      throw new Error('Manual memory must be a policy, preference, fact, or decision.');
    }

    const now = new Date().toISOString();
    const memory = MemoryItemSchema.parse({
      id: createUuidV7(),
      ...input,
      status: 'active',
      priority: input.priority ?? 0,
      confidence: input.confidence ?? 1,
      explicitness: input.explicitness ?? 1,
      createdAt: now,
      updatedAt: now,
    });

    this.database.transaction(() => this.insert(memory)).immediate();
    return memory;
  }

  update(id: string, input: UpdateMemoryInput): MemoryItem {
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Memory not found: ${id}`);
    }
    if (!isManualMemoryKind(existing.kind) || existing.status !== 'active') {
      throw new Error('Only active manual memories can be updated.');
    }

    const updated = MemoryItemSchema.parse({
      ...existing,
      ...input,
      id: existing.id,
      kind: existing.kind,
      status: 'active',
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    });

    this.database.transaction(() => this.replace(updated)).immediate();
    return updated;
  }

  get(id: string): MemoryItem | undefined {
    const row = this.database
      .prepare(`SELECT ${memoryColumns} FROM memory_items WHERE id = ?`)
      .get(UuidV7Schema.parse(id)) as MemoryRow | undefined;
    return row === undefined ? undefined : toMemoryItem(row);
  }

  list(filters: MemoryQuery = {}): MemoryItem[] {
    const query = normalizeQuery(filters);
    const { where, values } = sqlFilters(query);
    const rows = this.database
      .prepare(`SELECT ${memoryColumns} FROM memory_items${where} ORDER BY updated_at DESC, id`)
      .all(...values) as MemoryRow[];

    return rows.map(toMemoryItem).filter((memory) => matchesQuery(memory, query));
  }

  search(queryText: string, filters: MemoryQuery = {}): MemoryItem[] {
    const ftsQuery = toFtsQuery(queryText);
    const query = normalizeQuery(filters);
    const { where, values } = sqlFilters(query, 'memory_items');
    const rows = this.database
      .prepare(`
        SELECT ${memoryItemColumns}
        FROM memory_search
        JOIN memory_items ON memory_items.id = memory_search.memory_id
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
    this.replaceSearch(memory);
  }

  private replace(memory: MemoryItem): void {
    this.database
      .prepare(`
        UPDATE memory_items
        SET title = ?, canonical_text = ?, structured_data = ?, scope_data = ?, priority = ?,
            confidence = ?, explicitness = ?, source_event_id = ?, updated_at = ?, valid_from = ?,
            valid_until = ?, superseded_by = ?
        WHERE id = ?
      `)
      .run(
        memory.title ?? null,
        memory.canonicalText,
        JSON.stringify(memory.structuredData),
        JSON.stringify(memory.scope),
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

  private replaceSearch(memory: MemoryItem): void {
    this.database.prepare('DELETE FROM memory_search WHERE memory_id = ?').run(memory.id);
    this.database
      .prepare(`
        INSERT INTO memory_search (memory_id, title, canonical_text, summary, keywords, entities, content)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(memory.id, memory.title ?? '', memory.canonicalText, memory.canonicalText, '', '', memory.canonicalText);
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

function normalizeQuery(filters: MemoryQuery): MemoryQuery {
  return {
    scope: filters.scope === undefined ? undefined : MemoryScopeSchema.parse(filters.scope),
    status: filters.status === undefined ? undefined : MemoryStatusSchema.parse(filters.status),
    kinds: filters.kinds === undefined ? undefined : filters.kinds.map((kind) => MemoryKindSchema.parse(kind)),
  };
}

function sqlFilters(filters: MemoryQuery, tableName = ''): { where: string; values: unknown[] } {
  const prefix = tableName === '' ? '' : `${tableName}.`;
  const clauses: string[] = [];
  const values: unknown[] = [];
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

function toFtsQuery(value: string): string {
  const tokens = value.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (tokens.length === 0) {
    throw new Error('FTS search requires non-empty text.');
  }
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
}
