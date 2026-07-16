import { createHash } from 'node:crypto';

import {
  DEFAULT_PERSONAL_BRAIN_ID,
  EventSchema,
  EventSourceSchema,
  IsoUtcDateTimeSchema,
  JsonValueSchema,
  UuidV7Schema,
  createUuidV7,
  type Event,
  type EventSource,
  type JsonValue,
} from '@memlume/contracts';
import type { SqliteDatabase } from '@memlume/database/internal';

export interface AppendEventInput {
  readonly brainId?: string;
  readonly rawContent: string;
  readonly eventType: string;
  readonly source: EventSourceInput;
  readonly structuredData?: JsonValue;
  readonly occurredAt?: string;
}

export type EventSourceInput = Omit<EventSource, 'reference'> & {
  readonly reference?: string | null;
};

export type StoredEvent = Event & {
  readonly contentHash: string;
  readonly ingestedAt: string;
  readonly processingStatus: string;
};

export class EventBrainConflictError extends Error {
  constructor() {
    super('Event is already assigned to a different brain.');
    this.name = 'EventBrainConflictError';
  }
}

export class EventBrainRequiredError extends Error {
  constructor() {
    super('Event writes require an explicit brainId.');
    this.name = 'EventBrainRequiredError';
  }
}

type EventRow = {
  id: string;
  event_type: string;
  raw_content: string;
  structured_data: string | null;
  source_data: string;
  occurred_at: string;
  ingested_at: string;
  processing_status: string;
  content_hash: string;
  brain_id: string;
};

const eventColumns = `
  id,
  event_type,
  raw_content,
  structured_data,
  source_data,
  occurred_at,
  ingested_at,
  processing_status,
  content_hash
`;
const eventSelectColumns = `${eventColumns}, event_brains.brain_id`;
const eventFrom = 'FROM events JOIN event_brains ON event_brains.event_id = events.id';

export class EventJournal {
  private readonly findByHashAndReferenceStatement;
  private readonly insertStatement;
  private readonly insertBrainStatement;

  constructor(private readonly database: SqliteDatabase) {
    this.findByHashAndReferenceStatement = database.prepare(
      `SELECT ${eventSelectColumns} ${eventFrom} WHERE events.content_hash = ? AND events.source_reference IS ?`,
    );
    this.insertStatement = database.prepare(`
      INSERT INTO events (
        id,
        event_type,
        raw_content,
        structured_data,
        source_type,
        source_agent,
        source_reference,
        source_data,
        occurred_at,
        ingested_at,
        content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertBrainStatement = database.prepare(
      'INSERT INTO event_brains (event_id, brain_id, created_at) VALUES (?, ?, ?)',
    );
  }

  append(input: AppendEventInput): StoredEvent {
    return this.database.transaction(() => this.appendInTransaction(input)).immediate();
  }

  getById(id: string, brainIds?: readonly string[]): StoredEvent | undefined {
    const allowedBrainIds = normalizeBrainIds(brainIds);
    if (allowedBrainIds.length === 0) {
      return undefined;
    }
    return this.toStoredEvent(
      this.database
        .prepare(`SELECT ${eventSelectColumns} ${eventFrom} WHERE events.id = ? AND ${brainFilter(allowedBrainIds)}`)
        .get(UuidV7Schema.parse(id), ...allowedBrainIds) as EventRow | undefined,
    );
  }

  findBySourceReference(sourceReference: string, brainIds?: readonly string[]): StoredEvent[] {
    EventSourceSchema.parse({ reference: sourceReference });
    const allowedBrainIds = normalizeBrainIds(brainIds);
    if (allowedBrainIds.length === 0) {
      return [];
    }
    return (
      this.database
        .prepare(
          `SELECT ${eventSelectColumns} ${eventFrom} WHERE events.source_reference = ? AND ${brainFilter(allowedBrainIds)} ORDER BY events.ingested_at, events.id`,
        )
        .all(sourceReference, ...allowedBrainIds) as EventRow[]
    ).map((row) => this.toStoredEvent(row)!);
  }

  searchContent(content: string, brainIds?: readonly string[]): StoredEvent[] {
    if (content.trim().length === 0) {
      throw new Error('Content search requires non-empty text.');
    }
    const allowedBrainIds = normalizeBrainIds(brainIds);
    if (allowedBrainIds.length === 0) {
      return [];
    }
    return (
      this.database
        .prepare(
          `SELECT ${eventSelectColumns} ${eventFrom} WHERE instr(events.raw_content, ?) > 0 AND ${brainFilter(allowedBrainIds)} ORDER BY events.ingested_at, events.id`,
        )
        .all(content, ...allowedBrainIds) as EventRow[]
    ).map((row) => this.toStoredEvent(row)!);
  }

  private appendInTransaction(input: AppendEventInput): StoredEvent {
    const source = EventSourceSchema.parse(withoutNullSourceReference(input.source));
    if (input.brainId === undefined) {
      throw new EventBrainRequiredError();
    }
    const brainId = UuidV7Schema.parse(input.brainId);
    const event = EventSchema.parse({
      id: createUuidV7(),
      brainId,
      rawContent: input.rawContent,
      eventType: input.eventType,
      source,
      structuredData: input.structuredData,
      occurredAt: input.occurredAt === undefined ? new Date().toISOString() : input.occurredAt,
    });
    const sourceReference = source.reference;
    const contentHash = hashContent(event.rawContent);
    const existing = sourceReference === undefined ? undefined : this.findByHashAndReference(contentHash, sourceReference);

    if (existing) {
      if (existing.brainId !== event.brainId) {
        throw new EventBrainConflictError();
      }
      return existing;
    }

    const ingestedAt = new Date().toISOString();
    const structuredData =
      event.structuredData === undefined ? null : JSON.stringify(JsonValueSchema.parse(event.structuredData));
    const sourceData = JSON.stringify(source);

    try {
      this.insertStatement.run(
        event.id,
        event.eventType,
        event.rawContent,
        structuredData,
        source.type ?? 'unknown',
        source.agent ?? null,
        sourceReference ?? null,
        sourceData,
        event.occurredAt,
        ingestedAt,
        contentHash,
      );
    } catch (error) {
      const duplicate =
        sourceReference === undefined ? undefined : this.findByHashAndReference(contentHash, sourceReference);
      if (duplicate) {
        if (duplicate.brainId !== event.brainId) {
          throw new EventBrainConflictError();
        }
        return duplicate;
      }
      throw error;
    }
    this.insertBrainStatement.run(event.id, event.brainId, ingestedAt);

    return this.getById(event.id, [event.brainId])!;
  }

  private findByHashAndReference(contentHash: string, sourceReference: string): StoredEvent | undefined {
    return this.toStoredEvent(
      this.findByHashAndReferenceStatement.get(contentHash, sourceReference) as EventRow | undefined,
    );
  }

  private toStoredEvent(row: EventRow | undefined): StoredEvent | undefined {
    if (!row) {
      return undefined;
    }

    const source = EventSourceSchema.parse(JSON.parse(row.source_data));
    const structuredData = row.structured_data === null ? undefined : JsonValueSchema.parse(JSON.parse(row.structured_data));
    const event = EventSchema.parse({
      id: row.id,
      brainId: row.brain_id,
      eventType: row.event_type,
      rawContent: row.raw_content,
      structuredData,
      occurredAt: row.occurred_at,
      source,
    });

    if (row.content_hash !== hashContent(event.rawContent)) {
      throw new Error('Stored event content hash does not match its raw content.');
    }

    return {
      ...event,
      contentHash: row.content_hash,
      ingestedAt: IsoUtcDateTimeSchema.parse(row.ingested_at),
      processingStatus: row.processing_status,
    };
  }
}

function hashContent(rawContent: string): string {
  return createHash('sha256').update(rawContent).digest('hex');
}

function withoutNullSourceReference(source: EventSourceInput): EventSourceInput | Omit<EventSourceInput, 'reference'> {
  if (source.reference !== null) {
    return source;
  }

  const { reference: _, ...withoutReference } = source;
  return withoutReference;
}

function normalizeBrainIds(brainIds: readonly string[] | undefined): readonly string[] {
  return brainIds === undefined
    ? [DEFAULT_PERSONAL_BRAIN_ID]
    : brainIds.map((brainId) => UuidV7Schema.parse(brainId));
}

function brainFilter(brainIds: readonly string[]): string {
  return `event_brains.brain_id IN (${brainIds.map(() => '?').join(', ')})`;
}
