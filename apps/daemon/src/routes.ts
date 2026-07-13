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
  redactSensitiveJson,
  redactSensitiveText,
  type AgentInstallation,
  type JsonValue,
} from '@memlume/contracts';
import { ContextResolver } from '@memlume/context-resolver';
import { EventBrainConflictError, EventJournal } from '@memlume/event-journal';
import { assessMemoryConflict, compileMemory, type MemoryProposal } from '@memlume/memory-compiler';
import { MemoryStore, SourceEventBrainMismatchError } from '@memlume/retrieval';
import { BrainStore } from '@memlume/shared-brains';
import { BrainImportConflictError, BrainImportRequiredError, FullBackupAuthenticationRequiredError, FullRestoreRequiredError, RestoreRecoveryError } from '@memlume/backup';
import { timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler, type Response } from 'express';
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

const CaptureMemoryRequestSchema = AppendEventRequestSchema.extend({
  scope: MemoryScopeSchema,
}).strict();

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

const MemoryParametersSchema = z.object({ memoryId: UuidV7Schema }).strict();
const ReviewCandidateRequestSchema = z.object({
  actor: NonEmptyTextSchema,
  reason: NonEmptyTextSchema,
  supersedeMemoryId: UuidV7Schema.optional(),
}).strict();
const ConsoleReviewCandidateRequestSchema = ReviewCandidateRequestSchema.omit({ actor: true });

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
const CreateBackupRequestSchema = z.object({
  brainId: UuidV7Schema.optional(),
  password: z.string().min(1).max(1024).optional(),
}).strict();
const ImportBrainQuerySchema = z.object({
  name: z.string().trim().min(1).max(256).optional(),
}).strict();

export interface DaemonServices {
  readonly journal: EventJournal;
  readonly store: MemoryStore;
  readonly resolver: ContextResolver;
  readonly brains: BrainStore;
  readonly setupToken?: string;
  readonly backup: BackupLifecycle;
}

export interface BackupLifecycle {
  create(input: { readonly brainId?: string; readonly password?: string }): Promise<Buffer>;
  import(input: { readonly bundle: Uint8Array; readonly password?: string; readonly name?: string }): Promise<unknown>;
  beginRestore(): boolean;
  cancelRestore(): void;
  restore(input: { readonly bundle: Uint8Array; readonly password?: string }): Promise<void>;
  diagnostics(): unknown;
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
  app.get('/v1/setup/memories', requireSetup, (_request, response) => {
    response.json({ memories: services.store.list({ brainIds: services.brains.listBrains().map(({ id }) => id) }) });
  });
  app.get('/v1/setup/inbox', requireSetup, (_request, response) => {
    response.json({ memories: services.store.list({ brainIds: services.brains.listBrains().map(({ id }) => id), status: 'candidate' }) });
  });
  app.post('/v1/setup/inbox/:memoryId/approve', requireSetup, (request, response) => {
    const { memoryId } = MemoryParametersSchema.parse(request.params);
    const input = ConsoleReviewCandidateRequestSchema.parse(request.body);
    const brainIds = services.brains.listBrains().map(({ id }) => id);
    const candidate = services.store.get(memoryId, brainIds);
    if (candidate === undefined) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    if (candidate.status !== 'candidate') {
      response.status(409).json({ error: 'candidate_not_pending' });
      return;
    }
    const active = services.store.list({ brainIds: [candidate.brainId], status: 'active' });
    const resolution = assessMemoryConflict({ proposal: { ...candidate, status: 'active' }, existing: active });
    if (input.supersedeMemoryId !== undefined && resolution.action !== 'review') {
      response.status(400).json({ error: 'invalid_supersede' });
      return;
    }
    if (resolution.action === 'reuse') {
      response.status(409).json({ error: 'active_duplicate' });
      return;
    }
    if (resolution.action === 'review' && input.supersedeMemoryId !== resolution.memoryId) {
      response.status(400).json({ error: 'confirmation_required' });
      return;
    }
    response.json({ memory: services.store.approveCandidate(memoryId, { ...input, actor: 'memlume-console' }, brainIds) });
  });
  app.post('/v1/setup/inbox/:memoryId/reject', requireSetup, (request, response) => {
    const { memoryId } = MemoryParametersSchema.parse(request.params);
    const input = ConsoleReviewCandidateRequestSchema.omit({ supersedeMemoryId: true }).parse(request.body);
    const brainIds = services.brains.listBrains().map(({ id }) => id);
    const candidate = services.store.get(memoryId, brainIds);
    if (candidate === undefined) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    if (candidate.status !== 'candidate') {
      response.status(409).json({ error: 'candidate_not_pending' });
      return;
    }
    response.json({ memory: services.store.rejectCandidate(memoryId, { ...input, actor: 'memlume-console' }, brainIds) });
  });
  app.post('/v1/setup/installations', requireSetup, (request, response) => {
    const registration = services.brains.registerInstallation(RegisterInstallationRequestSchema.parse(request.body));
    response.status(201).json(registration);
  });
  app.get('/v1/setup/installations', requireSetup, (_request, response) => {
    response.json({ installations: services.brains.listInstallations() });
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
  app.get('/v1/setup/diagnostics', requireSetup, (_request, response) => {
    response.json(services.backup.diagnostics());
  });
  app.post('/v1/setup/backups', requireSetup, async (request, response) => {
    const input = CreateBackupRequestSchema.parse(request.body);
    try {
      const bundle = await services.backup.create(input);
      response
        .status(200)
        .type('application/vnd.memlume')
        .set('content-disposition', 'attachment; filename="memlume-backup.memlume"')
        .send(bundle);
    } catch (error) {
      if (error instanceof FullBackupAuthenticationRequiredError) {
        response.status(400).json({ error: 'full_backup_password_required' });
        return;
      }
      throw error;
    }
  });
  app.post(
    '/v1/setup/brains/import',
    requireSetup,
    express.raw({ type: ['application/vnd.memlume', 'application/octet-stream'], limit: '64mb' }),
    async (request: Request, response: Response) => {
      if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
        response.status(400).json({ error: 'invalid_backup' });
        return;
      }
      const { name } = ImportBrainQuerySchema.parse(request.query);
      const password = request.get('x-memlume-backup-password');
      if (password !== undefined && (password.length === 0 || password.length > 1024)) {
        response.status(400).json({ error: 'invalid_backup' });
        return;
      }
      try {
        const imported = await services.backup.import({ bundle: request.body, ...(password === undefined ? {} : { password }), ...(name === undefined ? {} : { name }) });
        response.status(201).json(imported);
      } catch (error) {
        if (error instanceof BrainImportConflictError) {
          response.status(409).json({ error: 'import_conflict' });
          return;
        }
        if (error instanceof FullBackupAuthenticationRequiredError) {
          response.status(409).json({ error: 'full_restore_required' });
          return;
        }
        if (error instanceof FullRestoreRequiredError) {
          response.status(409).json({ error: 'full_restore_required' });
          return;
        }
        response.status(400).json({ error: 'invalid_backup' });
      }
    },
  );
  app.post(
    '/v1/setup/backups/restore',
    requireSetup,
    beginBackupRestore(services.backup),
    express.raw({ type: ['application/vnd.memlume', 'application/octet-stream'], limit: '64mb' }),
    cancelBackupRestore(services.backup),
    async (request: Request, response: Response) => {
      if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
        services.backup.cancelRestore();
        response.status(400).json({ error: 'invalid_backup' });
        return;
      }
      const password = request.get('x-memlume-backup-password');
      if (password !== undefined && (password.length === 0 || password.length > 1024)) {
        services.backup.cancelRestore();
        response.status(400).json({ error: 'invalid_backup' });
        return;
      }
      try {
        await services.backup.restore({ bundle: request.body, ...(password === undefined ? {} : { password }) });
        response.json({ status: 'restored' });
      } catch (error) {
        if (error instanceof BrainImportRequiredError) {
          response.status(409).json({ error: 'brain_import_required' });
          return;
        }
        if (error instanceof RestoreRecoveryError) {
          response.status(503).json({ error: 'restore_recovery_required' });
          return;
        }
        response.status(400).json({ error: 'invalid_backup' });
      }
    },
  );

  const requireAdapter = requireAdapterToken(services.brains);
  app.post('/v1/events', requireAdapter, (request, response) => {
    const input = AppendEventRequestSchema.parse(request.body);
    const brainId = input.brainId ?? DEFAULT_PERSONAL_BRAIN_ID;
    if (!hasWriteAccess(response, services.brains, brainId)) {
      return;
    }
    const rawContent = redactSensitiveText(input.rawContent).redacted;
    const structuredData = input.structuredData === undefined ? undefined : redactSensitiveJson(input.structuredData).redacted;
    const source = redactEventSource(input.source);
    response.status(201).json({ event: services.journal.append({ ...input, brainId, rawContent, source, ...(structuredData === undefined ? {} : { structuredData }) }) });
  });

  app.post('/v1/memories', requireAdapter, (request, response) => {
    const input = SaveMemoryRequestSchema.parse(request.body);
    const brainId = input.brainId ?? DEFAULT_PERSONAL_BRAIN_ID;
    if (!hasWriteAccess(response, services.brains, brainId)) {
      return;
    }
    const sanitized = SaveMemoryRequestSchema.parse({
      ...input,
      canonicalText: redactSensitiveText(input.canonicalText).redacted,
      ...(input.title === undefined ? {} : { title: redactSensitiveText(input.title).redacted }),
      structuredData: redactSensitiveJson(input.structuredData).redacted,
      scope: redactMemoryScope(input.scope),
    });
    response.status(201).json({ memory: services.store.save({ ...sanitized, brainId }) });
  });

  app.post('/v1/memories/capture', requireAdapter, (request, response) => {
    const input = CaptureMemoryRequestSchema.parse(request.body);
    const brainId = input.brainId ?? DEFAULT_PERSONAL_BRAIN_ID;
    if (!hasWriteAccess(response, services.brains, brainId)) {
      return;
    }
    const redaction = redactSensitiveText(input.rawContent);
    const structuredData = input.structuredData === undefined ? undefined : redactSensitiveJson(input.structuredData).redacted;
    const source = redactEventSource(input.source);
    const scope = redactMemoryScope(input.scope);
    const event = services.journal.append({
      brainId,
      rawContent: redaction.redacted,
      eventType: input.eventType,
      source,
      ...(structuredData === undefined ? {} : { structuredData }),
      occurredAt: input.occurredAt,
    });
    const compiled = compileMemory({
      event: redaction.detected ? { ...event, rawContent: input.rawContent } : event,
      scope,
    });
    if (compiled.status === 'ignore' || compiled.status === 'rejected') {
      response.json({
        capture: {
          memoryId: null,
          status: compiled.status,
          brain: brainId,
          scope,
          requiresConfirmation: false,
          source: { eventId: event.id },
        },
      });
      return;
    }

    const proposal = { ...compiled, structuredData: capturedStructuredData(compiled) };
    const resolution = assessMemoryConflict({
      proposal,
      existing: services.store.list({ brainIds: [brainId] }),
    });
    const existing = resolution.action === 'reuse'
      ? services.store.get(resolution.memoryId, [brainId])!
      : undefined;
    const memory = existing === undefined
      ? (compiled.status === 'candidate' || resolution.action === 'review'
          ? services.store.saveCandidate({ ...proposal, brainId })
          : services.store.save({ ...proposal, brainId }))
      : (compiled.status === 'active' && existing.status === 'candidate'
          ? services.store.approveCandidate(existing.id, {
            actor: 'memlume',
            reason: 'Explicit user request confirms pending candidate.',
          }, [brainId])
          : existing);
    response.status(resolution.action === 'reuse' ? 200 : 201).json({
      capture: {
        memoryId: memory.id,
        status: memory.status,
        brain: memory.brainId,
        scope: memory.scope,
        requiresConfirmation: resolution.requiresConfirmation,
        source: { eventId: event.id },
      },
    });
  });

  app.get('/v1/memories/candidates', requireAdapter, (_request, response) => {
    const installation = authenticatedInstallation(response);
    if (installation === undefined) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    const brainIds = services.brains.listMountedBrains(installation.id).map(({ brain }) => brain.id);
    response.json({ memories: services.store.list({ brainIds, status: 'candidate' }) });
  });

  app.post('/v1/memories/:memoryId/approve', requireAdapter, (request, response) => {
    const { memoryId } = MemoryParametersSchema.parse(request.params);
    const input = ReviewCandidateRequestSchema.parse(request.body);
    const installation = authenticatedInstallation(response);
    if (installation === undefined) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    const brainIds = services.brains.listMountedBrains(installation.id).map(({ brain }) => brain.id);
    const candidate = services.store.get(memoryId, brainIds);
    if (candidate === undefined) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    if (candidate.status !== 'candidate') {
      response.status(409).json({ error: 'candidate_not_pending' });
      return;
    }
    if (!hasWriteAccess(response, services.brains, candidate.brainId)) {
      return;
    }
    const active = services.store.list({ brainIds: [candidate.brainId], status: 'active' });
    const resolution = assessMemoryConflict({ proposal: { ...candidate, status: 'active' }, existing: active });
    if (input.supersedeMemoryId !== undefined && resolution.action !== 'review') {
      response.status(400).json({ error: 'invalid_supersede' });
      return;
    }
    if (resolution.action === 'reuse') {
      response.status(409).json({ error: 'active_duplicate' });
      return;
    }
    if (resolution.action === 'review' && input.supersedeMemoryId !== resolution.memoryId) {
      response.status(400).json({ error: 'confirmation_required' });
      return;
    }
    response.json({ memory: services.store.approveCandidate(memoryId, input, brainIds) });
  });

  app.post('/v1/memories/:memoryId/reject', requireAdapter, (request, response) => {
    const { memoryId } = MemoryParametersSchema.parse(request.params);
    const input = ReviewCandidateRequestSchema.omit({ supersedeMemoryId: true }).parse(request.body);
    const installation = authenticatedInstallation(response);
    if (installation === undefined) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    const brainIds = services.brains.listMountedBrains(installation.id).map(({ brain }) => brain.id);
    const candidate = services.store.get(memoryId, brainIds);
    if (candidate === undefined) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    if (candidate.status !== 'candidate') {
      response.status(409).json({ error: 'candidate_not_pending' });
      return;
    }
    if (!hasWriteAccess(response, services.brains, candidate.brainId)) {
      return;
    }
    response.json({ memory: services.store.rejectCandidate(memoryId, input, brainIds) });
  });

  app.get('/v1/memories/:memoryId/history', requireAdapter, (request, response) => {
    const { memoryId } = MemoryParametersSchema.parse(request.params);
    const installation = authenticatedInstallation(response);
    if (installation === undefined) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    const brainIds = services.brains.listMountedBrains(installation.id).map(({ brain }) => brain.id);
    const memories = services.store.listHistory(memoryId, brainIds);
    if (memories.length === 0) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    response.json({ memories });
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

function beginBackupRestore(backup: BackupLifecycle): RequestHandler {
  return (request, response, next) => {
    if (!backup.beginRestore()) {
      response.status(503).json({ error: 'restore_in_progress' });
      return;
    }
    request.once('aborted', () => backup.cancelRestore());
    next();
  };
}

function cancelBackupRestore(backup: BackupLifecycle): ErrorRequestHandler {
  return (error, _request, _response, next) => {
    backup.cancelRestore();
    next(error);
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

function redactEventSource(source: z.infer<typeof EventSourceSchema>): z.infer<typeof EventSourceSchema> {
  return EventSourceSchema.parse(
    Object.fromEntries(
      Object.entries(source).map(([key, value]) => [key, value === undefined ? undefined : redactSensitiveText(value).redacted]),
    ),
  );
}

function redactMemoryScope(scope: z.infer<typeof MemoryScopeSchema>): z.infer<typeof MemoryScopeSchema> {
  return MemoryScopeSchema.parse(redactSensitiveJson(scope as unknown as JsonValue).redacted);
}

function capturedStructuredData(proposal: MemoryProposal): JsonValue {
  if (proposal.kind === 'preference') {
    return {
      domain: 'general',
      subject: 'user',
      dimension: proposal.canonicalText,
      value: proposal.canonicalText,
      strength: proposal.confidence,
      confidence: proposal.confidence,
    };
  }
  const packageManager = /^(?:this\s+)?project\s+(?:uses?|使用)\s+(.+)$/iu.exec(proposal.canonicalText)?.[1]
    ?? /^這個專案使用\s*(.+)$/u.exec(proposal.canonicalText)?.[1];
  return {
    subject: packageManager === undefined ? 'statement' : 'project',
    predicate: packageManager === undefined ? 'content' : 'package_manager',
    object: packageManager ?? proposal.canonicalText,
    confidence: proposal.confidence,
  };
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
