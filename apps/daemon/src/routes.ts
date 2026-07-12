import {
  DecisionDataSchema,
  EventSourceSchema,
  FactDataSchema,
  IsoDateSchema,
  IsoUtcDateTimeSchema,
  JsonValueSchema,
  MemoryScopeSchema,
  NonEmptyTextSchema,
  PolicyDataSchema,
  PreferenceDataSchema,
  UuidV7Schema,
} from '@memlume/contracts';
import { ContextResolver } from '@memlume/context-resolver';
import { EventJournal } from '@memlume/event-journal';
import { MemoryStore } from '@memlume/retrieval';
import { type ErrorRequestHandler, type Express } from 'express';
import { z, ZodError } from 'zod';

const AppendEventRequestSchema = z
  .object({
    rawContent: z.string(),
    eventType: z.string(),
    source: EventSourceSchema.strict(),
    structuredData: JsonValueSchema.optional(),
    occurredAt: IsoUtcDateTimeSchema.optional(),
  })
  .strict();

const MemoryRequestBaseSchema = z
  .object({
    canonicalText: NonEmptyTextSchema,
    title: NonEmptyTextSchema.optional(),
    scope: MemoryScopeSchema,
    priority: z.number().int().optional(),
    confidence: z.number().min(0).max(1).optional(),
    explicitness: z.number().min(0).max(1).optional(),
    sourceEventId: UuidV7Schema.optional(),
    validFrom: IsoDateSchema.optional(),
    validUntil: IsoDateSchema.optional(),
  })
  .strict();

const SaveMemoryRequestSchema = z.discriminatedUnion('kind', [
  MemoryRequestBaseSchema.extend({ kind: z.literal('policy'), structuredData: PolicyDataSchema }),
  MemoryRequestBaseSchema.extend({ kind: z.literal('preference'), structuredData: PreferenceDataSchema }),
  MemoryRequestBaseSchema.extend({ kind: z.literal('fact'), structuredData: FactDataSchema }),
  MemoryRequestBaseSchema.extend({ kind: z.literal('decision'), structuredData: DecisionDataSchema }),
]);

const SearchQuerySchema = z.object({
  q: NonEmptyTextSchema.refine((value) => /[\p{L}\p{N}_]/u.test(value), 'Expected searchable text.'),
});

const ResolveContextRequestSchema = z
  .object({
    intent: NonEmptyTextSchema,
    scope: MemoryScopeSchema,
    task: z.string().nullable(),
    contextBudget: z.number().int().nonnegative(),
    entities: z.array(NonEmptyTextSchema).optional(),
    availableTools: z.array(NonEmptyTextSchema).optional(),
  })
  .strict();

export interface DaemonServices {
  readonly journal: EventJournal;
  readonly store: MemoryStore;
  readonly resolver: ContextResolver;
}

export function registerRoutes(app: Express, services: DaemonServices): void {
  app.get('/v1/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.post('/v1/events', (request, response) => {
    response.status(201).json({ event: services.journal.append(AppendEventRequestSchema.parse(request.body)) });
  });

  app.post('/v1/memories', (request, response) => {
    response.status(201).json({ memory: services.store.save(SaveMemoryRequestSchema.parse(request.body)) });
  });

  app.get('/v1/memories/search', (request, response) => {
    const { q } = SearchQuerySchema.parse(request.query);
    response.json({ memories: services.store.search(q) });
  });

  app.post('/v1/context/resolve', (request, response) => {
    response.json({ context: services.resolver.resolve(ResolveContextRequestSchema.parse(request.body)) });
  });

  app.use((_request, response) => {
    response.status(404).json({ error: 'not_found' });
  });

  app.use(errorHandler);
}

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (isInvalidRequestError(error)) {
    response.status(400).json({ error: 'invalid_request' });
    return;
  }

  response.status(500).json({ error: 'internal_error' });
};

function isInvalidRequestError(error: unknown): boolean {
  if (error instanceof ZodError) {
    return true;
  }
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const { code, status, type } = error as { readonly code?: unknown; readonly status?: unknown; readonly type?: unknown };
  return (
    code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
    (error instanceof SyntaxError && status === 400) ||
    (status === 413 && type === 'entity.too.large')
  );
}
