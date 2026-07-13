#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { startDaemon, type RunningDaemon } from './server.js';

export type { RunningDaemon } from './server.js';

const DEFAULT_DATABASE_PATH = 'data/memlume.sqlite';
const DEFAULT_PORT = 3849;
const usage = `Usage: memlume-daemon [--database <path>] [--port <port>]

Options:
  --database <path>  SQLite database path (default: ${DEFAULT_DATABASE_PATH})
  --port <port>      TCP port (default: ${DEFAULT_PORT})
  --help, -h         Show this help
`;

type Writer = (text: string) => void;

interface Io {
  readonly stdout: Writer;
  readonly stderr: Writer;
}

interface StartOptions {
  readonly databasePath: string;
  readonly port: number;
}

class UsageError extends Error {}

export function parseStartOptions(args: readonly string[]): StartOptions {
  let databasePath = DEFAULT_DATABASE_PATH;
  let port = DEFAULT_PORT;

  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case '--database': {
        const value = optionValue(args, index, '--database');
        if (value.trim() === '') {
          throw new UsageError('Invalid --database.');
        }
        databasePath = value;
        index += 1;
        break;
      }
      case '--port': {
        const value = optionValue(args, index, '--port');
        if (!/^\d+$/.test(value)) {
          throw new UsageError('Invalid --port.');
        }
        port = Number(value);
        if (!Number.isSafeInteger(port) || port > 65535) {
          throw new UsageError('Invalid --port.');
        }
        index += 1;
        break;
      }
      default:
        throw new UsageError('Unknown option.');
    }
  }

  return { databasePath, port };
}

export function startFromArgs(args: readonly string[]): Promise<RunningDaemon> {
  const options = parseStartOptions(args);
  const parentDirectory = dirname(options.databasePath);
  if (parentDirectory !== '.') {
    mkdirSync(parentDirectory, { recursive: true });
  }
  return startDaemon({ ...options, setupToken: process.env.MEMLUME_SETUP_TOKEN });
}

export async function main(args: readonly string[], io: Io = defaultIo): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    io.stdout(usage);
    return 0;
  }

  let daemon: RunningDaemon;
  try {
    daemon = await startFromArgs(args);
  } catch (error) {
    io.stderr(`Error: ${error instanceof UsageError ? error.message : 'Unable to start daemon.'}\n`);
    if (error instanceof UsageError) {
      io.stderr(usage);
    }
    return 1;
  }

  const stopping = stopOnSignal(daemon);
  io.stderr(`Memlume daemon listening on http://${daemon.address.address}:${daemon.address.port}\n`);
  await stopping;
  return 0;
}

function optionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`Missing value for ${option}.`);
  }
  return value;
}

function stopOnSignal(daemon: RunningDaemon): Promise<void> {
  return new Promise((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) {
        return;
      }
      stopping = true;
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      void daemon.stop().then(resolve, resolve);
    };

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

const defaultIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

if (process.argv[1]?.endsWith('start.js')) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
