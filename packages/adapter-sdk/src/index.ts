import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  AdapterEnvelopeSchema,
  ContextPackSchema,
  MemoryScopeSchema,
  UuidV7Schema,
  createUuidV7,
  redactSensitiveJson,
  redactSensitiveText,
  type AdapterEnvelope,
  type ContextPack,
  type JsonValue,
  type MemoryScope,
} from '@memlume/contracts';

const REQUEST_TIMEOUT_MS = 10_000;
const CONTEXT_REQUEST_TIMEOUT_MS = 250;
const OUTBOX_FLUSH_GRACE_MS = 50;
const OUTBOX_LOCK_RETRY_MS = 10;
const OUTBOX_LOCK_TIMEOUT_MS = 15_000;
const SECRET_OUTBOX_WARNING = 'Memlume outbox skipped a message containing a secret.';
const explicitMemoryRequestPattern = /^\s*(?:(?:請|請你)\s*)?(?:記住|記下|記錄|remember|memorize|save(?:\s+this)?)\s*[,，:：]?\s*/iu;

export interface LocalAdapterProfile {
  readonly clientType: string;
  readonly installationId: string;
  readonly profileId: string;
  readonly projectId: string;
  readonly brainId: string;
  readonly token: string;
  readonly corePath: string;
  readonly daemonUrl: string;
  readonly workspacePath?: string;
  readonly outboxDirectory?: string;
}

export interface LoadLocalAdapterProfileOptions {
  readonly configPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * 讀取由 Memlume CLI 管理的單一 Agent profile。
 * 明確傳入的 Host 環境變數會覆寫 profile，讓既有部署不必搬遷設定。
 */
export function loadLocalAdapterProfile(clientType: string, { configPath, environment = process.env }: LoadLocalAdapterProfileOptions = {}): LocalAdapterProfile | undefined {
  const expectedClientType = nonEmptyText(clientType);
  if (expectedClientType === undefined) return undefined;
  const configuredPath = nonEmptyText(configPath) ?? nonEmptyText(environment.MEMLUME_CONFIG_PATH) ?? join(homedir(), '.config', 'memlume', 'config.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configuredPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.adapters)) return undefined;
  const requestedInstallation = nonEmptyText(environment.MEMLUME_INSTALLATION_ID);
  const requestedProfile = nonEmptyText(environment.MEMLUME_PROFILE_ID);
  const stored = parsed.adapters.find((profile): profile is LocalAdapterProfile => (
    isLocalAdapterProfile(profile)
    && profile.clientType === expectedClientType
    && (requestedInstallation === undefined || profile.installationId === requestedInstallation)
    && (requestedProfile === undefined || profile.profileId === requestedProfile)
  ));
  if (stored === undefined) return undefined;
  return compactProfile({
    ...stored,
    installationId: nonEmptyText(environment.MEMLUME_INSTALLATION_ID) ?? stored.installationId,
    profileId: nonEmptyText(environment.MEMLUME_PROFILE_ID) ?? stored.profileId,
    projectId: nonEmptyText(environment.MEMLUME_PROJECT_ID) ?? stored.projectId,
    brainId: nonEmptyText(environment.MEMLUME_BRAIN_ID) ?? stored.brainId,
    token: nonEmptyText(environment.MEMLUME_TOKEN) ?? stored.token,
    corePath: nonEmptyText(environment.MEMLUME_HOME) ?? stored.corePath,
    daemonUrl: nonEmptyText(environment.MEMLUME_DAEMON_URL) ?? stored.daemonUrl,
    workspacePath: nonEmptyText(environment.MEMLUME_WORKSPACE_PATH) ?? stored.workspacePath,
    outboxDirectory: nonEmptyText(environment.MEMLUME_OUTBOX_DIRECTORY) ?? stored.outboxDirectory,
  });
}

export interface AdapterClientOptions {
  readonly daemonUrl: string;
  readonly token?: string;
  readonly outboxPath?: string;
  readonly outboxDirectory?: string;
  /** Bounded write deadline for short-lived host hooks. Defaults to the normal daemon deadline. */
  readonly writeTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly warn?: (message: string) => void;
}

export interface BeforeTaskInput {
  readonly envelope?: AdapterEnvelope;
  readonly intent: string;
  readonly scope: MemoryScope;
  readonly task: string | null;
  readonly contextBudget: number;
  readonly entities?: readonly string[];
  readonly availableTools?: readonly string[];
}

export interface AdapterMessage {
  readonly messageId: string;
  readonly content: string;
  readonly brainId?: string;
  readonly scope?: MemoryScope;
  readonly occurredAt?: string;
  readonly structuredData?: JsonValue;
}

export type CapturedMemoryStatus = 'active' | 'candidate' | 'ignore' | 'rejected';
export type WriteResult =
  | { readonly status: 'saved'; readonly memoryStatus?: CapturedMemoryStatus }
  | { readonly status: 'ignored'; readonly memoryStatus: 'ignore' }
  | { readonly status: 'queued' | 'rejected' };

export interface OutboxStatus {
  readonly state: 'unbound' | 'unavailable' | 'empty' | 'pending' | 'discarded';
  readonly pending: number;
  readonly retry: number;
  readonly discarded: number;
}

interface BaseWriteRequest {
  readonly rawContent: string;
  readonly eventType: 'user_message' | 'task_completed';
  readonly source: {
    readonly type: string;
    readonly agent: string;
    readonly conversationId: string;
    readonly messageId: string;
    readonly reference: string;
  };
  readonly brainId?: string;
  readonly occurredAt?: string;
  readonly structuredData: JsonValue;
}

interface AppendEventRequest extends BaseWriteRequest {
  readonly endpoint: '/v1/events';
}

interface CaptureMemoryRequest extends BaseWriteRequest {
  readonly endpoint: '/v1/memories/capture';
  readonly scope: MemoryScope;
}

type WriteRequest = AppendEventRequest | CaptureMemoryRequest;

interface PendingWrite {
  readonly state: 'pending' | 'retry';
  readonly retryCount: number;
  readonly messageId: string;
  readonly request: WriteRequest;
}

interface DiscardedWrite {
  readonly state: 'discarded';
  readonly messageId: string;
  readonly endpoint: WriteRequest['endpoint'];
  readonly discardedAt: string;
}

type OutboxEntry = PendingWrite | DiscardedWrite;

export class AdapterClient {
  private readonly daemonUrl: string;
  private readonly token: string | undefined;
  private readonly fetch: typeof globalThis.fetch;
  private outboxPath: string | undefined;
  private readonly outboxDirectory: string;
  private readonly writeTimeoutMs: number;
  private readonly warn: (message: string) => void;
  private warnedAboutContext = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor({ daemonUrl, token, outboxPath, outboxDirectory = join(homedir(), '.memlume'), writeTimeoutMs = REQUEST_TIMEOUT_MS, fetch = globalThis.fetch, warn = console.warn }: AdapterClientOptions) {
    this.daemonUrl = daemonOrigin(daemonUrl);
    this.token = token ?? process.env.MEMLUME_TOKEN;
    this.fetch = fetch;
    this.outboxPath = outboxPath;
    this.outboxDirectory = outboxDirectory;
    this.writeTimeoutMs = validTimeout(writeTimeoutMs) ? writeTimeoutMs : REQUEST_TIMEOUT_MS;
    this.warn = warn;
  }

  async beforeTask(input: BeforeTaskInput): Promise<ContextPack> {
    if (redactSensitiveJson(input.scope).detected) {
      if (!this.warnedAboutContext) {
        this.warnedAboutContext = true;
        this.warn('Memlume context unavailable; continuing without shared context.');
      }
      return emptyContext(input);
    }
    const { envelope, ...requestInput } = input;
    this.bindOutbox(envelope);
    await withTimeout(this.flush(), OUTBOX_FLUSH_GRACE_MS).catch(() => undefined);
    try {
      const response = await this.request('/v1/context/resolve', 'POST', requestInput, CONTEXT_REQUEST_TIMEOUT_MS);
      if (!response.ok) {
        throw new Error('Context request failed.');
      }
      const result = await response.json();
      return ContextPackSchema.parse(isRecord(result) ? result.context : undefined);
    } catch {
      if (!this.warnedAboutContext) {
        this.warnedAboutContext = true;
        this.warn('Memlume context unavailable; continuing without shared context.');
      }
      return emptyContext(input);
    }
  }

  async onUserMessage(envelope: AdapterEnvelope, message: AdapterMessage): Promise<WriteResult> {
    this.bindOutbox(envelope);
    return this.serialize(async () => {
      await this.flush();
      return this.write(captureRequest(envelope, message));
    });
  }

  async afterTask(envelope: AdapterEnvelope, message: AdapterMessage): Promise<WriteResult> {
    this.bindOutbox(envelope);
    return this.serialize(async () => {
      await this.flush();
      return this.write(eventRequest(envelope, message, 'task_completed'));
    });
  }

  async onSessionEnd(envelope?: AdapterEnvelope): Promise<readonly WriteResult[]> {
    this.bindOutbox(envelope);
    return this.serialize(() => this.flush());
  }

  outboxStatus(): Promise<OutboxStatus> {
    return this.serialize(() => this.readOutboxStatus());
  }

  private async readOutboxStatus(): Promise<OutboxStatus> {
    const outboxPath = this.outboxPath;
    if (outboxPath === undefined) {
      return { state: 'unbound', pending: 0, retry: 0, discarded: 0 };
    }
    try {
      const entries = await readOutbox(outboxPath);
      const pending = entries.filter(isPendingWrite);
      const discarded = entries.filter(isDiscardedWrite).length;
      return {
        state: pending.length > 0 ? 'pending' : discarded > 0 ? 'discarded' : 'empty',
        pending: pending.length,
        retry: pending.filter(({ state }) => state === 'retry').length,
        discarded,
      };
    } catch {
      return { state: 'unavailable', pending: 0, retry: 0, discarded: 0 };
    }
  }

  private async flush(): Promise<readonly WriteResult[]> {
    const outboxPath = this.outboxPath;
    if (outboxPath === undefined) {
      return [];
    }
    try {
      return await withOutboxLock(outboxPath, () => this.flushLocked(outboxPath));
    } catch {
      return [];
    }
  }

  private async flushLocked(outboxPath: string): Promise<readonly WriteResult[]> {
    let entries: OutboxEntry[];
    try {
      entries = await readOutbox(outboxPath);
    } catch {
      return [];
    }

    const results: WriteResult[] = [];
    const remaining: OutboxEntry[] = entries.filter(isDiscardedWrite);
    for (const entry of entries.filter(isPendingWrite)) {
      if (containsSecret(entry.request)) {
        this.warn(SECRET_OUTBOX_WARNING);
        results.push({ status: 'rejected' });
        continue;
      }
      const result = await this.deliver(entry.request);
      results.push(result);
      if (result.status === 'queued') {
        remaining.push({ ...entry, state: 'retry', retryCount: entry.retryCount + 1 });
      } else if (result.status === 'rejected') {
        remaining.push({
          state: 'discarded',
          messageId: entry.messageId,
          endpoint: entry.request.endpoint,
          discardedAt: new Date().toISOString(),
        });
      }
    }
    if (entries.length > 0) {
      try {
        await writeOutbox(outboxPath, remaining);
      } catch {
        this.warn('Memlume outbox update unavailable; queued events will retry later.');
      }
    }
    return results;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(operation, operation);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async write(request: WriteRequest | undefined): Promise<WriteResult> {
    if (request === undefined) {
      return { status: 'rejected' };
    }

    const result = await this.deliver(request);
    return result.status === 'queued' ? this.queue(request) : result;
  }

  private async deliver(request: WriteRequest): Promise<WriteResult> {
    if (!hasToken(this.token)) {
      return { status: 'rejected' };
    }

    try {
      const { endpoint, ...body } = request;
      const response = await this.request(endpoint, 'POST', body, this.writeTimeoutMs);
      if (response.ok) {
        const result = await response.json();
        if (request.endpoint === '/v1/events') {
          return confirmedEvent(result) ? { status: 'saved' } : { status: 'queued' };
        }
        const memoryStatus = confirmedCapture(result);
        if (memoryStatus === undefined) {
          return { status: 'queued' };
        }
        if (memoryStatus === 'rejected') {
          return { status: 'rejected' };
        }
        if (memoryStatus === 'ignore') {
          return { status: 'ignored', memoryStatus };
        }
        return { status: 'saved', memoryStatus };
      }
      return response.status >= 400 && response.status < 500 && response.status !== 429 ? { status: 'rejected' } : { status: 'queued' };
    } catch {
      return { status: 'queued' };
    }
  }

  private async queue(request: WriteRequest): Promise<WriteResult> {
    if (containsSecret(request)) {
      this.warn(SECRET_OUTBOX_WARNING);
      return { status: 'rejected' };
    }
    if (!canQueueOffline(request)) {
      return { status: 'rejected' };
    }
    const outboxPath = this.outboxPath;
    if (outboxPath === undefined) {
      this.warn('Memlume outbox unavailable; event was not persisted.');
      return { status: 'rejected' };
    }
    try {
      return await withOutboxLock(outboxPath, async () => {
        const pending = await readOutbox(outboxPath);
        if (!pending.filter(isPendingWrite).some((entry) => sameRequest(entry.request, request))) {
          pending.push({ state: 'pending', retryCount: 0, messageId: request.source.messageId, request });
        }
        await writeOutbox(outboxPath, pending);
        return { status: 'queued' };
      });
    } catch {
      this.warn('Memlume outbox unavailable; event was not persisted.');
      return { status: 'rejected' };
    }
  }

  private request(path: string, method: 'POST', body: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    if (!hasToken(this.token)) {
      throw new Error('Adapter token is unavailable.');
    }
    return withTimeout(this.fetch(new URL(path, this.daemonUrl), {
      method,
      redirect: 'error',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }), timeoutMs);
  }

  private bindOutbox(envelope: AdapterEnvelope | undefined): void {
    if (this.outboxPath !== undefined || envelope === undefined) {
      return;
    }
    const parsed = AdapterEnvelopeSchema.safeParse(envelope);
    if (parsed.success) {
      this.outboxPath = defaultOutboxPath(parsed.data, this.outboxDirectory);
    }
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Memlume request timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function eventRequest(
  envelope: AdapterEnvelope,
  message: AdapterMessage,
  eventType: AppendEventRequest['eventType'],
): AppendEventRequest | undefined {
  const parsedEnvelope = AdapterEnvelopeSchema.safeParse(envelope);
  if (!parsedEnvelope.success || message.messageId.trim() === '' || message.content.trim() === '') {
    return undefined;
  }
  const value = parsedEnvelope.data;
  const structuredData: JsonValue = {
    envelope: value,
    ...(message.structuredData === undefined ? {} : { data: message.structuredData }),
  };
  const source = {
    type: value.clientType,
    agent: value.clientType,
    conversationId: value.sessionId,
    messageId: message.messageId,
    reference: JSON.stringify([value.clientType, value.installationId, value.profileId, value.sessionId, message.messageId]),
  };
  if (redactSensitiveText(message.content).detected || redactSensitiveJson(structuredData).detected || redactSensitiveJson(source).detected) {
    return undefined;
  }
  return {
    endpoint: '/v1/events',
    rawContent: message.content,
    eventType,
    source,
    ...(message.brainId === undefined ? {} : { brainId: message.brainId }),
    ...(message.occurredAt === undefined ? {} : { occurredAt: message.occurredAt }),
    structuredData,
  };
}

function captureRequest(envelope: AdapterEnvelope, message: AdapterMessage): CaptureMemoryRequest | undefined {
  const request = eventRequest(envelope, message, 'user_message');
  const parsedEnvelope = AdapterEnvelopeSchema.safeParse(envelope);
  if (request === undefined || !parsedEnvelope.success) {
    return undefined;
  }
  const scope = MemoryScopeSchema.safeParse(message.scope ?? { level: 'project', projectId: parsedEnvelope.data.projectId });
  if (!scope.success) {
    return undefined;
  }
  if (redactSensitiveJson(scope.data).detected) {
    return undefined;
  }
  return { ...request, endpoint: '/v1/memories/capture', scope: scope.data };
}

async function readOutbox(path: string): Promise<OutboxEntry[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
  const lines = text.split('\n');
  const entries: OutboxEntry[] = [];
  for (const [index, line] of lines.entries()) {
    if (line === '') {
      continue;
    }
    try {
      entries.push(parseOutboxEntry(JSON.parse(line)));
    } catch (error) {
      if (index === lines.length - 1 && !text.endsWith('\n')) {
        continue;
      }
      throw error;
    }
  }
  return entries;
}

async function writeOutbox(path: string, pending: readonly OutboxEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, pending.map((entry) => JSON.stringify(entry)).join('\n') + (pending.length === 0 ? '' : '\n'), 'utf8');
  await rename(temporaryPath, path);
}

async function withOutboxLock<T>(outboxPath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${outboxPath}.lock`;
  await mkdir(dirname(outboxPath), { recursive: true });
  const deadline = Date.now() + OUTBOX_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!isExistingPath(error) || Date.now() >= deadline) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, OUTBOX_LOCK_RETRY_MS));
    }
  }
  try {
    return await operation();
  } finally {
    // ponytail: directory lock serializes local processes; replace with SQLite only if outbox volume needs cross-host coordination.
    await rm(lockPath, { force: true, recursive: true });
  }
}

function sameRequest(left: WriteRequest, right: WriteRequest): boolean {
  return left.endpoint === right.endpoint && left.rawContent === right.rawContent && left.source.reference === right.source.reference;
}

function containsSecret(request: WriteRequest): boolean {
  return redactSensitiveText(request.rawContent).detected ||
    redactSensitiveJson(request.structuredData).detected ||
    redactSensitiveJson(request.source).detected ||
    (request.endpoint === '/v1/memories/capture' && redactSensitiveJson(request.scope).detected);
}

function canQueueOffline(request: WriteRequest): request is CaptureMemoryRequest {
  return request.endpoint === '/v1/memories/capture' && explicitMemoryRequestPattern.test(request.rawContent);
}

function parseOutboxEntry(value: unknown): OutboxEntry {
  if (!isRecord(value) || typeof value.messageId !== 'string') {
    throw new Error('Outbox entry is invalid.');
  }
  if (value.state === 'discarded') {
    if (!isWriteEndpoint(value.endpoint) || typeof value.discardedAt !== 'string') {
      throw new Error('Discarded outbox entry is invalid.');
    }
    return { state: 'discarded', messageId: value.messageId, endpoint: value.endpoint, discardedAt: value.discardedAt };
  }
  if (value.state !== undefined && value.state !== 'pending' && value.state !== 'retry') {
    throw new Error('Outbox entry state is invalid.');
  }
  const retryCount = value.retryCount === undefined ? 0 : value.retryCount;
  if (typeof retryCount !== 'number' || !Number.isSafeInteger(retryCount) || retryCount < 0) {
    throw new Error('Outbox retry count is invalid.');
  }
  return {
    state: value.state === 'retry' ? 'retry' : 'pending',
    retryCount,
    messageId: value.messageId,
    request: parseWriteRequest(value.request),
  };
}

function parseWriteRequest(value: unknown): WriteRequest {
  if (!isRecord(value) || typeof value.rawContent !== 'string' || (value.eventType !== 'user_message' && value.eventType !== 'task_completed') || !isRecord(value.source)) {
    throw new Error('Outbox request is invalid.');
  }
  const source = value.source;
  if (
    typeof source.type !== 'string' ||
    typeof source.agent !== 'string' ||
    typeof source.conversationId !== 'string' ||
    typeof source.messageId !== 'string' ||
    typeof source.reference !== 'string'
  ) {
    throw new Error('Outbox event source is invalid.');
  }
  const request: BaseWriteRequest = {
    rawContent: value.rawContent,
    eventType: value.eventType,
    source: {
      type: source.type,
      agent: source.agent,
      conversationId: source.conversationId,
      messageId: source.messageId,
      reference: source.reference,
    },
    ...(typeof value.brainId === 'string' ? { brainId: value.brainId } : {}),
    ...(typeof value.occurredAt === 'string' ? { occurredAt: value.occurredAt } : {}),
    structuredData: value.structuredData as JsonValue,
  };
  if (value.endpoint === undefined || value.endpoint === '/v1/events') {
    return { ...request, endpoint: '/v1/events' };
  }
  const scope = MemoryScopeSchema.safeParse(value.scope);
  if (value.endpoint !== '/v1/memories/capture' || !scope.success) {
    throw new Error('Outbox endpoint is invalid.');
  }
  return { ...request, endpoint: '/v1/memories/capture', scope: scope.data };
}

function isPendingWrite(entry: OutboxEntry): entry is PendingWrite {
  return entry.state === 'pending' || entry.state === 'retry';
}

function isDiscardedWrite(entry: OutboxEntry): entry is DiscardedWrite {
  return entry.state === 'discarded';
}

function isWriteEndpoint(value: unknown): value is WriteRequest['endpoint'] {
  return value === '/v1/events' || value === '/v1/memories/capture';
}

function defaultOutboxPath(envelope: AdapterEnvelope, outboxDirectory: string): string {
  const identity = JSON.stringify([envelope.clientType, envelope.installationId, envelope.profileId]);
  const name = createHash('sha256').update(identity).digest('hex');
  return join(outboxDirectory, 'outbox', `${name}.jsonl`);
}

function emptyContext(input: BeforeTaskInput): ContextPack {
  const scope = MemoryScopeSchema.safeParse(input.scope).data ?? { level: 'global' };
  const intent = typeof input.intent === 'string' && input.intent.trim() !== '' ? input.intent : 'shared_memory';
  const contextBudget = Number.isSafeInteger(input.contextBudget) && input.contextBudget >= 0 ? input.contextBudget : 0;
  return ContextPackSchema.parse({
    traceId: createUuidV7(),
    intent,
    scope,
    directives: [],
    procedures: [],
    preferences: [],
    knowledge: [],
    decisions: [],
    explanation: {
      sourceMemoryIds: [],
      exclusions: [],
      budget: { limitUnits: contextBudget, usedUnits: 0, included: [], omitted: [], truncated: false },
    },
  });
}

function daemonOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Daemon URL must be a loopback HTTP origin.');
  }
  return url.toString();
}

function hasToken(token: string | undefined): token is string {
  return token !== undefined && token.trim() !== '';
}

function validTimeout(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function compactProfile(profile: LocalAdapterProfile): LocalAdapterProfile {
  return {
    clientType: profile.clientType,
    installationId: profile.installationId,
    profileId: profile.profileId,
    projectId: profile.projectId,
    brainId: profile.brainId,
    token: profile.token,
    corePath: profile.corePath,
    daemonUrl: profile.daemonUrl,
    ...(profile.workspacePath === undefined ? {} : { workspacePath: profile.workspacePath }),
    ...(profile.outboxDirectory === undefined ? {} : { outboxDirectory: profile.outboxDirectory }),
  };
}

function isLocalAdapterProfile(value: unknown): value is LocalAdapterProfile {
  if (!isRecord(value)) return false;
  return nonEmptyText(value.clientType) !== undefined
    && nonEmptyText(value.installationId) !== undefined
    && nonEmptyText(value.profileId) !== undefined
    && nonEmptyText(value.projectId) !== undefined
    && nonEmptyText(value.brainId) !== undefined
    && nonEmptyText(value.token) !== undefined
    && nonEmptyText(value.corePath) !== undefined
    && nonEmptyText(value.daemonUrl) !== undefined
    && (value.workspacePath === undefined || nonEmptyText(value.workspacePath) !== undefined)
    && (value.outboxDirectory === undefined || nonEmptyText(value.outboxDirectory) !== undefined);
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function confirmedEvent(value: unknown): boolean {
  return isRecord(value) && isRecord(value.event) && UuidV7Schema.safeParse(value.event.brainId).success;
}

function confirmedCapture(value: unknown): CapturedMemoryStatus | undefined {
  if (!isRecord(value) || !isRecord(value.capture) || !UuidV7Schema.safeParse(value.capture.brain).success || !MemoryScopeSchema.safeParse(value.capture.scope).success) {
    return undefined;
  }
  const status = value.capture.status;
  if (status !== 'active' && status !== 'candidate' && status !== 'ignore' && status !== 'rejected') {
    return undefined;
  }
  if ((status === 'active' || status === 'candidate') && !UuidV7Schema.safeParse(value.capture.memoryId).success) {
    return undefined;
  }
  if ((status === 'ignore' || status === 'rejected') && value.capture.memoryId !== null) {
    return undefined;
  }
  return status;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isExistingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}
