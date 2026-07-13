import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  AdapterEnvelopeSchema,
  ContextPackSchema,
  MemoryScopeSchema,
  createUuidV7,
  type AdapterEnvelope,
  type ContextPack,
  type JsonValue,
  type MemoryScope,
} from '@memlume/contracts';

const REQUEST_TIMEOUT_MS = 10_000;

export interface AdapterClientOptions {
  readonly daemonUrl: string;
  readonly token?: string;
  readonly outboxPath?: string;
  readonly outboxDirectory?: string;
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
  readonly occurredAt?: string;
  readonly structuredData?: JsonValue;
}

export type WriteResult = { readonly status: 'saved' | 'queued' | 'rejected' };

interface AppendEventRequest {
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

interface PendingEvent {
  readonly messageId: string;
  readonly request: AppendEventRequest;
}

export class AdapterClient {
  private readonly daemonUrl: string;
  private readonly token: string | undefined;
  private readonly fetch: typeof globalThis.fetch;
  private outboxPath: string | undefined;
  private readonly outboxDirectory: string;
  private readonly warn: (message: string) => void;
  private warnedAboutContext = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor({ daemonUrl, token, outboxPath, outboxDirectory = join(homedir(), '.memlume'), fetch = globalThis.fetch, warn = console.warn }: AdapterClientOptions) {
    this.daemonUrl = daemonOrigin(daemonUrl);
    this.token = token ?? process.env.MEMLUME_TOKEN;
    this.fetch = fetch;
    this.outboxPath = outboxPath;
    this.outboxDirectory = outboxDirectory;
    this.warn = warn;
  }

  async beforeTask(input: BeforeTaskInput): Promise<ContextPack> {
    const { envelope, ...requestInput } = input;
    this.bindOutbox(envelope);
    try {
      const response = await this.request('/v1/context/resolve', 'POST', requestInput);
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
    return this.serialize(() => this.write(eventRequest(envelope, message, 'user_message')));
  }

  async afterTask(envelope: AdapterEnvelope, message: AdapterMessage): Promise<WriteResult> {
    this.bindOutbox(envelope);
    return this.serialize(() => this.write(eventRequest(envelope, message, 'task_completed')));
  }

  async onSessionEnd(): Promise<readonly WriteResult[]> {
    return this.serialize(() => this.flush());
  }

  private async flush(): Promise<readonly WriteResult[]> {
    const outboxPath = this.outboxPath;
    if (outboxPath === undefined) {
      return [];
    }
    let pending: PendingEvent[];
    try {
      pending = await readOutbox(outboxPath);
    } catch {
      return [];
    }

    const results: WriteResult[] = [];
    const remaining: PendingEvent[] = [];
    for (const entry of pending) {
      const result = await this.deliver(entry.request);
      results.push(result);
      if (result.status === 'queued') {
        remaining.push(entry);
      }
    }
    try {
      await writeOutbox(outboxPath, remaining);
    } catch {
      this.warn('Memlume outbox update unavailable; queued events will retry later.');
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

  private async write(request: AppendEventRequest | undefined): Promise<WriteResult> {
    if (request === undefined) {
      return { status: 'rejected' };
    }

    const result = await this.deliver(request);
    return result.status === 'queued' ? this.queue(request) : result;
  }

  private async deliver(request: AppendEventRequest): Promise<WriteResult> {
    if (!hasToken(this.token)) {
      return { status: 'rejected' };
    }

    try {
      const response = await this.request('/v1/events', 'POST', request);
      if (response.ok) {
        return { status: 'saved' };
      }
      return response.status >= 400 && response.status < 500 ? { status: 'rejected' } : { status: 'queued' };
    } catch {
      return { status: 'queued' };
    }
  }

  private async queue(request: AppendEventRequest): Promise<WriteResult> {
    const outboxPath = this.outboxPath;
    if (outboxPath === undefined) {
      this.warn('Memlume outbox unavailable; event was not persisted.');
      return { status: 'rejected' };
    }
    try {
      const pending = await readOutbox(outboxPath);
      if (!pending.some((entry) => sameEvent(entry.request, request))) {
        await mkdir(dirname(outboxPath), { recursive: true });
        await appendFile(outboxPath, `${JSON.stringify({ messageId: request.source.messageId, request })}\n`, 'utf8');
      }
      return { status: 'queued' };
    } catch {
      this.warn('Memlume outbox unavailable; event was not persisted.');
      return { status: 'rejected' };
    }
  }

  private request(path: string, method: 'POST', body: unknown): Promise<Response> {
    if (!hasToken(this.token)) {
      throw new Error('Adapter token is unavailable.');
    }
    return this.fetch(new URL(path, this.daemonUrl), {
      method,
      redirect: 'error',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
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
  return {
    rawContent: message.content,
    eventType,
    source: {
      type: value.clientType,
      agent: value.clientType,
      conversationId: value.sessionId,
      messageId: message.messageId,
      reference: JSON.stringify([value.clientType, value.installationId, value.profileId, value.sessionId, message.messageId]),
    },
    ...(message.brainId === undefined ? {} : { brainId: message.brainId }),
    ...(message.occurredAt === undefined ? {} : { occurredAt: message.occurredAt }),
    structuredData: {
      envelope: value,
      ...(message.structuredData === undefined ? {} : { data: message.structuredData }),
    },
  };
}

async function readOutbox(path: string): Promise<PendingEvent[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as PendingEvent);
}

async function writeOutbox(path: string, pending: readonly PendingEvent[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  // ponytail: one AdapterClient serializes one outbox path; add a cross-process lock if multiple processes share one.
  await writeFile(temporaryPath, pending.map((entry) => JSON.stringify(entry)).join('\n') + (pending.length === 0 ? '' : '\n'), 'utf8');
  await rename(temporaryPath, path);
}

function sameEvent(left: AppendEventRequest, right: AppendEventRequest): boolean {
  return left.rawContent === right.rawContent && left.source.reference === right.source.reference;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
