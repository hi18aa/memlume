import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { redactSensitiveText } from '@memlume/contracts';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 64 * 1024;

export interface TurnRuntimeEntry {
  readonly installationId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly traceId?: string;
  readonly finalAnswer: string;
  readonly savedAt: string;
  readonly expiresAt: string;
}

export interface SaveTurnRuntimeInput {
  readonly installationId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly traceId?: string;
  readonly finalAnswer: string;
  readonly savedAt?: string;
}

export interface TurnRuntimeKey {
  readonly installationId: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface TurnRuntimeStoreOptions {
  /** A daemon-local directory. It must not be the Brain or Inbox root. */
  readonly rootDir: string;
  readonly now?: () => Date;
  readonly ttlMs?: number;
  readonly maxBytes?: number;
}

/**
 * Bounded, short-lived storage for an assistant final turn.
 *
 * Runtime entries are deliberately not semantic records: callers must copy
 * only an approved atom into the normal capture pipeline. The store never
 * exposes a listing API, so runtime text cannot accidentally enter search or
 * backup projections.
 */
export class TurnRuntimeStore {
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly maxBytes: number;

  constructor(private readonly options: TurnRuntimeStoreOptions) {
    if (options.rootDir.trim() === '') throw new Error('Runtime root directory is required.');
    this.now = options.now ?? (() => new Date());
    this.ttlMs = positiveInteger(options.ttlMs, DEFAULT_TTL_MS);
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
  }

  async save(input: SaveTurnRuntimeInput): Promise<'saved' | 'rejected'> {
    const key = parseKey(input);
    if (redactSensitiveText(input.finalAnswer).detected) return 'rejected';
    if (Buffer.byteLength(input.finalAnswer, 'utf8') > this.maxBytes) return 'rejected';
    const savedAt = input.savedAt ?? this.now().toISOString();
    const savedAtMs = Date.parse(savedAt);
    if (!Number.isFinite(savedAtMs)) return 'rejected';
    const entry: TurnRuntimeEntry = {
      ...key,
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      finalAnswer: input.finalAnswer,
      savedAt: new Date(savedAtMs).toISOString(),
      expiresAt: new Date(savedAtMs + this.ttlMs).toISOString(),
    };
    await this.withLock(async () => {
      const path = this.pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeAtomic(path, JSON.stringify(entry));
    });
    return 'saved';
  }

  async read(keyInput: TurnRuntimeKey): Promise<TurnRuntimeEntry | undefined> {
    const key = parseKey(keyInput);
    return this.withLock(async () => {
      const path = this.pathFor(key);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return undefined;
      }
      const entry = parseEntry(parsed);
      if (entry === undefined) {
        await rm(path, { force: true });
        return undefined;
      }
      if (Date.parse(entry.expiresAt) <= this.now().getTime()) {
        await rm(path, { force: true });
        return undefined;
      }
      return entry;
    });
  }

  /** Clear a turn only after the associated capture was durably saved/queued. */
  async clearAfterCapture(keyInput: TurnRuntimeKey, result: 'saved' | 'queued' | 'rejected' | 'failed'): Promise<boolean> {
    if (result !== 'saved' && result !== 'queued') return false;
    const key = parseKey(keyInput);
    return this.withLock(async () => {
      const path = this.pathFor(key);
      try {
        await rm(path, { force: false });
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    });
  }

  async clear(keyInput: TurnRuntimeKey): Promise<boolean> {
    const key = parseKey(keyInput);
    return this.withLock(async () => {
      const path = this.pathFor(key);
      try {
        await rm(path, { force: false });
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    });
  }

  async cleanup(): Promise<number> {
    return this.withLock(async () => {
      let removed = 0;
      let entries: string[];
      try {
        entries = await import('node:fs/promises').then(({ readdir }) => readdir(this.options.rootDir, { encoding: 'utf8' }));
      } catch {
        return 0;
      }
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const path = join(this.options.rootDir, name);
        try {
          const parsed = parseEntry(JSON.parse(await readFile(path, 'utf8')));
          if (parsed === undefined || Date.parse(parsed.expiresAt) <= this.now().getTime()) {
            await rm(path, { force: true });
            removed += 1;
          }
        } catch {
          await rm(path, { force: true });
          removed += 1;
        }
      }
      return removed;
    });
  }

  private pathFor(key: TurnRuntimeKey): string {
    const digest = createHash('sha256').update(JSON.stringify([key.installationId, key.sessionId, key.turnId])).digest('hex');
    return join(this.options.rootDir, `${digest}.json`);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.options.rootDir}.lock`;
    await mkdir(dirname(this.options.rootDir), { recursive: true });
    for (;;) {
      try {
        await mkdir(lockPath);
        break;
      } catch (error) {
        if (!isExisting(error)) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}

function parseKey(value: TurnRuntimeKey | SaveTurnRuntimeInput): TurnRuntimeKey {
  const fields = [value.installationId, value.sessionId, value.turnId];
  if (fields.some((field) => typeof field !== 'string' || field.trim() === '' || field.length > 256 || field.includes('/') || field.includes('\\'))) {
    throw new Error('Runtime turn identity is invalid.');
  }
  return { installationId: value.installationId.trim(), sessionId: value.sessionId.trim(), turnId: value.turnId.trim() };
}

function parseEntry(value: unknown): TurnRuntimeEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.installationId !== 'string' || typeof candidate.sessionId !== 'string' || typeof candidate.turnId !== 'string' || typeof candidate.finalAnswer !== 'string' || typeof candidate.savedAt !== 'string' || typeof candidate.expiresAt !== 'string') return undefined;
  if (candidate.traceId !== undefined && typeof candidate.traceId !== 'string') return undefined;
  try {
    const key = parseKey(candidate as unknown as TurnRuntimeKey);
    if (!Number.isFinite(Date.parse(candidate.savedAt)) || !Number.isFinite(Date.parse(candidate.expiresAt))) return undefined;
    return {
      ...key,
      ...(candidate.traceId === undefined ? {} : { traceId: candidate.traceId }),
      finalAnswer: candidate.finalAnswer,
      savedAt: new Date(Date.parse(candidate.savedAt)).toISOString(),
      expiresAt: new Date(Date.parse(candidate.expiresAt)).toISOString(),
    };
  } catch {
    return undefined;
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, 'w', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isExisting(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}
