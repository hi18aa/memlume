import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { main, parseStartOptions, startFromArgs, type RunningDaemon } from '../src/start.js';

const directories: string[] = [];
const daemons: RunningDaemon[] = [];

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-daemon-start-'));
  directories.push(directory);
  return join(directory, 'memlume.sqlite');
}

afterEach(async () => {
  while (daemons.length > 0) {
    await daemons.pop()!.stop();
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
});
