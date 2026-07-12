import { openDatabase } from '@memlume/database/internal';
import { ContextResolver } from '@memlume/context-resolver';
import { EventJournal } from '@memlume/event-journal';
import { MemoryStore } from '@memlume/retrieval';
import express, { type Express } from 'express';
import { type AddressInfo, type Server } from 'node:net';

import { registerRoutes } from './routes.js';

export interface DaemonOptions {
  readonly databasePath: string;
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

export function createDaemon({ databasePath }: DaemonOptions): Daemon {
  const database = openDatabase(databasePath);
  let closed = false;

  try {
    const journal = new EventJournal(database);
    const store = new MemoryStore(database);
    const resolver = new ContextResolver(store);
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '1mb' }));
    registerRoutes(app, { journal, store, resolver });

    return {
      app,
      close() {
        if (!closed) {
          closed = true;
          database.close();
        }
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function startDaemon({ databasePath, port = 0 }: StartDaemonOptions): Promise<RunningDaemon> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Port must be an integer from 0 to 65535.');
  }

  const daemon = createDaemon({ databasePath });
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
