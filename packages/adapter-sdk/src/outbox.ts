import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { redactSensitiveJson, type JsonValue } from '@memlume/contracts';

export type CaptureOutboxState = 'pending' | 'retry' | 'discarded';

export interface CaptureOutboxEntry<T = unknown> {
  readonly identity: string;
  readonly payload: T;
  readonly state?: Exclude<CaptureOutboxState, 'discarded'>;
  readonly retryCount?: number;
  readonly queuedAt?: string;
  readonly reason?: string;
}

export interface StoredCaptureOutboxEntry<T = unknown> {
  readonly identity: string;
  readonly payload: T;
  readonly state: CaptureOutboxState;
  readonly retryCount: number;
  readonly queuedAt: string;
  readonly reason?: string;
}

export interface CaptureOutboxOptions {
  readonly path: string;
  readonly maxEntries?: number;
  readonly lockTimeoutMs?: number;
  readonly now?: () => string;
}

/** Durable, secret-safe JSONL queue shared by short-lived host adapters. */
export class CaptureOutbox<T = unknown> {
  private readonly maxEntries: number;
  private readonly now: () => string;
  private readonly lockTimeoutMs: number;

  constructor(private readonly options: CaptureOutboxOptions) {
    if (options.path.trim() === '') throw new Error('Outbox path is required.');
    this.maxEntries = Number.isInteger(options.maxEntries) && (options.maxEntries ?? 0) > 0 ? options.maxEntries! : 256;
    this.lockTimeoutMs = Number.isInteger(options.lockTimeoutMs) && (options.lockTimeoutMs ?? 0) > 0 ? options.lockTimeoutMs! : 15_000;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async list(): Promise<readonly StoredCaptureOutboxEntry<T>[]> {
    return withLock(this.options.path, this.lockTimeoutMs, () => this.read());
  }

  async enqueue(input: CaptureOutboxEntry<T>): Promise<'queued' | 'deduplicated' | 'rejected' | 'failed'> {
    if (input.identity.trim() === '' || redactSensitiveJson(input.payload as JsonValue).detected) return 'rejected';
    try {
      return await withLock(this.options.path, this.lockTimeoutMs, async () => {
        const entries = [...await this.read()];
        const existing = entries.find((entry) => entry.state !== 'discarded' && entry.identity === input.identity);
        if (existing !== undefined) {
          if (stableHash(existing.payload) !== stableHash(input.payload)) return 'failed';
          return 'deduplicated';
        }
        const active = entries.filter((entry) => entry.state !== 'discarded');
        if (active.length >= this.maxEntries) return 'failed';
        entries.push({
          identity: input.identity,
          payload: input.payload,
          state: input.state ?? 'pending',
          retryCount: input.retryCount ?? 0,
          queuedAt: input.queuedAt ?? this.now(),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        });
        await this.write(entries);
        return 'queued';
      });
    } catch {
      return 'failed';
    }
  }

  async remove(identity: string): Promise<boolean> {
    return withLock(this.options.path, this.lockTimeoutMs, async () => {
      const entries = [...await this.read()];
      const next = entries.filter((entry) => entry.identity !== identity);
      if (next.length === entries.length) return false;
      await this.write(next);
      return true;
    });
  }

  async discard(identity: string, reason: string): Promise<boolean> {
    return withLock(this.options.path, this.lockTimeoutMs, async () => {
      const entries = [...await this.read()];
      const index = entries.findIndex((entry) => entry.identity === identity && entry.state !== 'discarded');
      if (index < 0) return false;
      entries[index] = { ...entries[index], state: 'discarded', reason: reason.trim() || 'discarded' };
      await this.write(entries);
      return true;
    });
  }

  private async read(): Promise<StoredCaptureOutboxEntry<T>[]> {
    let text: string;
    try { text = await readFile(this.options.path, 'utf8'); } catch { return []; }
    const entries: StoredCaptureOutboxEntry<T>[] = [];
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed.identity !== 'string' || typeof parsed.payload === 'undefined') continue;
        const state = parsed.state === 'retry' || parsed.state === 'discarded' ? parsed.state : 'pending';
        entries.push({
          identity: parsed.identity,
          payload: parsed.payload as T,
          state,
          retryCount: typeof parsed.retryCount === 'number' && parsed.retryCount >= 0 ? parsed.retryCount : 0,
          queuedAt: typeof parsed.queuedAt === 'string' ? parsed.queuedAt : this.now(),
          ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
        });
      } catch {
        // A partial last line is expected after a host process crash.
      }
    }
    return entries;
  }

  private async write(entries: readonly StoredCaptureOutboxEntry<T>[]): Promise<void> {
    const directory = dirname(this.options.path);
    await mkdir(directory, { recursive: true });
    const tempPath = `${this.options.path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const text = entries.length === 0 ? '' : `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    try { await writeFile(tempPath, text, { encoding: 'utf8', mode: 0o600 }); await rename(tempPath, this.options.path); } finally { await rm(tempPath, { force: true }); }
  }
}

async function withLock<T>(path: string, timeoutMs: number, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(path), { recursive: true });
  while (true) {
    try {
      await mkdir(lockPath);
      try { return await operation(); } finally { await rm(lockPath, { recursive: true, force: true }); }
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
