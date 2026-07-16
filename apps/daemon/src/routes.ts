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
  ReadSetSchema,
  SemanticRecordSchema,
  AdapterCallbackSchema,
  AdapterProtocolVersionSchema,
  DEFAULT_PERSONAL_BRAIN_ID,
  type CaptureReceipt,
  type ReadSet,
  redactSensitiveJson,
  redactSensitiveText,
  type AgentInstallation,
  type JsonValue,
} from '@memlume/contracts';
import { ContextResolver, planReadSet } from '@memlume/context-resolver';
import type { SqliteDatabase } from '@memlume/database/internal';
import { EventBrainConflictError, EventJournal } from '@memlume/event-journal';
import { assessMemoryConflict, compileMemory, resolveApproval, type MemoryProposal } from '@memlume/memory-compiler';
import { MemoryStore, OutcomeFeedbackRateLimitError, OutcomeMemoryAccessError, OutcomeReceiptError, OutcomeReceiptRateLimitError, OutcomeStore, SourceEventBrainMismatchError } from '@memlume/retrieval';
import { BrainStore, MarkdownRecordStore, ProjectBindingStore, RoutingInboxStore, scanMarkdownRecords } from '@memlume/shared-brains';
import { BrainImportConflictError, BrainImportRequiredError, FullBackupAuthenticationRequiredError, FullRestoreRequiredError, RestoreRecoveryError, verifyMarkdownBundle } from '@memlume/backup';
import { planCapture, type AtomPlan } from './capture-pipeline.js';
import { SemanticMemoryService } from './semantic-memory-service.js';
import { TurnRuntimeStore } from './turn-runtime-store.js';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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
  sessionId: NonEmptyTextSchema.optional(),
  turnId: NonEmptyTextSchema.optional(),
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
    workspacePath: NonEmptyTextSchema.optional(),
    taskId: NonEmptyTextSchema.optional(),
    agentType: NonEmptyTextSchema.optional(),
    subagentId: NonEmptyTextSchema.optional(),
    childGoal: z.string().nullable().optional(),
    parentReadSet: ReadSetSchema.optional(),
    /** Deprecated v0.2 compatibility input; v0.3 callback requests ignore it. */
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
const SetupInitRequestSchema = z.object({
  workspacePath: NonEmptyTextSchema,
  name: NonEmptyTextSchema.optional(),
}).strict();
const CreateProjectRequestSchema = z.object({ name: NonEmptyTextSchema }).strict();
const BindProjectRequestSchema = z.object({
  workspacePath: NonEmptyTextSchema,
  role: z.enum(['primary', 'linked']).default('linked'),
  access: z.enum(['read', 'read_write']).optional(),
}).strict();
const AddProjectAliasRequestSchema = z.object({ alias: NonEmptyTextSchema }).strict();
const InspectProjectQuerySchema = z.object({ workspacePath: NonEmptyTextSchema }).strict();
const EditRecordRequestSchema = z.object({
  text: NonEmptyTextSchema.optional(),
  repair: z.boolean().default(false),
}).strict();
const ReindexRequestSchema = z.object({ repair: z.boolean().default(false) }).strict();

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
const RouteInboxRequestSchema = z.object({
  brainId: UuidV7Schema,
  activate: z.boolean().default(false),
}).strict();
const RuntimeFinalRequestSchema = z.object({
  sessionId: NonEmptyTextSchema,
  turnId: NonEmptyTextSchema,
  traceId: UuidV7Schema.optional(),
  finalAnswer: z.string().min(1).max(65536),
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
  /** Server-owned project bindings used to derive ReadSet grants. */
  readonly projects?: ProjectBindingStore;
  /** Markdown root used by maintenance and explicit Inbox routing. */
  readonly dataRoot?: string;
  readonly reindex?: (options?: { readonly repair?: boolean }) => unknown;
  readonly runtime?: TurnRuntimeStore;
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
    response.json({ status: 'ok', service: 'memlume' });
  });
  app.get('/v1/status', (_request, response) => {
    const hosts = services.brains.listInstallations().map((installation) => {
      const heartbeats = services.brains.listHeartbeats(installation.id);
      const current = currentAdapterVersion(installation.clientType);
      const callbacks = new Set(heartbeats
        .filter((heartbeat) => heartbeat.protocolVersion === current.protocolVersion && heartbeat.adapterVersion === current.adapterVersion)
        .map((heartbeat) => heartbeat.callback));
      const state = callbacks.has('beforeTask') && callbacks.has('onUserMessage')
        ? 'active'
        : installation.clientType === 'codex'
          ? 'pending_trust'
          : 'degraded';
      return {
        clientType: installation.clientType,
        installationId: installation.installationId,
        profileId: installation.profileId,
        state,
        protocolVersion: current.protocolVersion,
        adapterVersion: current.adapterVersion,
        callbacks: Object.fromEntries(['beforeTask', 'onUserMessage', 'onSubagentStart'].map((callback) => {
          const latest = heartbeats
            .filter((heartbeat) => heartbeat.callback === callback && heartbeat.protocolVersion === current.protocolVersion && heartbeat.adapterVersion === current.adapterVersion)
            .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0];
          return [callback, latest === undefined ? {} : { lastSeen: latest.lastSeenAt }];
        })),
        ...(state === 'active' ? {} : { reason: installation.clientType === 'codex' ? 'Trust the Codex hooks, then send one task and one user message.' : 'Send the missing lifecycle callback to confirm activation.' }),
      };
    });
    const pendingInbox = services.routingInbox?.listPending().length ?? 0;
    const captureCounts = services.database.prepare('SELECT status, COUNT(*) AS count FROM capture_atoms GROUP BY status').all() as Array<{ status: string; count: number }>;
    response.json({
      daemon: 'ok',
      service: 'memlume',
      hosts,
      brains: services.brains.listBrains().length,
      routingRequired: pendingInbox,
      captures: Object.fromEntries(captureCounts.map(({ status, count }) => [status, count])),
      runtime: { available: services.runtime !== undefined, ttlHours: 24, maxBytes: 64 * 1024 },
      backup: { markdownV3: services.backup.createMarkdown !== undefined },
    });
  });

  const requireSetup = requireSetupToken(services.setupToken);
  const userConfirmations = new UserConfirmationStore(services.database);
  app.post('/v1/setup/brains', requireSetup, (request, response) => {
    response.status(201).json({ brain: services.brains.createBrain(CreateBrainRequestSchema.parse(request.body)) });
  });
  app.get('/v1/setup/brains', requireSetup, (_request, response) => {
    response.json({ brains: services.brains.listBrains() });
  });
  app.post('/v1/setup/init', requireSetup, (request, response) => {
    const projects = services.projects;
    if (projects === undefined) {
      response.status(503).json({ error: 'project_bindings_unavailable' });
      return;
    }
    const input = SetupInitRequestSchema.parse(request.body);
    const existingBindings = projects.resolveWorkspace(input.workspacePath);
    const existingPrimary = existingBindings.find((binding) => binding.role === 'primary');
    if (existingPrimary !== undefined) {
      response.json({
        personalBrainId: DEFAULT_PERSONAL_BRAIN_ID,
        project: services.brains.listBrains().find(({ id }) => id === existingPrimary.brainId),
        binding: existingPrimary,
        created: false,
      });
      return;
    }
    const project = projects.findByProjectKey('canonical_path', input.workspacePath)
      ?? projects.createProject(input.name ?? projectNameFromWorkspace(input.workspacePath));
    if (projects.findByProjectKey('canonical_path', input.workspacePath) === undefined) {
      projects.addProjectKey({ brainId: project.id, keyType: 'canonical_path', value: input.workspacePath });
    }
    const binding = projects.bindWorkspace({ workspacePath: input.workspacePath, brainId: project.id, role: 'primary', access: 'read_write' });
    response.status(201).json({ personalBrainId: DEFAULT_PERSONAL_BRAIN_ID, project, binding, created: true });
  });
  app.post('/v1/setup/projects', requireSetup, (request, response) => {
    const projects = services.projects;
    if (projects === undefined) {
      response.status(503).json({ error: 'project_bindings_unavailable' });
      return;
    }
    response.status(201).json({ project: projects.createProject(CreateProjectRequestSchema.parse(request.body).name) });
  });
  app.post('/v1/setup/projects/:brainId/bindings', requireSetup, (request, response) => {
    const projects = services.projects;
    if (projects === undefined) {
      response.status(503).json({ error: 'project_bindings_unavailable' });
      return;
    }
    const { brainId } = z.object({ brainId: UuidV7Schema }).strict().parse(request.params);
    response.status(201).json({ binding: projects.bindWorkspace({ brainId, ...BindProjectRequestSchema.parse(request.body) }) });
  });
  app.post('/v1/setup/projects/:brainId/aliases', requireSetup, (request, response) => {
    const projects = services.projects;
    if (projects === undefined) {
      response.status(503).json({ error: 'project_bindings_unavailable' });
      return;
    }
    const { brainId } = z.object({ brainId: UuidV7Schema }).strict().parse(request.params);
    response.status(201).json({ alias: projects.addAlias(brainId, AddProjectAliasRequestSchema.parse(request.body).alias) });
  });
  app.get('/v1/setup/projects/inspect', requireSetup, (request, response) => {
    const projects = services.projects;
    if (projects === undefined) {
      response.status(503).json({ error: 'project_bindings_unavailable' });
      return;
    }
    const { workspacePath } = InspectProjectQuerySchema.parse(request.query);
    response.json({ projects: projects.inspect(), bindings: projects.listWorkspace(workspacePath) });
  });
  app.post('/v1/setup/reindex', requireSetup, (request, response) => {
    if (services.reindex === undefined) {
      response.status(503).json({ error: 'reindex_unavailable' });
      return;
    }
    const result = services.reindex(ReindexRequestSchema.parse(request.body));
    response.json({ projected: (result as { readonly projected?: unknown }).projected ?? [] });
  });
  app.post('/v1/setup/records/:recordId/edit', requireSetup, (request, response) => {
    const input = EditRecordRequestSchema.parse(request.body);
    if (input.text === undefined) {
      response.json({ recordId: request.params.recordId, status: 'inspected' });
      return;
    }
    if (!input.repair || services.dataRoot === undefined) {
      response.status(409).json({ error: 'repair_required' });
      return;
    }
    const record = scanMarkdownRecords(services.dataRoot).find(({ record }) => record.recordId === request.params.recordId)?.record;
    if (record === undefined || record.recordType !== 'semantic') {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    const existing = services.store.get(record.memoryId, [record.brainId]);
    if (existing === undefined) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    const memory = services.store.update(record.memoryId, {
      canonicalText: input.text,
      actor: 'memlume-cli',
      reason: 'Explicit Markdown record repair.',
    }, [record.brainId]);
    response.status(201).json({ recordId: memory.id, memory });
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
    response.json({
      ...asRecord(services.backup.diagnostics()),
      heartbeats: services.brains.listHeartbeats(),
      routingInbox: {
        pending: services.routingInbox?.listPending().length ?? 0,
        resolved: services.routingInbox?.listResolved().length ?? 0,
        quarantine: services.routingInbox?.listQuarantine().length ?? 0,
      },
      captures: services.database.prepare('SELECT status, COUNT(*) AS count FROM capture_atoms GROUP BY status').all(),
    });
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

  app.post('/v1/runtime/final', requireAdapter, async (request, response) => {
    const installation = authenticatedInstallation(response);
    if (installation === undefined) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (services.runtime === undefined) {
      response.status(503).json({ error: 'runtime_unavailable' });
      return;
    }
    const input = RuntimeFinalRequestSchema.parse(request.body);
    const status = await services.runtime.save({
      installationId: installation.id,
      sessionId: input.sessionId,
      turnId: input.turnId,
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      finalAnswer: input.finalAnswer,
    });
    response.status(status === 'saved' ? 201 : 400).json({ status });
  });

  app.post('/v1/inbox/:recordId/route', requireAdapter, (request, response) => {
    const { recordId } = z.object({ recordId: UuidV7Schema }).strict().parse(request.params);
    const input = RouteInboxRequestSchema.parse(request.body);
    const installation = authenticatedInstallation(response);
    if (installation === undefined) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (services.routingInbox === undefined || services.dataRoot === undefined || services.reindex === undefined) {
      response.status(503).json({ error: 'routing_unavailable' });
      return;
    }
    if (!hasWriteAccess(response, services.brains, input.brainId)) return;
    const pending = services.routingInbox.readPending(recordId);
    if (pending === undefined) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    const brain = services.brains.listBrains().find(({ id }) => id === input.brainId);
    if (brain === undefined) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    const now = new Date().toISOString();
    const target = SemanticRecordSchema.parse({
      schemaVersion: '0.3',
      recordType: 'semantic',
      recordId: createUuidV7(),
      memoryId: createUuidV7(),
      brainId: input.brainId,
      status: input.activate ? 'active' : 'candidate',
      kind: 'fact',
      createdAt: now,
      updatedAt: now,
      captureId: pending.captureId,
      atomKey: pending.atomKey,
      sourceAtom: pending.statement,
      canonicalText: pending.statement,
      scope: brain.kind === 'project' ? { level: 'project', projectId: brain.id } : { level: 'global' },
      confidence: 1,
      explicitness: 1,
      structuredData: { subject: 'routed', predicate: 'content', object: pending.statement, confidence: 1 },
    });
    const markdown = new MarkdownRecordStore({ rootDir: services.dataRoot });
    const resolution = services.routingInbox.resolve(recordId, target, (record) => markdown.append(record));
    services.reindex({ repair: false });
    response.status(201).json({ resolution, record: target });
  });

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
    const runtimeSessionId = input.sessionId ?? input.source.conversationId;
    const runtimeTurnId = input.turnId ?? input.source.messageId;
    let captureInput = input;
    let approvalConsumed = false;
    if (services.runtime !== undefined && input.actor === 'user' && runtimeSessionId !== undefined && runtimeTurnId !== undefined) {
      const buffered = await services.runtime.read({ installationId: installation.id, sessionId: runtimeSessionId, turnId: runtimeTurnId });
      if (buffered !== undefined) {
        const resolution = await resolveApproval({
          finalAnswer: buffered.finalAnswer,
          approval: input.rawContent,
          finalCapturedAt: buffered.savedAt,
        });
        if (resolution.status === 'rejected') {
          const now = new Date().toISOString();
          response.status(201).json({ receipt: CaptureReceiptSchema.parse({
            captureId: resolution.approvalKey,
            sourceReference: input.source.reference ?? resolution.approvalKey,
            status: 'rejected',
            atoms: [],
            createdAt: now,
            updatedAt: now,
          }) });
          return;
        }
        if (resolution.status === 'active' && resolution.content !== undefined) {
          // A short approval authorizes the buffered final; it is the
          // authorized text, not the word "可以", that enters atomization.
          captureInput = { ...input, captureId: resolution.approvalKey, rawContent: resolution.content, actor: 'user' };
          approvalConsumed = true;
        }
      }
    }
    const redaction = redactSensitiveText(captureInput.rawContent);
    if (redaction.detected) {
      const now = new Date().toISOString();
      response.status(201).json({ receipt: CaptureReceiptSchema.parse({
        captureId: captureInput.captureId,
        sourceReference: captureInput.source.reference ?? captureInput.captureId,
        status: 'rejected',
        atoms: [],
        createdAt: now,
        updatedAt: now,
      }) });
      return;
    }
    const safeInput = { ...captureInput, rawContent: redaction.redacted };
    const catalog = captureCatalog(services, installation.id, safeInput.workspacePath);
    const plan = await planCapture({
      captureId: safeInput.captureId,
      rawContent: redaction.redacted,
      eventType: safeInput.eventType,
      source: redactEventSource(safeInput.source),
      actor: safeInput.actor,
      ...(approvalConsumed ? { authorized: true } : {}),
      catalog,
    });
    const semantic = services.semantic ?? new SemanticMemoryService({ journal: services.journal, store: services.store });
    const receipt = await persistAutomaticCapture(services, semantic, safeInput, plan.receipt.sourceReference, plan.atoms, installation.id);
    if (services.runtime !== undefined && approvalConsumed && receipt.status !== 'rejected' && receipt.status !== 'failed' && runtimeSessionId !== undefined && runtimeTurnId !== undefined) {
      await services.runtime.clearAfterCapture({ installationId: installation.id, sessionId: runtimeSessionId, turnId: runtimeTurnId }, 'saved');
    }
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

  app.delete('/v1/memories/:memoryId', requireAdapter, (request, response) => {
    const { memoryId } = MemoryParametersSchema.parse(request.params);
    const installation = authenticatedInstallation(response);
    if (installation === undefined) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    const brainIds = writableBrainIds(services.brains, installation.id);
    const memory = services.store.get(memoryId, brainIds);
    if (memory === undefined) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    try {
      const forgotten = services.store.forget(memoryId, {
        actor: installation.clientType,
        reason: 'Explicit forget request from the authenticated adapter.',
      }, [memory.brainId]);
      response.status(201).json({ memory: forgotten, status: 'forgotten' });
    } catch (error) {
      if (error instanceof Error && error.message.includes('markdown_authority')) {
        response.status(503).json({ error: 'markdown_authority_required' });
        return;
      }
      throw error;
    }
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
    const input = ResolveContextRequestSchema.parse(request.body);
    const legacyRequest = request.get('x-memlume-protocol-version') === undefined;
    if (legacyRequest) {
      const mountedBrainIds = contextBrainIds(services.brains, installation.id);
      const requestedBrainIds = input.requestedBrainIds;
      const brainIds = requestedBrainIds === undefined ? mountedBrainIds : [...new Set(requestedBrainIds)];
      if (brainIds.length === 0 || brainIds.some((brainId) => !mountedBrainIds.includes(brainId))) {
        response.status(403).json({ error: 'forbidden' });
        return;
      }
      const { requestedBrainIds: _requested, ...legacyContextInput } = input;
      const context = services.resolver.resolve({ ...legacyContextInput, brainIds });
      try {
        services.outcomes.issueReceipt({ traceId: context.traceId, agentId: installation.id, brainIds, sourceMemoryIds: context.explanation.sourceMemoryIds });
      } catch (error) {
        if (!(error instanceof OutcomeReceiptRateLimitError)) throw error;
      }
      response.json({ context });
      return;
    }
    const readSet = planServerReadSet(services, installation.id, input);
    const { workspacePath: _workspacePath, taskId: _taskId, agentType: _agentType, subagentId: _subagentId, childGoal: _childGoal, parentReadSet: _parentReadSet, requestedBrainIds: _requestedBrainIds, ...contextInput } = input;
    const context = services.resolver.resolve({ ...contextInput, readSet });
    let feedbackUnavailable = false;
    try {
      if (readSet.entries.length > 0) {
        services.outcomes.issueReceipt({
          traceId: context.traceId,
          agentId: installation.id,
          brainIds: readSet.entries.map(({ brainId }) => brainId),
          sourceMemoryIds: context.explanation.sourceMemoryIds,
        });
      }
    } catch (error) {
      if (error instanceof OutcomeReceiptRateLimitError) {
        feedbackUnavailable = true;
      } else {
        throw error;
      }
    }
    response.json({ context, readSet, ...(feedbackUnavailable ? { feedbackUnavailable: true } : {}) });
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
      const callbackHeader = request.get('x-memlume-callback');
      const protocolHeader = request.get('x-memlume-protocol-version');
      const adapterHeader = request.get('x-memlume-adapter-version');
      const callbackHeadersPresent = callbackHeader !== undefined || protocolHeader !== undefined || adapterHeader !== undefined;
      if (callbackHeadersPresent) {
        const callback = AdapterCallbackSchema.safeParse(callbackHeader);
        const protocolVersion = AdapterProtocolVersionSchema.safeParse(protocolHeader);
        const adapterVersion = NonEmptyTextSchema.safeParse(adapterHeader);
        if (!callback.success || !protocolVersion.success || !adapterVersion.success) {
          response.status(400).json({ error: 'invalid_callback' });
          return;
        }
        brains.recordHeartbeat({
          agentInstallationId: agentInstallation.id,
          callback: callback.data,
          protocolVersion: protocolVersion.data,
          adapterVersion: adapterVersion.data,
        });
      }
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

function planServerReadSet(
  services: DaemonServices,
  installationId: string,
  input: z.infer<typeof ResolveContextRequestSchema>,
): ReadSet {
  const mounted = services.brains.listMountedBrains(installationId);
  const inspections = services.projects?.inspect() ?? [];
  const inspectionById = new Map(inspections.map((inspection) => [inspection.brain.id, inspection]));
  const catalog = mounted.map(({ brain, access }) => ({
    brainId: brain.id,
    kind: brain.kind,
    name: brain.name,
    access,
    aliases: inspectionById.get(brain.id)?.aliases ?? [],
  }));
  const workspaceBindings = input.workspacePath === undefined || services.projects === undefined
    ? []
    : services.projects.resolveWorkspace(input.workspacePath);
  const mountedProjectIds = catalog.filter(({ kind }) => kind === 'project').map(({ brainId }) => brainId);
  const primaryProjectId = workspaceBindings.find(({ role, brainId }) => role === 'primary' && mountedProjectIds.includes(brainId))?.brainId
    ?? (input.workspacePath === undefined ? mountedProjectIds[0] : undefined);
  const linkedProjectIds = workspaceBindings
    .filter(({ role, brainId }) => role === 'linked' && mountedProjectIds.includes(brainId))
    .map(({ brainId }) => brainId)
    .filter((brainId) => brainId !== primaryProjectId);
  const fallbackLinked = input.workspacePath === undefined
    ? mountedProjectIds.filter((brainId) => brainId !== primaryProjectId)
    : [];
  const personalBrainId = catalog.find(({ kind }) => kind === 'personal')?.brainId;
  const probe = [input.task ?? '', input.intent, ...(input.entities ?? [])].join(' ').trim();
  const personalRelevant = personalBrainId !== undefined && (
    /\b(?:my|mine|personal|user|preference|習慣|偏好|我)\b/iu.test(probe)
    || (probe.length > 0 && services.store.search(probe, { brainIds: [personalBrainId], status: 'active' }).length > 0)
  );
  const agentType = (input.agentType ?? services.brains.listInstallations().find(({ id }) => id === installationId)?.clientType ?? '').toLocaleLowerCase();
  const primaryOnly = input.subagentId !== undefined
    && (agentType === 'codex' || agentType === 'claude-code')
    && (input.childGoal === undefined || input.childGoal === null || input.childGoal.trim() === '');
  return ReadSetSchema.parse(planReadSet({
    ...(input.workspacePath === undefined ? {} : { workspaceKey: input.workspacePath }),
    task: input.childGoal ?? input.task,
    entities: input.entities,
    brains: catalog,
    primaryProjectId,
    linkedProjectIds: linkedProjectIds.length > 0 ? linkedProjectIds : fallbackLinked,
    ...(personalBrainId === undefined ? {} : { personalBrainId, personalRelevant }),
    ...(input.parentReadSet === undefined ? {} : { parentGrant: input.parentReadSet }),
    ...(primaryOnly ? { primaryOnly: true } : {}),
  }));
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

type CaptureCatalogEntry = {
  readonly brainId: string;
  readonly kind: 'personal' | 'project';
  readonly role: 'personal' | 'primary' | 'linked';
  readonly access: 'read' | 'read_write';
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly keys?: readonly string[];
};

function captureCatalog(services: DaemonServices, installationId: string, workspacePath?: string): readonly CaptureCatalogEntry[] {
  const mounted = services.brains.listMountedBrains(installationId);
  const inspections = new Map((services.projects?.inspect() ?? []).map((inspection) => [inspection.brain.id, inspection]));
  const workspaceBindings = workspacePath === undefined || services.projects === undefined
    ? []
    : services.projects.resolveWorkspace(workspacePath);
  const workspaceByBrain = new Map(workspaceBindings.map((binding) => [binding.brainId, binding]));
  let primaryAssigned = false;
  const catalog: CaptureCatalogEntry[] = [];
  for (const { brain, access } of mounted) {
    if (brain.kind === 'personal') {
      catalog.push({ brainId: brain.id, kind: brain.kind, role: 'personal', access, name: brain.name });
      continue;
    }
    const binding = workspaceByBrain.get(brain.id);
    // A workspace-aware capture must never write a project that is merely
    // mounted for another workspace.  It remains available to explicit
    // context reads through that workspace's ReadSet instead.
    if (workspacePath !== undefined && binding === undefined) continue;
    const role: CaptureCatalogEntry['role'] = binding?.role ?? (primaryAssigned ? 'linked' : 'primary');
    primaryAssigned ||= role === 'primary';
    const effectiveAccess = binding?.access === 'read' || access === 'read' ? 'read' as const : 'read_write' as const;
    const inspection = inspections.get(brain.id);
    catalog.push({
      brainId: brain.id,
      kind: brain.kind,
      role,
      access: effectiveAccess,
      name: brain.name,
      ...(inspection === undefined ? {} : { aliases: inspection.aliases, keys: inspection.keys.map((key) => key.canonicalValue) }),
    });
  }
  return catalog;
}

function currentAdapterVersion(_clientType: string): { readonly protocolVersion: string; readonly adapterVersion: string } {
  return { protocolVersion: '1', adapterVersion: '0.3.0' };
}

function projectNameFromWorkspace(workspacePath: string): string {
  const normalized = workspacePath.replace(/[\\/]+$/u, '');
  const name = normalized.split(/[\\/]/u).filter(Boolean).at(-1);
  return name === undefined || name.trim() === '' ? 'Project' : name;
}

async function persistAutomaticCapture(
  services: DaemonServices,
  semantic: SemanticMemoryService,
  input: z.infer<typeof AutomaticCaptureRequestSchema>,
  sourceReference: string,
  atoms: readonly AtomPlan[],
  installationId: string,
): Promise<CaptureReceipt> {
  const existing = services.database.prepare('SELECT capture_sources.source_reference AS source_reference, capture_sources.content_hash AS content_hash, capture_receipts.receipt_json AS receipt_json FROM capture_sources JOIN capture_receipts USING (capture_id) WHERE capture_sources.capture_id = ?').get(input.captureId) as { source_reference: string; content_hash: string; receipt_json: string } | undefined;
  const contentHash = createHash('sha256').update(input.rawContent).digest('hex');
  if (existing !== undefined) {
    if (existing.source_reference !== sourceReference || existing.content_hash !== contentHash) {
      throw new Error('identity_conflict: capture content differs for the same captureId.');
    }
    return CaptureReceiptSchema.parse(JSON.parse(existing.receipt_json));
  }
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
  const baseReceipt = servicesReceiptForAtoms(atoms, input.captureId, sourceReference);
  const receipt = { ...baseReceipt, atoms: baseReceipt.atoms.map((atom) => {
    const memoryId = atomMemoryIds.get(atom.atomKey);
    return memoryId === undefined ? atom : { ...atom, memoryId };
  }) };
  const parsedReceipt = CaptureReceiptSchema.parse(receipt);
  const now = new Date().toISOString();
  services.database.transaction(() => {
    services.database.prepare(`
      INSERT INTO capture_sources (capture_id, source_reference, actor, event_type, sanitized_content, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.captureId, sourceReference, input.actor ?? 'user', input.eventType, input.rawContent, contentHash, now);
    const insertAtom = services.database.prepare(`
      INSERT INTO capture_atoms (capture_id, atom_key, status, brain_id, memory_id, record_id, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const atom of parsedReceipt.atoms) {
      insertAtom.run(input.captureId, atom.atomKey, atom.status, atom.brainId ?? null, atom.memoryId ?? null, atom.recordId ?? null, atom.reason ?? null, now, now);
    }
    services.database.prepare(`
      INSERT INTO capture_receipts (capture_id, source_reference, status, receipt_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.captureId, sourceReference, parsedReceipt.status, JSON.stringify(parsedReceipt), now, now);
  })();
  return parsedReceipt;
}

function servicesReceiptForAtoms(atoms: readonly AtomPlan[], captureId: string, sourceReference: string): CaptureReceipt {
  const now = new Date().toISOString();
  const receiptAtoms = atoms.map((atom) => ({
    atomKey: atom.atomKey,
    status: atom.status,
    ...(atom.route.status === 'routed' ? { brainId: atom.route.brainId } : {}),
    ...(atom.status === 'routing_required' ? { reason: 'routing_required' } : {}),
  }));
  return CaptureReceiptSchema.parse({
    captureId,
    sourceReference,
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

  if (error instanceof Error && error.message.startsWith('identity_conflict:')) {
    response.status(409).json({ error: 'identity_conflict' });
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
