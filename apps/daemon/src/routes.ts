import {
  DecisionDataSchema,
  DEFAULT_PERSONAL_BRAIN_ID,
  AgentInstallationSchema,
  EventSourceSchema,
  FactDataSchema,
  BrainKindSchema,
  BrainMountSchema,
  IsoDateSchema,
  IsoUtcDateTimeSchema,
  JsonValueSchema,
  MemoryScopeSchema,
  NonEmptyTextSchema,
  PolicyDataSchema,
  PreferenceDataSchema,
  UuidV7Schema,
  type AgentInstallation,
} from '@memlume/contracts';
import { ContextResolver } from '@memlume/context-resolver';
import { EventBrainConflictError, EventJournal } from '@memlume/event-journal';
import { MemoryStore, SourceEventBrainMismatchError } from '@memlume/retrieval';
import { BrainStore } from '@memlume/shared-brains';
import { timingSafeEqual } from 'node:crypto';
import { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { z, ZodError } from 'zod';

const AppendEventRequestSchema = z
  .object({
    brainId: UuidV7Schema.optional(),
    rawContent: z.string(),
    eventType: z.string(),
    source: EventSourceSchema.strict(),
    structuredData: JsonValueSchema.optional(),
    occurredAt: IsoUtcDateTimeSchema.optional(),
  })
  .strict();

const MemoryRequestBaseSchema = z
  .object({
    brainId: UuidV7Schema.optional(),
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
}).strict();

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

const CreateBrainRequestSchema = z
  .object({
    kind: BrainKindSchema,
    name: NonEmptyTextSchema,
  })
  .strict();

const RegisterInstallationRequestSchema = z
  .object({
    clientType: NonEmptyTextSchema,
    installationId: NonEmptyTextSchema,
    profileId: NonEmptyTextSchema,
    displayName: NonEmptyTextSchema.optional(),
  })
  .strict();

const MountBrainRequestSchema = BrainMountSchema.strict();
const InstallationParametersSchema = z.object({ agentInstallationId: UuidV7Schema }).strict();

export interface DaemonServices {
  readonly journal: EventJournal;
  readonly store: MemoryStore;
  readonly resolver: ContextResolver;
  readonly brains: BrainStore;
  readonly setupToken?: string;
}

export interface AuthenticatedRequestLocals {
  readonly agentInstallation: AgentInstallation;
}

export function registerRoutes(app: Express, services: DaemonServices): void {
  app.get('/v1/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  const requireSetup = requireSetupToken(services.setupToken);
  app.post('/v1/setup/brains', requireSetup, (request, response) => {
    response.status(201).json({ brain: services.brains.createBrain(CreateBrainRequestSchema.parse(request.body)) });
  });
  app.get('/v1/setup/brains', requireSetup, (_request, response) => {
    response.json({ brains: services.brains.listBrains() });
  });
  app.post('/v1/setup/installations', requireSetup, (request, response) => {
    const registration = services.brains.registerInstallation(RegisterInstallationRequestSchema.parse(request.body));
    response.status(201).json(registration);
  });
  app.post('/v1/setup/mounts', requireSetup, (request, response) => {
    response.status(201).json({ mount: services.brains.mountBrain(MountBrainRequestSchema.parse(request.body)) });
  });
  app.get('/v1/setup/installations/:agentInstallationId/brains', requireSetup, (request, response) => {
    const { agentInstallationId } = InstallationParametersSchema.parse(request.params);
    response.json({ brains: services.brains.listMountedBrains(agentInstallationId) });
  });
  app.post('/v1/setup/installations/:agentInstallationId/token/rotate', requireSetup, (request, response) => {
    const { agentInstallationId } = InstallationParametersSchema.parse(request.params);
    response.status(201).json(services.brains.rotateToken(agentInstallationId));
  });

  const requireAdapter = requireAdapterToken(services.brains);
  app.post('/v1/events', requireAdapter, (request, response) => {
    const input = AppendEventRequestSchema.parse(request.body);
    const brainId = input.brainId ?? DEFAULT_PERSONAL_BRAIN_ID;
    if (!hasWriteAccess(response, services.brains, brainId)) {
      return;
    }
    response.status(201).json({ event: services.journal.append({ ...input, brainId }) });
  });

  app.post('/v1/memories', requireAdapter, (request, response) => {
    const input = SaveMemoryRequestSchema.parse(request.body);
    const brainId = input.brainId ?? DEFAULT_PERSONAL_BRAIN_ID;
    if (!hasWriteAccess(response, services.brains, brainId)) {
      return;
    }
    response.status(201).json({ memory: services.store.save({ ...input, brainId }) });
  });

  app.get('/v1/memories/search', requireAdapter, (request, response) => {
    const { q } = SearchQuerySchema.parse(request.query);
    const installation = authenticatedInstallation(response);
    if (installation === undefined) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    const brainIds = services.brains.listMountedBrains(installation.id).map(({ brain }) => brain.id);
    response.json({ memories: services.store.search(q, { brainIds }) });
  });

  app.post('/v1/context/resolve', requireAdapter, (request, response) => {
    const installation = authenticatedInstallation(response);
    if (installation === undefined) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    const input = ResolveContextRequestSchema.parse(request.body);
    const brainIds = contextBrainIds(services.brains, installation.id);
    response.json({ context: services.resolver.resolve({ ...input, brainIds }) });
  });

  app.use((_request, response) => {
    response.status(404).json({ error: 'not_found' });
  });

  app.use(errorHandler);
}

function requireSetupToken(setupToken: string | undefined): RequestHandler {
  return (request, response, next) => {
    if (setupToken === undefined || setupToken.length === 0) {
      response.status(503).json({ error: 'setup_unavailable' });
      return;
    }
    if (!tokensMatch(setupToken, request.get('x-memlume-setup-token'))) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

function requireAdapterToken(brains: BrainStore): RequestHandler {
  return (request, response, next) => {
    const token = bearerToken(request.get('authorization'));
    if (token === undefined) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    try {
      const agentInstallation: AgentInstallation = brains.authenticateToken(token);
      response.locals.agentInstallation = agentInstallation;
      next();
    } catch {
      response.status(401).json({ error: 'unauthorized' });
    }
  };
}

function hasWriteAccess(response: { readonly locals: Record<string, unknown>; status: (status: number) => { json(body: unknown): void } }, brains: BrainStore, brainId: string): boolean {
  const installation = authenticatedInstallation(response);
  if (installation === undefined) {
    response.status(401).json({ error: 'unauthorized' });
    return false;
  }
  try {
    brains.assertAccess(installation.id, brainId, 'read_write');
    return true;
  } catch {
    response.status(403).json({ error: 'forbidden' });
    return false;
  }
}

function authenticatedInstallation(response: { readonly locals: Record<string, unknown> }): AgentInstallation | undefined {
  const installation = response.locals.agentInstallation;
  return AgentInstallationSchema.safeParse(installation).data;
}

function contextBrainIds(brains: BrainStore, agentInstallationId: string): string[] {
  const priority = { project: 0, domain: 1, personal: 2 } as const;
  return [...brains.listMountedBrains(agentInstallationId)]
    .sort(
      (left, right) =>
        priority[left.brain.kind] - priority[right.brain.kind] ||
        left.brain.createdAt.localeCompare(right.brain.createdAt) ||
        left.brain.id.localeCompare(right.brain.id),
    )
    .map(({ brain }) => brain.id);
}

function tokensMatch(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) {
    return false;
  }
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.byteLength === actualBytes.byteLength && timingSafeEqual(expectedBytes, actualBytes);
}

function bearerToken(authorization: string | undefined): string | undefined {
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? '');
  return match?.[1];
}

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof EventBrainConflictError) {
    response.status(409).json({ error: 'event_brain_conflict' });
    return;
  }

  if (error instanceof SourceEventBrainMismatchError) {
    response.status(400).json({ error: 'invalid_request' });
    return;
  }

  if (isPayloadTooLargeError(error)) {
    response.status(413).json({ error: 'payload_too_large' });
    return;
  }

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

  const { code, status } = error as { readonly code?: unknown; readonly status?: unknown };
  return code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || (error instanceof SyntaxError && status === 400);
}

function isPayloadTooLargeError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const { status, type } = error as { readonly status?: unknown; readonly type?: unknown };
  return status === 413 && type === 'entity.too.large';
}
