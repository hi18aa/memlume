import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

import { main, parseStartOptions, startFromArgs, type RunningDaemon } from '../src/start.js';

const directories: string[] = [];
const daemons: RunningDaemon[] = [];
const children: ChildProcess[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-daemon-start-'));
  directories.push(directory);
  return directory;
}

function createDatabasePath(): string {
  return join(createTemporaryDirectory(), 'memlume.sqlite');
}

afterEach(async () => {
  while (daemons.length > 0) {
    await daemons.pop()!.stop();
  }
  while (children.length > 0) {
    await stopChild(children.pop()!);
  }
  while (directories.length > 0) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

describe('memlume daemon start entrypoint', () => {
  test('uses the documented database path and port defaults', () => {
    expect(parseStartOptions([])).toEqual({ databasePath: 'data/memlume.sqlite', port: 3849 });
  });

  test('parses documented database and port options', () => {
    expect(parseStartOptions(['--database', './data/memlume.sqlite', '--port', '3849'])).toEqual({
      databasePath: './data/memlume.sqlite',
      port: 3849,
    });
  });

  test.each([
    [['--port', ''], 'Invalid --port.'],
    [['--port', '-1'], 'Invalid --port.'],
    [['--port', '65536'], 'Invalid --port.'],
    [['--port', '38.49'], 'Invalid --port.'],
    [['--port'], 'Missing value for --port.'],
    [['--database'], 'Missing value for --database.'],
    [['--database', ''], 'Invalid --database.'],
    [['--unknown'], 'Unknown option.'],
  ])('rejects invalid option input', (args, message) => {
    expect(() => parseStartOptions(args)).toThrow(message);
  });

  test('prints a safe usage error without writing to stdout', async () => {
    let stdout = '';
    let stderr = '';

    await expect(
      main(['--port', 'not-a-port'], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      }),
    ).resolves.toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toContain('Error: Invalid --port.');
    expect(stderr).toContain('Usage: memlume-daemon');
    expect(stderr).not.toContain('at main');
  });

  test('stops the daemon when its SIGTERM handler runs', async () => {
    let port = 0;
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const existingHandlers = new Set(process.listeners('SIGTERM'));
    const result = main(['--database', createDatabasePath(), '--port', '0'], {
      stdout: () => undefined,
      stderr: (text) => {
        const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(text);
        if (match !== null) {
          port = Number(match[1]);
          resolveStarted?.();
          resolveStarted = undefined;
        }
      },
    });

    await started;
    const handler = process.listeners('SIGTERM').find((listener) => !existingHandlers.has(listener));
    expect(handler).toBeTypeOf('function');
    handler!();

    await expect(result).resolves.toBe(0);
    await expect(fetch(`http://127.0.0.1:${port}/v1/health`)).rejects.toThrow();
  });

  test('starts on localhost and stop closes the HTTP listener', async () => {
    const daemon = await startFromArgs(['--database', createDatabasePath(), '--port', '0']);
    daemons.push(daemon);

    expect(daemon.address.address).toBe('127.0.0.1');
    await expect(fetch(`http://127.0.0.1:${daemon.address.port}/v1/health`).then((response) => response.json())).resolves.toEqual({
      status: 'ok',
    });

    await daemon.stop();
    daemons.pop();
    await expect(fetch(`http://127.0.0.1:${daemon.address.port}/v1/health`)).rejects.toThrow();
  });

  test('reads the setup token from the environment without returning it from setup routes', async () => {
    const setupToken = 'setup-token-from-environment-test';
    const previous = process.env.MEMLUME_SETUP_TOKEN;
    process.env.MEMLUME_SETUP_TOKEN = setupToken;
    try {
      const daemon = await startFromArgs(['--database', createDatabasePath(), '--port', '0']);
      daemons.push(daemon);

      const response = await fetch(`http://127.0.0.1:${daemon.address.port}/v1/setup/brains`, {
        headers: { 'x-memlume-setup-token': setupToken },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ brains: [expect.objectContaining({ kind: 'personal' })] });
      expect(JSON.stringify(body)).not.toContain(setupToken);
    } finally {
      if (previous === undefined) {
        delete process.env.MEMLUME_SETUP_TOKEN;
      } else {
        process.env.MEMLUME_SETUP_TOKEN = previous;
      }
    }
  });

  test('compiled entrypoint creates a missing parent directory and closes on SIGTERM', async () => {
    const workingDirectory = createTemporaryDirectory();
    const entrypoint = fileURLToPath(new URL('../dist/start.js', import.meta.url));
    const child = spawn(process.execPath, [entrypoint, '--database', './data/memlume.sqlite', '--port', '0'], {
      cwd: workingDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (text: string) => {
      stdout += text;
    });

    const port = await waitForListening(child);
    await expect(fetch(`http://127.0.0.1:${port}/v1/health`).then((response) => response.json())).resolves.toEqual({ status: 'ok' });
    expect(existsSync(join(workingDirectory, 'data', 'memlume.sqlite'))).toBe(true);

    child.kill('SIGTERM');
    const exited = await waitForExit(child);
    expect(exited.code === 0 || exited.signal === 'SIGTERM').toBe(true);
    expect(stdout).toBe('');
    await expect(fetch(`http://127.0.0.1:${port}/v1/health`)).rejects.toThrow();
  });
});

function waitForListening(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => finish(new Error('daemon did not report startup.')), 5_000);
    const onData = (text: string) => {
      stderr += text;
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr);
      if (match !== null) {
        finish(undefined, Number(match[1]));
      }
    };
    const onExit = () => finish(new Error('daemon exited before reporting startup.'));
    const finish = (error?: Error, port?: number) => {
      clearTimeout(timeout);
      child.stderr!.off('data', onData);
      child.off('exit', onExit);
      if (error !== undefined) {
        reject(error);
      } else {
        resolve(port!);
      }
    };

    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', onData);
    child.once('exit', onExit);
  });
}

function waitForExit(child: ChildProcess): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('daemon child did not exit.')), 5_000);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(undefined, { code, signal });
    const finish = (error?: Error, result?: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      if (error !== undefined) {
        reject(error);
      } else {
        resolve(result!);
      }
    };

    child.once('exit', onExit);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const stopped = waitForExit(child);
  child.kill('SIGTERM');
  try {
    await stopped;
  } catch {
    const killed = waitForExit(child);
    child.kill('SIGKILL');
    await killed;
  }
}
