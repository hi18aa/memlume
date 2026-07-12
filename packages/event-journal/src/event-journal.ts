import { createHash, randomBytes } from 'node:crypto';

import {
  EventSchema,
  EventSourceSchema,
  IsoUtcDateTimeSchema,
  JsonValueSchema,
  UuidV7Schema,
  type Event,
  type EventSource,
  type JsonValue,
} from '@memlume/contracts';
import type { SqliteDatabase } from '@memlume/database/internal';

export interface AppendEventInput {
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

export class EventJournal {
  private readonly findByIdStatement;
  private readonly findByHashAndReferenceStatement;
  private readonly findBySourceReferenceStatement;
  private readonly searchContentStatement;
  private readonly insertStatement;

  constructor(private readonly database: SqliteDatabase) {
    this.findByIdStatement = database.prepare(`SELECT ${eventColumns} FROM events WHERE id = ?`);
    this.findByHashAndReferenceStatement = database.prepare(
      `SELECT ${eventColumns} FROM events WHERE content_hash = ? AND source_reference IS ?`,
    );
    this.findBySourceReferenceStatement = database.prepare(
      `SELECT ${eventColumns} FROM events WHERE source_reference = ? ORDER BY ingested_at, id`,
    );
    this.searchContentStatement = database.prepare(
      `SELECT ${eventColumns} FROM events WHERE instr(raw_content, ?) > 0 ORDER BY ingested_at, id`,
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
  }

  append(input: AppendEventInput): StoredEvent {
    return this.database.transaction(() => this.appendInTransaction(input)).immediate();
  }

  getById(id: string): StoredEvent | undefined {
    return this.toStoredEvent(this.findByIdStatement.get(UuidV7Schema.parse(id)) as EventRow | undefined);
  }

  findBySourceReference(sourceReference: string): StoredEvent[] {
    EventSourceSchema.parse({ reference: sourceReference });
    return (this.findBySourceReferenceStatement.all(sourceReference) as EventRow[]).map((row) => this.toStoredEvent(row)!);
  }

  searchContent(content: string): StoredEvent[] {
    if (content.trim().length === 0) {
      throw new Error('Content search requires non-empty text.');
    }
    return (this.searchContentStatement.all(content) as EventRow[]).map((row) => this.toStoredEvent(row)!);
  }

  private appendInTransaction(input: AppendEventInput): StoredEvent {
    const source = EventSourceSchema.parse(withoutNullSourceReference(input.source));
    const event = EventSchema.parse({
      id: createUuidV7(),
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
        return duplicate;
      }
      throw error;
    }

    return this.getById(event.id)!;
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

function createUuidV7(): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Date.now());

  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
