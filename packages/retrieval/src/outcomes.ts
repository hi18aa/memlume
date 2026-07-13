import {
  ContextReceiptSchema,
  IsoUtcDateTimeSchema,
  JsonValueSchema,
  MemoryOutcomeSchema,
  MemoryUsageSchema,
  MemoryUsageOutcomeSchema,
  NonEmptyTextSchema,
  OutcomeResultSchema,
  UuidV7Schema,
  createUuidV7,
  type JsonValue,
  type ContextReceipt,
  type MemoryOutcome,
  type MemoryUsage,
  type MemoryUsageOutcome,
  type OutcomeResult,
} from '@memlume/contracts';
import type { SqliteDatabase } from '@memlume/database/internal';

export interface RecordMemoryUsageInput {
  readonly memoryId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly traceId?: string;
  readonly retrievalRank?: number | null;
  readonly wasIncluded: boolean;
  readonly outcome?: MemoryUsageOutcome | null;
  readonly usedAt?: string;
}

export interface RecordMemoryOutcomeInput {
  readonly taskId: string;
  readonly agentId: string;
  readonly result: OutcomeResult;
  readonly correctionType?: string | null;
  readonly correctionData?: JsonValue | null;
  readonly usedMemoryIds: readonly string[];
  readonly usedToolIds: readonly string[];
  readonly createdAt?: string;
}

export interface IssueContextReceiptInput {
  readonly traceId: string;
  readonly agentId: string;
  readonly brainIds: readonly string[];
  readonly sourceMemoryIds?: readonly string[];
  readonly issuedAt?: string;
  readonly expiresAt?: string;
}

export class OutcomeMemoryAccessError extends Error {
  constructor() {
    super('Outcome memory is not mounted for this installation.');
    this.name = 'OutcomeMemoryAccessError';
  }
}

export class OutcomeReceiptError extends Error {
  constructor(message = 'Outcome receipt is missing, expired, consumed, or not authorized for this installation.') {
    super(message);
    this.name = 'OutcomeReceiptError';
  }
}

export class OutcomeReceiptRateLimitError extends OutcomeReceiptError {
  constructor() {
    super('Context receipt rate limit reached.');
    this.name = 'OutcomeReceiptRateLimitError';
  }
}

export class OutcomeFeedbackRateLimitError extends OutcomeReceiptError {
  constructor() {
    super('Feedback for this memory was already recorded recently by this installation.');
    this.name = 'OutcomeFeedbackRateLimitError';
  }
}

const CONTEXT_RECEIPT_TTL_MS = 15 * 60 * 1000;
const MAX_USAGE_PER_RECEIPT = 256;
const MAX_RECEIPTS_PER_AGENT_PER_MINUTE = 10;
const MAX_ACTIVE_RECEIPTS_PER_AGENT = 10;
const FEEDBACK_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Append-only usage/outcome records and a transparent feedback score.
 * Scores are deliberately small, deterministic and inspectable; they are
 * not a model and never mutate memory history.
 */
export class OutcomeStore {
  constructor(private readonly database: SqliteDatabase) {}

  issueReceipt(input: IssueContextReceiptInput): ContextReceipt {
    const traceId = UuidV7Schema.parse(input.traceId);
    const agentId = NonEmptyTextSchema.parse(input.agentId);
    const brainIds = normalizeBrainIds(input.brainIds);
    const sourceMemoryIds = uniqueUuidV7(input.sourceMemoryIds ?? []);
    if (sourceMemoryIds.length > 256) {
      throw new OutcomeReceiptError('Context receipt cannot contain more than 256 source memories.');
    }
    if (brainIds.length === 0) {
      throw new OutcomeReceiptError('Context receipt requires at least one mounted Brain.');
    }
    if (sourceMemoryIds.length > 0 && !this.memoryIdsMounted(sourceMemoryIds, brainIds)) {
      throw new OutcomeMemoryAccessError();
    }
    const issuedAt = input.issuedAt === undefined ? new Date().toISOString() : IsoUtcDateTimeSchema.parse(input.issuedAt);
    const expiresAt = input.expiresAt === undefined
      ? new Date(Date.parse(issuedAt) + CONTEXT_RECEIPT_TTL_MS).toISOString()
      : IsoUtcDateTimeSchema.parse(input.expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
      throw new OutcomeReceiptError('Context receipt expiry must be after issue time.');
    }
    const receipt = ContextReceiptSchema.parse({ traceId, agentId, brainIds, sourceMemoryIds, issuedAt, expiresAt, consumedAt: null });
    return this.database.transaction(() => {
      const recentCutoff = new Date(Date.parse(receipt.issuedAt) - 60 * 1000).toISOString();
      const recent = this.database
        .prepare('SELECT COUNT(*) AS count FROM context_receipts WHERE agent_id = ? AND issued_at > ?')
        .get(receipt.agentId, recentCutoff) as { readonly count: number };
      const active = this.database
        .prepare('SELECT COUNT(*) AS count FROM context_receipts WHERE agent_id = ? AND consumed_at IS NULL AND expires_at > ?')
        .get(receipt.agentId, receipt.issuedAt) as { readonly count: number };
      if (recent.count >= MAX_RECEIPTS_PER_AGENT_PER_MINUTE || active.count >= MAX_ACTIVE_RECEIPTS_PER_AGENT) {
        throw new OutcomeReceiptRateLimitError();
      }
      this.database
        .prepare(`
          INSERT INTO context_receipts (trace_id, agent_id, brain_ids, source_memory_ids, issued_at, expires_at, consumed_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL)
        `)
        .run(
          receipt.traceId,
          receipt.agentId,
          JSON.stringify(receipt.brainIds),
          JSON.stringify(receipt.sourceMemoryIds),
          receipt.issuedAt,
          receipt.expiresAt,
        );
      return receipt;
    })();
  }

  assertReceipt(traceId: string, agentId: string, brainIds: readonly string[], memoryIds: readonly string[] = []): ContextReceipt {
    const parsedTraceId = UuidV7Schema.parse(traceId);
    const parsedAgentId = NonEmptyTextSchema.parse(agentId);
    const allowedBrainIds = normalizeBrainIds(brainIds);
    const requestedMemoryIds = uniqueUuidV7(memoryIds);
    if (allowedBrainIds.length === 0) throw new OutcomeReceiptError();
    const row = this.database
      .prepare('SELECT trace_id, agent_id, brain_ids, source_memory_ids, issued_at, expires_at, consumed_at FROM context_receipts WHERE trace_id = ?')
      .get(parsedTraceId) as ReceiptRow | undefined;
    if (row === undefined) throw new OutcomeReceiptError();
    const receipt = toReceipt(row);
    if (
      receipt.agentId !== parsedAgentId ||
      receipt.consumedAt !== null ||
      Date.parse(receipt.expiresAt) <= Date.now() ||
      allowedBrainIds.some((brainId) => !receipt.brainIds.includes(brainId)) ||
      requestedMemoryIds.some((memoryId) => !receipt.sourceMemoryIds.includes(memoryId))
    ) {
      throw new OutcomeReceiptError();
    }
    return receipt;
  }

  recordUsageWithReceipt(input: RecordMemoryUsageInput, writableBrainIds: readonly string[], traceId: string, agentId: string): MemoryUsage {
    return this.database.transaction(() => {
      const memoryId = UuidV7Schema.parse(input.memoryId);
      const parsedOutcome = input.outcome === undefined || input.outcome === null
        ? null
        : MemoryUsageOutcomeSchema.parse(input.outcome);
      this.assertReceipt(traceId, agentId, writableBrainIds, [memoryId]);
      const parsedTraceId = UuidV7Schema.parse(traceId);
      const count = this.database
        .prepare('SELECT COUNT(*) AS count FROM memory_usage WHERE trace_id = ?')
        .get(parsedTraceId) as { readonly count: number };
      if (count.count >= MAX_USAGE_PER_RECEIPT) {
        throw new OutcomeReceiptError('Context receipt usage limit reached.');
      }
      this.assertNoDuplicateUsage(parsedTraceId, memoryId, parsedOutcome);
      if (parsedOutcome !== null) {
        this.claimFeedback(agentId, memoryId, parsedTraceId, 'memory_usage', parsedOutcome);
      }
      return this.recordUsage({ ...input, outcome: parsedOutcome, traceId }, writableBrainIds);
    })();
  }

  setUsageOutcomeWithReceipt(usageId: string, outcome: MemoryUsageOutcome, writableBrainIds: readonly string[], traceId: string, agentId: string): MemoryUsage {
    return this.database.transaction(() => {
      const receipt = this.assertReceipt(traceId, agentId, writableBrainIds);
      const parsedOutcome = MemoryUsageOutcomeSchema.parse(outcome);
      const id = UuidV7Schema.parse(usageId);
      const row = this.database
        .prepare('SELECT id, memory_id, task_id, agent_id, retrieval_rank, was_included, outcome, used_at, trace_id FROM memory_usage WHERE id = ?')
        .get(id) as UsageRow | undefined;
      if (row === undefined || row.trace_id !== receipt.traceId || row.agent_id !== receipt.agentId || !receipt.sourceMemoryIds.includes(row.memory_id)) {
        throw new OutcomeReceiptError();
      }
      const count = this.database
        .prepare('SELECT COUNT(*) AS count FROM memory_usage WHERE trace_id = ?')
        .get(receipt.traceId) as { readonly count: number };
      if (count.count >= MAX_USAGE_PER_RECEIPT) {
        throw new OutcomeReceiptError('Context receipt usage limit reached.');
      }
      this.assertNoDuplicateUsage(receipt.traceId, row.memory_id, parsedOutcome);
      this.claimFeedback(receipt.agentId, row.memory_id, receipt.traceId, 'memory_usage', parsedOutcome);
      return this.recordUsage({
        memoryId: row.memory_id,
        taskId: row.task_id,
        agentId: row.agent_id,
        retrievalRank: row.retrieval_rank,
        wasIncluded: row.was_included === 1,
        outcome: parsedOutcome,
        traceId: receipt.traceId,
      }, writableBrainIds);
    })();
  }

  recordOutcomeWithReceipt(input: RecordMemoryOutcomeInput, writableBrainIds: readonly string[], traceId: string, agentId: string): MemoryOutcome {
    return this.database.transaction(() => {
      const usedMemoryIds = uniqueUuidV7(input.usedMemoryIds);
      this.assertReceipt(traceId, agentId, writableBrainIds, usedMemoryIds);
      const parsedTraceId = UuidV7Schema.parse(traceId);
      for (const memoryId of usedMemoryIds) {
        this.claimFeedback(agentId, memoryId, parsedTraceId, 'task_outcome', input.result);
      }
      const outcome = this.recordOutcome({ ...input, usedMemoryIds }, writableBrainIds);
      this.consumeReceipt(traceId, agentId, writableBrainIds);
      return outcome;
    })();
  }

  consumeReceipt(traceId: string, agentId: string, brainIds: readonly string[]): ContextReceipt {
    const receipt = this.assertReceipt(traceId, agentId, brainIds);
    const consumedAt = new Date().toISOString();
    const result = this.database
      .prepare('UPDATE context_receipts SET consumed_at = ? WHERE trace_id = ? AND consumed_at IS NULL')
      .run(consumedAt, receipt.traceId);
    if (result.changes !== 1) throw new OutcomeReceiptError();
    return ContextReceiptSchema.parse({ ...receipt, consumedAt });
  }

  recordUsage(input: RecordMemoryUsageInput, writableBrainIds: readonly string[]): MemoryUsage {
    const memoryId = UuidV7Schema.parse(input.memoryId);
    const brainIds = normalizeBrainIds(writableBrainIds);
    this.assertMemoriesMounted([memoryId], brainIds);
    const usage = MemoryUsageSchema.parse({
      id: createUuidV7(),
      memoryId,
      taskId: NonEmptyTextSchema.parse(input.taskId),
      agentId: NonEmptyTextSchema.parse(input.agentId),
      retrievalRank: input.retrievalRank === undefined || input.retrievalRank === null
        ? null
        : Number.isInteger(input.retrievalRank) && input.retrievalRank >= 0
          ? input.retrievalRank
          : (() => { throw new Error('Retrieval rank must be a non-negative integer or null.'); })(),
      wasIncluded: input.wasIncluded,
      outcome: input.outcome === undefined || input.outcome === null
        ? null
        : MemoryUsageOutcomeSchema.parse(input.outcome),
      usedAt: input.usedAt === undefined ? new Date().toISOString() : IsoUtcDateTimeSchema.parse(input.usedAt),
    });

    this.database
      .prepare(`
        INSERT INTO memory_usage (
          id, memory_id, task_id, agent_id, retrieval_rank, was_included, outcome, used_at, trace_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        usage.id,
        usage.memoryId,
        usage.taskId,
        usage.agentId,
        usage.retrievalRank,
        usage.wasIncluded ? 1 : 0,
        usage.outcome,
        usage.usedAt,
        input.traceId === undefined ? null : UuidV7Schema.parse(input.traceId),
      );
    return usage;
  }

  setUsageOutcome(usageId: string, outcome: MemoryUsageOutcome, writableBrainIds: readonly string[]): MemoryUsage {
    const id = UuidV7Schema.parse(usageId);
    const parsedOutcome = MemoryUsageOutcomeSchema.parse(outcome);
    const row = this.database
      .prepare('SELECT id, memory_id, task_id, agent_id, retrieval_rank, was_included, outcome, used_at, trace_id FROM memory_usage WHERE id = ?')
      .get(id) as UsageRow | undefined;
    if (row === undefined) {
      throw new Error(`Memory usage not found: ${id}`);
    }
    this.assertMemoriesMounted([row.memory_id], normalizeBrainIds(writableBrainIds));
    // Usage is append-only as an audit record. A corrected state is appended
    // so that the prior observation remains available for reporting.
    return this.recordUsage({
      memoryId: row.memory_id,
      taskId: row.task_id,
      agentId: row.agent_id,
      retrievalRank: row.retrieval_rank,
      wasIncluded: row.was_included === 1,
      outcome: parsedOutcome,
      ...(row.trace_id === null ? {} : { traceId: row.trace_id }),
      usedAt: new Date().toISOString(),
    }, writableBrainIds);
  }

  recordOutcome(input: RecordMemoryOutcomeInput, writableBrainIds: readonly string[]): MemoryOutcome {
    const usedMemoryIds = uniqueUuidV7(input.usedMemoryIds);
    this.assertMemoriesMounted(usedMemoryIds, normalizeBrainIds(writableBrainIds));
    const outcome = MemoryOutcomeSchema.parse({
      id: createUuidV7(),
      taskId: NonEmptyTextSchema.parse(input.taskId),
      agentId: NonEmptyTextSchema.parse(input.agentId),
      result: OutcomeResultSchema.parse(input.result),
      correctionType: input.correctionType === undefined || input.correctionType === null
        ? null
        : NonEmptyTextSchema.parse(input.correctionType),
      correctionData: input.correctionData === undefined || input.correctionData === null
        ? null
        : JsonValueSchema.parse(input.correctionData),
      usedMemoryIds,
      usedToolIds: input.usedToolIds.map((toolId) => NonEmptyTextSchema.parse(toolId)),
      createdAt: input.createdAt === undefined ? new Date().toISOString() : IsoUtcDateTimeSchema.parse(input.createdAt),
    });

    this.database
      .prepare(`
        INSERT INTO outcomes (
          id, task_id, agent_id, result, correction_type, correction_data,
          used_memory_ids, used_tool_ids, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        outcome.id,
        outcome.taskId,
        outcome.agentId,
        outcome.result,
        outcome.correctionType,
        outcome.correctionData === null ? null : JSON.stringify(outcome.correctionData),
        JSON.stringify(outcome.usedMemoryIds),
        JSON.stringify(outcome.usedToolIds),
        outcome.createdAt,
      );
    return outcome;
  }

  listUsage(memoryId: string, brainIds: readonly string[]): MemoryUsage[] {
    const parsedId = UuidV7Schema.parse(memoryId);
    const allowed = normalizeBrainIds(brainIds);
    if (allowed.length === 0) return [];
    const rows = this.database
      .prepare(`
        SELECT usage.id, usage.memory_id, usage.task_id, usage.agent_id,
               usage.retrieval_rank, usage.was_included, usage.outcome, usage.used_at
        FROM memory_usage AS usage
        JOIN memory_brains ON memory_brains.memory_id = usage.memory_id
        WHERE usage.memory_id = ? AND ${brainFilter(allowed)}
        ORDER BY usage.used_at, usage.id
      `)
      .all(parsedId, ...allowed) as UsageRow[];
    return rows.map(toUsage);
  }

  listOutcomes(taskId: string, brainIds: readonly string[]): MemoryOutcome[] {
    const parsedTaskId = NonEmptyTextSchema.parse(taskId);
    const allowed = normalizeBrainIds(brainIds);
    if (allowed.length === 0) return [];
    const rows = this.database
      .prepare('SELECT id, task_id, agent_id, result, correction_type, correction_data, used_memory_ids, used_tool_ids, created_at FROM outcomes WHERE task_id = ? ORDER BY created_at, id')
      .all(parsedTaskId) as OutcomeRow[];
    return rows
      .map(toOutcome)
      .filter((outcome) => this.memoryIdsMounted(outcome.usedMemoryIds, allowed));
  }

  /** Return explainable score deltas for the requested memories. */
  feedbackScores(memoryIds: readonly string[], brainIds: readonly string[]): Map<string, number> {
    const ids = uniqueUuidV7(memoryIds);
    const allowed = normalizeBrainIds(brainIds);
    const scores = new Map<string, number>(ids.map((id) => [id, 0]));
    if (ids.length === 0 || allowed.length === 0) return scores;

    const rows = this.database
      .prepare(`
        SELECT usage.memory_id, usage.was_included, usage.outcome
        FROM memory_usage AS usage
        JOIN memory_brains ON memory_brains.memory_id = usage.memory_id
        WHERE usage.memory_id IN (${ids.map(() => '?').join(', ')})
          AND ${brainFilter(allowed)}
      `)
      .all(...ids, ...allowed) as Array<{ memory_id: string; was_included: number; outcome: string | null }>;
    for (const row of rows) {
      if (row.was_included !== 1 || row.outcome === null) continue;
      scores.set(row.memory_id, (scores.get(row.memory_id) ?? 0) + usageDelta(row.outcome));
    }

    const outcomes = this.database
      .prepare('SELECT result, used_memory_ids FROM outcomes ORDER BY created_at, id')
      .all() as Array<{ result: string; used_memory_ids: string }>;
    for (const row of outcomes) {
      const usedIds = parseUuidArray(row.used_memory_ids);
      if (!this.memoryIdsMounted(usedIds, allowed)) continue;
      for (const id of usedIds) {
        if (!scores.has(id)) continue;
        scores.set(id, (scores.get(id) ?? 0) + resultDelta(row.result));
      }
    }
    return scores;
  }

  private claimFeedback(agentId: string, memoryId: string, traceId: string, signalKind: string, signalValue: string): void {
    const parsedAgentId = NonEmptyTextSchema.parse(agentId);
    const parsedMemoryId = UuidV7Schema.parse(memoryId);
    const parsedTraceId = UuidV7Schema.parse(traceId);
    const recordedAt = new Date().toISOString();
    const cutoff = new Date(Date.parse(recordedAt) - FEEDBACK_CLAIM_TTL_MS).toISOString();
    this.database.prepare('DELETE FROM feedback_signal_claims WHERE recorded_at <= ?').run(cutoff);
    const existing = this.database
      .prepare(`
        SELECT trace_id
        FROM feedback_signal_claims
        WHERE agent_id = ? AND memory_id = ? AND recorded_at > ?
        ORDER BY recorded_at DESC
        LIMIT 1
      `)
      .get(parsedAgentId, parsedMemoryId, cutoff) as { readonly trace_id: string } | undefined;
    if (existing !== undefined && existing.trace_id !== parsedTraceId) {
      throw new OutcomeFeedbackRateLimitError();
    }
    this.database
      .prepare(`
        INSERT INTO feedback_signal_claims (id, agent_id, memory_id, trace_id, signal_kind, signal_value, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(createUuidV7(), parsedAgentId, parsedMemoryId, parsedTraceId, signalKind, signalValue, recordedAt);
  }

  private assertNoDuplicateUsage(traceId: string, memoryId: string, outcome: MemoryUsageOutcome | null): void {
    const duplicate = this.database
      .prepare(`
        SELECT 1
        FROM memory_usage
        WHERE trace_id = ?
          AND memory_id = ?
          AND (outcome = ? OR (outcome IS NULL AND ? IS NULL))
        LIMIT 1
      `)
      .get(traceId, memoryId, outcome, outcome);
    if (duplicate !== undefined) {
      throw new OutcomeReceiptError('This memory outcome was already recorded for the context receipt.');
    }
  }

  private assertMemoriesMounted(memoryIds: readonly string[], brainIds: readonly string[]): void {
    if (memoryIds.length === 0 || brainIds.length === 0 || !this.memoryIdsMounted(memoryIds, brainIds)) {
      throw new OutcomeMemoryAccessError();
    }
  }

  private memoryIdsMounted(memoryIds: readonly string[], brainIds: readonly string[]): boolean {
    if (memoryIds.length === 0 || brainIds.length === 0) return false;
    const rows = this.database
      .prepare(`
        SELECT memory_id
        FROM memory_brains
        WHERE memory_id IN (${memoryIds.map(() => '?').join(', ')})
          AND ${brainFilter(brainIds)}
        GROUP BY memory_id
      `)
      .all(...memoryIds, ...brainIds) as Array<{ memory_id: string }>;
    return new Set(rows.map(({ memory_id }) => memory_id)).size === new Set(memoryIds).size;
  }
}

type UsageRow = {
  readonly id: string;
  readonly memory_id: string;
  readonly task_id: string;
  readonly agent_id: string;
  readonly retrieval_rank: number | null;
  readonly was_included: number;
  readonly outcome: string | null;
  readonly used_at: string;
  readonly trace_id: string | null;
};

type OutcomeRow = {
  readonly id: string;
  readonly task_id: string;
  readonly agent_id: string;
  readonly result: string;
  readonly correction_type: string | null;
  readonly correction_data: string | null;
  readonly used_memory_ids: string;
  readonly used_tool_ids: string;
  readonly created_at: string;
};

type ReceiptRow = {
  readonly trace_id: string;
  readonly agent_id: string;
  readonly brain_ids: string;
  readonly source_memory_ids: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
};

function toUsage(row: UsageRow): MemoryUsage {
  return MemoryUsageSchema.parse({
    id: row.id,
    memoryId: row.memory_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    retrievalRank: row.retrieval_rank,
    wasIncluded: row.was_included === 1,
    outcome: row.outcome,
    usedAt: row.used_at,
  });
}

function toOutcome(row: OutcomeRow): MemoryOutcome {
  return MemoryOutcomeSchema.parse({
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    result: row.result,
    correctionType: row.correction_type,
    correctionData: row.correction_data === null ? null : JSON.parse(row.correction_data),
    usedMemoryIds: JSON.parse(row.used_memory_ids),
    usedToolIds: JSON.parse(row.used_tool_ids),
    createdAt: row.created_at,
  });
}

function toReceipt(row: ReceiptRow): ContextReceipt {
  return ContextReceiptSchema.parse({
    traceId: row.trace_id,
    agentId: row.agent_id,
    brainIds: JSON.parse(row.brain_ids),
    sourceMemoryIds: parseUuidArray(row.source_memory_ids),
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  });
}

function uniqueUuidV7(values: readonly string[]): string[] {
  const ids = values.map((value) => UuidV7Schema.parse(value));
  return [...new Set(ids)];
}

function normalizeBrainIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => UuidV7Schema.parse(value)))];
}

function brainFilter(brainIds: readonly string[]): string {
  return `memory_brains.brain_id IN (${brainIds.map(() => '?').join(', ')})`;
}

function parseUuidArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? uniqueUuidV7(parsed.filter((item): item is string => typeof item === 'string')) : [];
  } catch {
    return [];
  }
}

function usageDelta(outcome: string): number {
  return outcome === 'adopted' ? 2 : outcome === 'corrected' ? -2 : -1;
}

function resultDelta(result: string): number {
  return result === 'success' ? 1 : result === 'corrected' ? -2 : -1;
}
