import {
  DecisionDataSchema,
  AgentInstallationSchema,
  EventSourceSchema,
  FactDataSchema,
  BrainKindSchema,
  BrainMountSchema,
  IsoDateSchema,
  IsoUtcDateTimeSchema,
  JsonValueSchema,
  MemoryUsageOutcomeSchema,
  OutcomeResultSchema,
  MemoryScopeSchema,
  NonEmptyTextSchema,
  PolicyDataSchema,
  PreferenceDataSchema,
  UuidV7Schema,
  createUuidV7,
  CaptureReceiptSchema,
  type CaptureReceipt,
  redactSensitiveJson,
  redactSensitiveText,
  type AgentInstallation,
  type JsonValue,
} from '@memlume/contracts';
import { ContextResolver } from '@memlume/context-resolver';
import type { SqliteDatabase } from '@memlume/database/internal';
import { EventBrainConflictError, EventJournal } from '@memlume/event-journal';
import { assessMemoryConflict, compileMemory, type MemoryProposal } from '@memlume/memory-compiler';
import { MemoryStore, OutcomeFeedbackRateLimitError, OutcomeMemoryAccessError, OutcomeReceiptError, OutcomeReceiptRateLimitError, OutcomeStore, SourceEventBrainMismatchError } from '@memlume/retrieval';
import { BrainStore } from '@memlume/shared-brains';
import { BrainImportConflictError, BrainImportRequiredError, FullBackupAuthenticationRequiredError, FullRestoreRequiredError, RestoreRecoveryError, verifyMarkdownBundle } from '@memlume/backup';
import { planCapture, type AtomPlan } from './capture-pipeline.js';
import { SemanticMemoryService } from './semantic-memory-service.js';
import { RoutingInboxStore } from '@memlume/shared-brains';
import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler, type Response } from 'express';
import { z, ZodError } from 'zod';

const AppendEventRequestSchema = z
  .object({
    brainId: UuidV7Schema,
    rawContent: z.string(),
    eventType: z.string(),
    source: EventSourceSchema.strict(),
    structuredData: JsonValueSchema.optional(),
    occurredAt: IsoUtcDateTimeSchema.optional(),
  })
  .strict();

const CaptureMemoryRequestSchema = AppendEventRequestSchema.extend({
  brainId: UuidV7Schema,
  scope: MemoryScopeSchema,
}).strict();

const AutomaticCaptureRequestSchema = z.object({
  captureId: NonEmptyTextSchema,
  rawContent: z.string(),
  eventType: NonEmptyTextSchema.default('user_message'),
  source: EventSourceSchema.strict(),
  actor: z.enum(['user', 'assistant', 'tool']).optional(),
  structuredData: JsonValueSchema.optional(),
  occurredAt: IsoUtcDateTimeSchema.optional(),
  workspacePath: NonEmptyTextSchema.optional(),
}).strict();

const MemoryRequestBaseSchema = z
  .object({
    brainId: UuidV7Schema,
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
    requestedBrainIds: z.array(UuidV7Schema).min(1).optional(),
  })
  .strict();

const RecordMemoryUsageRequestSchema = z
  .object({
    traceId: UuidV7Schema,
    taskId: NonEmptyTextSchema,
    retrievalRank: z.number().int().nonnegative().nullable().optional(),
    wasIncluded: z.boolean(),
    outcome: MemoryUsageOutcomeSchema.nullable().optional(),
  })
  .strict();

const RecordOutcomeRequestSchema = z
  .object({
    traceId: UuidV7Schema,
    taskId: NonEmptyTextSchema,
    result: OutcomeResultSchema,
    correctionType: NonEmptyTextSchema.nullable().optional(),
    correctionData: JsonValueSchema.nullable().optional(),
    usedMemoryIds: z.array(UuidV7Schema).min(1).max(256),
    usedToolIds: z.array(NonEmptyTextSchema).max(256),
  })
  .strict();

const RecordUsageOutcomeRequestSchema = z
  .object({
    traceId: UuidV7Schema,
    outcome: MemoryUsageOutcomeSchema,
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
  readonly database: SqliteDatabase;
  readonly journal: EventJournal;
  readonly store: MemoryStore;
  readonly resolver: ContextResolver;
  readonly outcomes: OutcomeStore;
  readonly brains: BrainStore;
  readonly setupToken?: string;
  readonly backup: BackupLifecycle;
  /** Unified semantic write boundary. Optional for v0.2-compatible test fixtures. */
  readonly semantic?: SemanticMemoryService;
  readonly routingInbox?: RoutingInboxStore;
}

export interface BackupLifecycle {
  create(input: { readonly brainId?: string; readonly password?: string }): Promise<Buffer>;
  /** Create a Markdown-authority v3 bundle without SQLite credentials. */
  createMarkdown?(): Promise<Uint8Array>;
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
  const userConfirmations = new UserConfirmationStore(services.database);
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
  app.post('/v1/setup/backups/v3', requireSetup, async (_request, response) => {
    if (services.backup.createMarkdown === undefined) {
      response.status(503).json({ error: 'markdown_backup_unavailable' });
      return;
    }
    const bundle = await services.backup.createMarkdown();
    response
      .status(200)
      .set('content-type', 'application/vnd.memlume.v3')
      .set('content-disposition', 'attachment; filename="memlume-v3.memlume"')
      .send(Buffer.from(bundle));
  });
  app.post(
    '/v1/setup/backups/v3/verify',
    requireSetup,
    express.raw({ type: ['application/vnd.memlume.v3', 'application/octet-stream'], limit: '128mb' }),
    (request: Request, response: Response) => {
      if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
        response.status(400).json({ error: 'invalid_backup' });
        return;
      }
      try {
        const verified = verifyMarkdownBundle(request.body);
        response.json({ manifest: verified.manifest, files: verified.manifest.files });
      } catch {
        response.status(400).json({ error: 'invalid_backup' });
      }
    },
  );
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

  /**
   * Automatic capture is the default Host path.  The request contains only
   * workspace/evidence; Brain selection happens from the daemon-owned mount
   * catalog and ambiguous atoms are persisted in the durable Inbox.
   */
  app.post('/v1/capture', requireAdapter, async (request, response) => {
    const input = AutomaticCaptureRequestSchema.parse(request.body);
    const installation = authenticatedInstallation(response);
    if (installation === undefined) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    const catalog = captureCatalog(services.brains, installation.id);
    const plan = await planCapture({
      captureId: input.captureId,
      rawContent: redactSensitiveText(input.rawContent).redacted,
      eventType: input.eventType,
      source: redactEventSource(input.source),
      actor: input.actor,
      catalog,
    });
    const semantic = services.semantic ?? new SemanticMemoryService({ journal: services.journal, store: services.store });
    const receipt = await persistAutomaticCapture(services, semantic, input, plan.atoms, installation.id);
    response.status(201).json({ receipt: CaptureReceiptSchema.parse(receipt) });
  });

  app.post('/v1/events', requireAdapter, (request, response) => {
    const input = AppendEventRequestSchema.parse(request.body);
    const brainId = input.brainId;
    if (!hasWriteAccess(response, services.brains, brainId)) {
      return;
    }
    const rawContent = redactSensitiveText(input.rawContent).redacted;
    const structuredData = input.structuredData === undefined ? undefined : redactSensitiveJson(input.structuredData).redacted;
    const source = redactEventSource(input.source);
    const semantic = services.semantic ?? new SemanticMemoryService({ journal: services.journal, store: services.store });
    response.status(201).json({ event: semantic.appendEvent({ ...input, brainId, rawContent, source, ...(structuredData === undefined ? {} : { structuredData }) }) });
  });

  app.post('/v1/memories', requireAdapter, (request, response) => {
    const input = SaveMemoryRequestSchema.parse(request.body);
    const brainId = input.brainId;
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
    const installation = authenticatedInstallation(response);
    const requiresCandidate = installation !== undefined
      && inferenceClientTypes.has(installation.clientType)
      && !hasUserMemoryConfirmation(request, services.setupToken, input, userConfirmations);
    const semantic = services.semantic ?? new SemanticMemoryService({ journal: services.journal, store: services.store });
    const memory = semantic.saveMemory({ ...sanitized, brainId }, requiresCandidate ? 'candidate' : 'active');
    response.status(201).json({ memory });
  });

  app.post('/v1/memories/candidate', requireAdapter, (request, response) => {
    const input = SaveMemoryRequestSchema.parse(request.body);
    const brainId = input.brainId;
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
    const semantic = services.semantic ?? new SemanticMemoryService({ journal: services.journal, store: services.store });
    response.status(201).json({ memory: semantic.saveMemory({ ...sanitized, brainId }, 'candidate') });
  });

  app.post('/v1/memories/capture', requireAdapter, (request, response) => {
    const input = CaptureMemoryRequestSchema.parse(request.body);
    const brainId = input.brainId;
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
    if (brainIds.length === 0) {
      response.status(403).json({ error: 'forbidden' });
      return;
    }
    response.json({ memories: services.store.list({ brainIds, status: 'candidate' }) });
  });

  app.post('/v1/memories/:memoryId/approve', requireSetup, requireAdapter, (request, response) => {
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

  app.post('/v1/memories/:memoryId/reject', requireSetup, requireAdapter, (request, response) => {
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
    if (brainIds.length === 0) {
      response.status(403).json({ error: 'forbidden' });
      return;
    }
    response.json({ memories: services.store.search(q, { brainIds }) });
  });

  app.post('/v1/context/resolve', requireAdapter, (request, response) => {
    const installation = authenticatedInstallation(response);
    if (installation === undefined) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    const { requestedBrainIds, ...contextInput } = ResolveContextRequestSchema.parse(request.body);
    const mountedBrainIds = contextBrainIds(services.brains, installation.id);
    const brainIds = requestedBrainIds === undefined ? mountedBrainIds : [...new Set(requestedBrainIds)];
    if (brainIds.length === 0 || brainIds.some((brainId) => !mountedBrainIds.includes(brainId))) {
      response.status(403).json({ error: 'forbidden' });
      return;
    }
    const context = services.resolver.resolve({ ...contextInput, brainIds });
    try {
      services.outcomes.issueReceipt({
        traceId: context.traceId,
        agentId: installation.id,
        brainIds,
        sourceMemoryIds: context.explanation.sourceMemoryIds,
      });
    } catch (error) {
      if (error instanceof OutcomeReceiptRateLimitError) {
        response.status(429).json({ error: 'rate_limited' });
        return;
      }
      throw error;
    }
    response.json({ context });
  });

  app.post('/v1/memories/:memoryId/usage', requireAdapter, (request, response) => {
    const { memoryId } = MemoryParametersSchema.parse(request.params);
    const input = RecordMemoryUsageRequestSchema.parse(request.body);
    const installation = authenticatedInstallation(response);
    if (installation === undefined) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    const brainIds = writableBrainIds(services.brains, installation.id);
    try {
      const usage = services.outcomes.recordUsageWithReceipt({
        memoryId,
        taskId: input.taskId,
        agentId: installation.id,
        retrievalRank: input.retrievalRank,
        wasIncluded: input.wasIncluded,
        outcome: input.outcome,
      }, brainIds, input.traceId, installation.id);
      response.status(201).json({ usage });
    } catch (error) {
      if (error instanceof OutcomeFeedbackRateLimitError) {
        response.status(429).json({ error: 'rate_limited' });
        return;
      }
      if (error instanceof OutcomeMemoryAccessError || error instanceof OutcomeReceiptError) {
        response.status(403).json({ error: 'forbidden' });
        return;
      }
      throw error;
    }
  });

  app.post('/v1/memory-usage/:usageId/outcome', requireAdapter, (request, response) => {
    const { usageId } = z.object({ usageId: UuidV7Schema }).strict().parse(request.params);
    const { traceId, outcome } = RecordUsageOutcomeRequestSchema.parse(request.body);
    const installation = authenticatedInstallation(response);
    if (installation === undefined) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    const brainIds = writableBrainIds(services.brains, installation.id);
    try {
      response.status(201).json({ usage: services.outcomes.setUsageOutcomeWithReceipt(usageId, outcome, brainIds, traceId, installation.id) });
    } catch (error) {
      if (error instanceof OutcomeFeedbackRateLimitError) {
        response.status(429).json({ error: 'rate_limited' });
        return;
      }
      if (error instanceof OutcomeMemoryAccessError || error instanceof OutcomeReceiptError) {
        response.status(403).json({ error: 'forbidden' });
        return;
      }
      throw error;
    }
  });

  app.post('/v1/outcomes', requireAdapter, (request, response) => {
    const input = RecordOutcomeRequestSchema.parse(request.body);
    const installation = authenticatedInstallation(response);
    if (installation === undefined) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    const brainIds = writableBrainIds(services.brains, installation.id);
    const correctionData = input.correctionData === undefined || input.correctionData === null
      ? input.correctionData
      : redactSensitiveJson(input.correctionData).redacted;
    const correctionType = input.correctionType === undefined || input.correctionType === null
      ? input.correctionType
      : redactSensitiveText(input.correctionType).redacted;
    try {
      const outcome = services.outcomes.recordOutcomeWithReceipt({
        ...input,
        agentId: installation.id,
        ...(correctionData === undefined ? {} : { correctionData }),
        ...(correctionType === undefined ? {} : { correctionType }),
      }, brainIds, input.traceId, installation.id);
      response.status(201).json({ outcome });
    } catch (error) {
      if (error instanceof OutcomeFeedbackRateLimitError) {
        response.status(429).json({ error: 'rate_limited' });
        return;
      }
      if (error instanceof OutcomeMemoryAccessError || error instanceof OutcomeReceiptError) {
        response.status(403).json({ error: 'forbidden' });
        return;
      }
      throw error;
    }
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

function writableBrainIds(brains: BrainStore, agentInstallationId: string): string[] {
  return brains
    .listMountedBrains(agentInstallationId)
    .filter(({ access }) => access === 'read_write')
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
  if (proposal.kind === 'policy' && proposal.policyData !== undefined) {
    return proposal.policyData;
  }
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

const inferenceClientTypes = new Set(['hermes', 'codex', 'openclaw', 'claude-code']);

function captureCatalog(brains: BrainStore, installationId: string): readonly {
  readonly brainId: string;
  readonly kind: 'personal' | 'project';
  readonly role: 'personal' | 'primary' | 'linked';
  readonly access: 'read' | 'read_write';
  readonly name: string;
}[] {
  const mounted = brains.listMountedBrains(installationId);
  let primaryAssigned = false;
  return mounted.map(({ brain, access }) => {
    if (brain.kind === 'personal') {
      return { brainId: brain.id, kind: brain.kind, role: 'personal' as const, access, name: brain.name };
    }
    const role = primaryAssigned ? 'linked' as const : 'primary' as const;
    primaryAssigned = true;
    return { brainId: brain.id, kind: brain.kind, role, access, name: brain.name };
  });
}

async function persistAutomaticCapture(
  services: DaemonServices,
  semantic: SemanticMemoryService,
  input: z.infer<typeof AutomaticCaptureRequestSchema>,
  atoms: readonly AtomPlan[],
  installationId: string,
): Promise<CaptureReceipt> {
  const atomMemoryIds = new Map<string, string>();
  for (const atom of atoms) {
    if (atom.route.status === 'routing_required') {
      if (services.routingInbox !== undefined) {
        const now = new Date().toISOString();
        services.routingInbox.addPending({
          recordType: 'routing_inbox',
          schemaVersion: '0.3',
          recordId: createUuidV7(),
          captureId: input.captureId,
          atomKey: atom.atomKey,
          status: 'routing_required',
          statement: redactSensitiveText(atom.canonicalText).redacted,
          evidenceRef: atom.evidence,
          createdAt: now,
          updatedAt: now,
          ...(atom.route.status === 'routing_required' && atom.route.reason === 'unknown_project' ? {} : {}),
        });
      }
      continue;
    }
    if (atom.route.status !== 'routed' || (atom.status !== 'active' && atom.status !== 'candidate')) continue;
    const brainId = atom.route.brainId;
    const event = {
      brainId,
      rawContent: atom.text,
      eventType: input.eventType,
      source: { ...redactEventSource(input.source), reference: `${input.captureId}:${atom.atomKey}` },
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    };
    if (atom.kind === 'event') {
      semantic.appendEvent(event);
      continue;
    }
    const kind = atom.kind === 'capability' ? 'fact' : atom.kind;
    const structuredData = structuredDataForAtom(kind, atom.canonicalText, atom.confidence);
    const memory = semantic.capture({
      event,
      memory: {
        brainId,
        kind,
        canonicalText: atom.canonicalText,
        structuredData,
        scope: atom.scope === 'project' ? { level: 'project', projectId: atom.route.brainId } : { level: 'global' },
        confidence: atom.confidence,
        explicitness: atom.explicitness,
      },
      status: atom.status,
    }).memory;
    if (memory !== undefined) atomMemoryIds.set(atom.atomKey, memory.id);
  }
  const receipt = { ...servicesReceiptForAtoms(atoms, input.captureId), atoms: servicesReceiptForAtoms(atoms, input.captureId).atoms.map((atom) => {
    const memoryId = atomMemoryIds.get(atom.atomKey);
    return memoryId === undefined ? atom : { ...atom, memoryId };
  }) };
  return CaptureReceiptSchema.parse(receipt);
}

function servicesReceiptForAtoms(atoms: readonly AtomPlan[], captureId: string): CaptureReceipt {
  const now = new Date().toISOString();
  const receiptAtoms = atoms.map((atom) => ({
    atomKey: atom.atomKey,
    status: atom.status,
    ...(atom.route.status === 'routed' ? { brainId: atom.route.brainId } : {}),
    ...(atom.status === 'routing_required' ? { reason: 'routing_required' } : {}),
  }));
  return CaptureReceiptSchema.parse({
    captureId,
    sourceReference: captureId,
    status: aggregateCaptureStatus(receiptAtoms.map((atom) => atom.status)),
    atoms: receiptAtoms,
    createdAt: now,
    updatedAt: now,
  });
}

function aggregateCaptureStatus(statuses: readonly string[]): CaptureReceipt['status'] {
  if (statuses.length === 0) return 'ignored';
  const order: readonly CaptureReceipt['status'][] = ['failed', 'rejected', 'routing_required', 'candidate', 'event_only', 'active', 'queued', 'ignored'];
  return order.find((status) => statuses.includes(status)) ?? 'failed';
}

function structuredDataForAtom(kind: 'fact' | 'preference' | 'decision', text: string, confidence: number): JsonValue {
  if (kind === 'preference') {
    return { domain: 'general', subject: 'user', dimension: text, value: text, strength: confidence, confidence } as JsonValue;
  }
  if (kind === 'decision') {
    return { title: text, status: 'active', rationale: [text] } as JsonValue;
  }
  return { subject: 'statement', predicate: 'content', object: text, confidence } as JsonValue;
}

class UserConfirmationStore {
  constructor(private readonly database: SqliteDatabase) {}

  consume(signature: string, expiresAt: string): boolean {
    const consumedAt = new Date().toISOString();
    return this.database.transaction(() => {
      this.database.prepare('DELETE FROM user_confirmations WHERE expires_at <= ?').run(consumedAt);
      const existing = this.database
        .prepare('SELECT 1 FROM user_confirmations WHERE signature = ?')
        .get(signature);
      if (existing !== undefined) {
        return false;
      }
      this.database
        .prepare('INSERT INTO user_confirmations (signature, consumed_at, expires_at) VALUES (?, ?, ?)')
        .run(signature, consumedAt, expiresAt);
      return true;
    })();
  }
}

function hasUserMemoryConfirmation(request: Request, setupToken: string | undefined, body: unknown, confirmations: UserConfirmationStore): boolean {
  if (setupToken === undefined || setupToken.length === 0) return false;
  const actual = request.get('x-memlume-user-confirmation');
  const issuedAt = request.get('x-memlume-user-confirmation-at');
  if (actual === undefined || !/^[0-9a-f]{64}$/u.test(actual) || issuedAt === undefined) return false;
  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedAtMs) || Math.abs(Date.now() - issuedAtMs) > 5 * 60 * 1000) return false;
  const expected = createHmac('sha256', setupToken).update(canonicalJson({ body, issuedAt })).digest('hex');
  return tokensMatch(expected, actual)
    && confirmations.consume(actual, new Date(issuedAtMs + 5 * 60 * 1000).toISOString());
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
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

  if (error instanceof OutcomeMemoryAccessError) {
    response.status(403).json({ error: 'forbidden' });
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
