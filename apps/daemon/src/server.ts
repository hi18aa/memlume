import { createBackup, importBrain, restoreBackup, RestoreRecoveryError } from '@memlume/backup';
import { openDatabase, type SqliteDatabase } from '@memlume/database/internal';
import { ContextResolver } from '@memlume/context-resolver';
import { EventJournal } from '@memlume/event-journal';
import { MemoryStore, OutcomeStore } from '@memlume/retrieval';
import { BrainStore, RoutingInboxStore } from '@memlume/shared-brains';
import express, { type Express } from 'express';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerRoutes, type BackupLifecycle } from './routes.js';
import { SemanticMemoryService } from './semantic-memory-service.js';

export interface DaemonOptions {
  readonly databasePath: string;
  readonly setupToken?: string;
  readonly consolePath?: string;
}

export interface Daemon {
  readonly app: Express;
  close(): void;
}

export interface StartDaemonOptions extends DaemonOptions {
  readonly port?: number;
}

export interface RunningDaemon extends Daemon {
  readonly server: Server;
  readonly address: AddressInfo;
  stop(): Promise<void>;
}

export function createDaemon({ databasePath, setupToken, consolePath = defaultConsolePath() }: DaemonOptions): Daemon {
  let runtime: DaemonRuntime | undefined;
  let activeRouter: Express;
  let restoring = false;
  let closed = false;
  let activeRequests = 0;
  const drainWaiters: Array<() => void> = [];
  const app = express();
  app.disable('x-powered-by');
  app.use('/console', express.static(consolePath));
  app.get('/console/{*path}', (_request, response, next) => {
    response.sendFile('index.html', { root: consolePath }, (error) => {
      if (error !== undefined) {
        next(error);
      }
    });
  });

  const backup: BackupLifecycle = {
    async create({ brainId, password }) {
      const current = requireRuntime(runtime);
      const directory = mkdtempSync(join(tmpdir(), 'memlume-daemon-backup-'));
      const outputPath = join(directory, 'backup.memlume');
      try {
        await createBackup({
          database: current.database,
          outputPath,
          ...(brainId === undefined ? {} : { brainId }),
          ...(password === undefined ? {} : { password }),
        });
        return readFileSync(outputPath);
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
    async import({ bundle, password, name }) {
      const current = requireRuntime(runtime);
      const directory = mkdtempSync(join(tmpdir(), 'memlume-daemon-import-'));
      const backupPath = join(directory, 'import.memlume');
      try {
        writeFileSync(backupPath, bundle, { mode: 0o600 });
        return await importBrain({ backupPath, database: current.database, ...(password === undefined ? {} : { password }), ...(name === undefined ? {} : { name }) });
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
    beginRestore() {
      if (restoring || closed) {
        return false;
      }
      restoring = true;
      return true;
    },
    cancelRestore() {
      if (runtime !== undefined && !closed) {
        restoring = false;
      }
    },
    async restore({ bundle, password }) {
      if (!restoring || closed) {
        throw new Error('Daemon restore is unavailable.');
      }
      const directory = mkdtempSync(join(tmpdir(), 'memlume-daemon-restore-'));
      const backupPath = join(directory, 'restore.memlume');
      let paused = false;
      let recoveryFailed = false;
      try {
        writeFileSync(backupPath, bundle, { mode: 0o600 });
        try {
          await restoreBackup({
            backupPath,
            databasePath,
            ...(password === undefined ? {} : { password }),
            pauseWrites: async () => {
              await waitForExistingRequests();
              const current = requireRuntime(runtime);
              paused = true;
              current.database.close();
              runtime = undefined;
              return () => {
                if (closed) {
                  return;
                }
                const reopened = openRuntime();
                runtime = reopened;
                activeRouter = reopened.router;
              };
            },
          });
        } catch (error) {
          recoveryFailed = error instanceof RestoreRecoveryError;
          throw error;
        }
      } finally {
        rmSync(directory, { force: true, recursive: true });
        if (paused && runtime === undefined && !closed && !recoveryFailed) {
          const reopened = openRuntime();
          runtime = reopened;
          activeRouter = reopened.router;
        }
        restoring = recoveryFailed || runtime === undefined && !closed;
      }
    },
    diagnostics() {
      const current = requireRuntime(runtime);
      const integrity = current.database.pragma('integrity_check', { simple: true }) === 'ok' ? 'ok' : 'failed';
      const migrations = current.database.prepare('SELECT id FROM schema_migrations ORDER BY id').pluck().all() as string[];
      const mounts = current.database
        .prepare('SELECT brain_id AS brainId, agent_installation_id AS agentInstallationId, access FROM brain_mounts ORDER BY brain_id, agent_installation_id')
        .all();
      return {
        health: 'ok' as const,
        schema: { migrations },
        integrity,
        brains: current.brains.listBrains(),
        mounts,
      };
    },
  };

  try {
    const opened = openRuntime();
    runtime = opened;
    activeRouter = opened.router;

    app.use((request, response, next) => {
      if (restoring) {
        response.status(503).json({ error: 'restore_in_progress' });
        return;
      }
      activeRequests += 1;
      let released = false;
      const release = () => {
        if (released) {
          return;
        }
        released = true;
        activeRequests -= 1;
        if (activeRequests <= 1) {
          drainWaiters.splice(0).forEach((resolve) => resolve());
        }
      };
      response.once('finish', release);
      response.once('close', release);
      next();
    });
    app.use((request, response, next) => activeRouter(request, response, next));

    return {
      app,
      close() {
        if (!closed) {
          closed = true;
          runtime?.database.close();
          runtime = undefined;
        }
      },
    };
  } catch (error) {
    runtime?.database.close();
    throw error;
  }

  function openRuntime(): DaemonRuntime {
    const database = openDatabase(databasePath);
    try {
      const journal = new EventJournal(database);
      const store = new MemoryStore(database, { markdownRoot: resolve(dirname(databasePath)) });
      const outcomes = new OutcomeStore(database);
      const resolver = new ContextResolver(store, outcomes);
      const brains = new BrainStore(database);
      const semantic = new SemanticMemoryService({ journal, store });
      const routingInbox = new RoutingInboxStore({ rootDir: resolve(dirname(databasePath)) });
      const router = express();
      router.disable('x-powered-by');
      router.use(express.json({ limit: '1mb' }));
      registerRoutes(router, { database, journal, store, resolver, outcomes, brains, semantic, routingInbox, setupToken, backup });
      return { database, brains, router };
    } catch (error) {
      database.close();
      throw error;
    }
  }

  function waitForExistingRequests(): Promise<void> {
    if (activeRequests <= 1) {
      return Promise.resolve();
    }
    return new Promise((resolve) => drainWaiters.push(resolve));
  }
}

interface DaemonRuntime {
  readonly database: SqliteDatabase;
  readonly brains: BrainStore;
  readonly router: Express;
}

function requireRuntime(runtime: DaemonRuntime | undefined): DaemonRuntime {
  if (runtime === undefined) {
    throw new Error('Daemon database is unavailable.');
  }
  return runtime;
}

export async function startDaemon({ databasePath, port = 0, setupToken, consolePath }: StartDaemonOptions): Promise<RunningDaemon> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Port must be an integer from 0 to 65535.');
  }

  const daemon = createDaemon({ databasePath, setupToken, ...(consolePath === undefined ? {} : { consolePath }) });
  try {
    const server = await listen(daemon.app, port);
    const address = server.address();
    if (address === null || typeof address === 'string') {
      await closeServer(server);
      throw new Error('Daemon did not bind to a TCP address.');
    }

    let stopping: Promise<void> | undefined;
    return {
      ...daemon,
      server,
      address,
      stop() {
        stopping ??= closeServer(server).finally(() => daemon.close());
        return stopping;
      },
    };
  } catch (error) {
    daemon.close();
    throw error;
  }
}

function defaultConsolePath(): string {
  return fileURLToPath(new URL('../../console/dist', import.meta.url));
}

function listen(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1');
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
