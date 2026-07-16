import { randomBytes } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_PORT = 3849;
const DEFAULT_START_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_POLL_MS = 25;

export interface DaemonPaths {
  readonly dataRoot: string;
  readonly databasePath: string;
  readonly pidPath: string;
  readonly lockPath: string;
  readonly setupTokenPath: string;
  readonly url: string;
}

export interface DaemonProcessRuntime {
  readonly fetch: typeof fetch;
  readonly spawn: (command: string, args: readonly string[], options: SpawnOptions) => SpawnHandle;
  readonly processAlive: (pid: number) => boolean;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface SpawnOptions {
  readonly detached: boolean;
  readonly windowsHide: boolean;
  readonly stdio: 'ignore';
  readonly env: NodeJS.ProcessEnv;
}

export interface SpawnHandle {
  readonly pid?: number;
  readonly kill?: (signal?: NodeJS.Signals | number) => boolean;
  readonly unref?: () => void;
}

export interface EnsureDaemonOptions {
  readonly dataRoot?: string;
  readonly databasePath?: string;
  readonly daemonUrl?: string;
  readonly port?: number;
  readonly command?: string;
  readonly commandArgs?: readonly string[];
  readonly startTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly lockStaleMs?: number;
  readonly pollMs?: number;
  readonly setupToken?: string;
  readonly runtime?: DaemonProcessRuntime;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface EnsureDaemonResult {
  readonly started: boolean;
  readonly pid?: number;
  readonly paths: DaemonPaths;
  readonly setupToken: string;
}

export function defaultDataRoot(home = homedir()): string {
  return join(home, '.memlume');
}

export function daemonPaths({ dataRoot = defaultDataRoot(), databasePath, daemonUrl, port = DEFAULT_PORT }: Pick<EnsureDaemonOptions, 'dataRoot' | 'databasePath' | 'daemonUrl' | 'port'> = {}): DaemonPaths {
  const root = dataRoot;
  const resolvedPort = Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_PORT;
  const url = daemonUrl ?? `http://127.0.0.1:${resolvedPort}`;
  return {
    dataRoot: root,
    databasePath: databasePath ?? join(root, 'memlume.sqlite'),
    pidPath: join(root, 'daemon.pid'),
    lockPath: join(root, 'daemon.lock'),
    setupTokenPath: join(root, 'setup-token'),
    url,
  };
}

export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<EnsureDaemonResult> {
  const runtime = options.runtime ?? defaultRuntime;
  const paths = daemonPaths(options);
  const startTimeoutMs = positive(options.startTimeoutMs, DEFAULT_START_TIMEOUT_MS);
  const lockTimeoutMs = positive(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  const lockStaleMs = positive(options.lockStaleMs, DEFAULT_LOCK_STALE_MS);
  const pollMs = positive(options.pollMs, DEFAULT_POLL_MS);
  const environment = { ...(options.environment ?? process.env) };
  if (await isMemlumeHealthy(paths.url, runtime.fetch, startTimeoutMs)) {
    const token = await ensureSetupToken(paths.setupTokenPath, options.setupToken, environment);
    return { started: false, paths, setupToken: token };
  }

  const lease = await acquireLock(paths.lockPath, lockTimeoutMs, lockStaleMs, runtime);
  try {
    if (await isMemlumeHealthy(paths.url, runtime.fetch, startTimeoutMs)) {
      const token = await ensureSetupToken(paths.setupTokenPath, options.setupToken, environment);
      return { started: false, paths, setupToken: token };
    }

    const token = await ensureSetupToken(paths.setupTokenPath, options.setupToken, environment);

    const existingPid = await readPid(paths.pidPath);
    if (existingPid !== undefined && runtime.processAlive(existingPid)) {
      throw new Error('A process owns the Memlume daemon PID, but its health endpoint is not Memlume.');
    }
    if (existingPid !== undefined) {
      await removeIfExists(paths.pidPath);
    }

    await mkdir(paths.dataRoot, { recursive: true });
    const command = options.command ?? 'memlume-daemon';
    const args = options.commandArgs ?? ['--database', paths.databasePath, '--port', String(new URL(paths.url).port || DEFAULT_PORT)];
    const child = runtime.spawn(command, args, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...environment,
        MEMLUME_SETUP_TOKEN: token,
      },
    });
    const pid = child.pid;
    if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
      throw new Error('Memlume daemon did not return a valid PID.');
    }
    await writePrivate(paths.pidPath, `${pid}\n`);
    child.unref?.();
    try {
      await waitForHealth(paths.url, startTimeoutMs, pollMs, runtime.fetch, runtime.sleep);
    } catch (error) {
      child.kill?.();
      await removeIfExists(paths.pidPath);
      throw error;
    }
    return { started: true, pid, paths, setupToken: token };
  } finally {
    await lease.release();
  }
}

export async function ensureSetupToken(path: string, requested: string | undefined, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const current = await readText(path);
  if (current !== undefined) {
    return current;
  }
  const token = nonEmpty(requested) ?? nonEmpty(environment.MEMLUME_SETUP_TOKEN) ?? randomBytes(32).toString('base64url');
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(path, 'wx', 0o600);
    await handle.writeFile(`${token}\n`);
    await handle.close();
    return token;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    return (await readText(path)) ?? token;
  }
}

async function isMemlumeHealthy(url: string, fetcher: typeof fetch, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetcher(new URL('/v1/health', url), {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = await response.json() as unknown;
    return isRecord(body) && body.status === 'ok' && body.service === 'memlume';
  } catch {
    return false;
  }
}

async function waitForHealth(url: string, timeoutMs: number, pollMs: number, fetcher: typeof fetch, wait: (milliseconds: number) => Promise<void>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await isMemlumeHealthy(url, fetcher, Math.min(500, Math.max(50, deadline - Date.now())))) return;
    await wait(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error('Timed out waiting for the Memlume daemon health endpoint.');
}

interface LockLease {
  readonly release: () => Promise<void>;
}

async function acquireLock(path: string, timeoutMs: number, staleMs: number, runtime: DaemonProcessRuntime): Promise<LockLease> {
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(path), { recursive: true });
  while (Date.now() <= deadline) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return { release: () => removeIfExists(path) };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      try {
        const age = Date.now() - (await stat(path)).mtimeMs;
        if (age > staleMs) {
          await rm(path, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      await runtime.sleep(Math.min(runtimeSleep(runtime), Math.max(1, deadline - Date.now())));
    }
  }
  throw new Error('Timed out waiting for the Memlume daemon lock.');
}

function runtimeSleep(runtime: DaemonProcessRuntime): number {
  return DEFAULT_POLL_MS;
}

async function readPid(path: string): Promise<number | undefined> {
  const text = await readText(path);
  if (text === undefined || !/^\d+$/u.test(text)) return undefined;
  const pid = Number(text);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    const text = (await readFile(path, 'utf8')).trim();
    return text === '' ? undefined : text;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function writePrivate(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeIfExists(path: string): Promise<void> {
  await rm(path, { force: true });
}

function nonEmpty(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text === '' ? undefined : text;
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && (error.code === 'EEXIST' || error.code === 'EPERM');
}

const defaultRuntime: DaemonProcessRuntime = {
  fetch,
  spawn(command, args, options): SpawnHandle {
    return nodeSpawn(command, args as string[], options) as ChildProcess;
  },
  processAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};
