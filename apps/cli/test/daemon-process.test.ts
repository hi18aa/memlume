import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { daemonPaths, defaultDataRoot, ensureDaemon } from '../src/daemon-process.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function runtime(fetch: typeof fetch, spawn: (command: string, args: readonly string[], options: any) => any, processAlive = () => false) {
  return {
    fetch,
    spawn,
    processAlive,
    sleep: async () => undefined,
  };
}

function healthResponse(healthy: boolean): Response {
  return new Response(JSON.stringify(healthy ? { status: 'ok', service: 'memlume' } : { status: 'ok', service: 'other' }), { status: 200 });
}

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'memlume-daemon-process-'));
  directories.push(path);
  return path;
}

describe('daemon process ensure', () => {
  test('uses a per-user data root and does not spawn when the daemon is healthy', async () => {
    expect(defaultDataRoot('C:/Users/alice')).toBe(join('C:/Users/alice', '.memlume'));
    const dataRoot = await root();
    let spawns = 0;
    const result = await ensureDaemon({
      dataRoot,
      runtime: runtime(async () => healthResponse(true), () => { spawns += 1; return { pid: 1 }; }),
    });
    expect(result.started).toBe(false);
    expect(spawns).toBe(0);
    expect(result.setupToken.length).toBeGreaterThan(20);
  });

  test('starts once for concurrent callers and reuses the generated setup token', async () => {
    const dataRoot = await root();
    let healthy = false;
    let spawns = 0;
    const fetch = async () => healthResponse(healthy);
    const spawn = () => {
      spawns += 1;
      healthy = true;
      return { pid: 4321, unref() {} };
    };
    const [first, second] = await Promise.all([
      ensureDaemon({ dataRoot, runtime: runtime(fetch, spawn), pollMs: 1 }),
      ensureDaemon({ dataRoot, runtime: runtime(fetch, spawn), pollMs: 1 }),
    ]);
    expect(spawns).toBe(1);
    expect(first.setupToken).toBe(second.setupToken);
    expect((await readFile(join(dataRoot, 'daemon.pid'), 'utf8')).trim()).toBe('4321');
  });

  test('reclaims a stale PID but rejects a live PID with a non-Memlume health endpoint', async () => {
    const dataRoot = await root();
    const paths = daemonPaths({ dataRoot });
    await writeFile(paths.pidPath, '9999\n');
    let healthy = false;
    const started = await ensureDaemon({
      dataRoot,
      runtime: runtime(async () => healthResponse(healthy), () => { healthy = true; return { pid: 1001 }; }),
    });
    expect(started.started).toBe(true);

    await writeFile(paths.pidPath, '9999\n');
    await expect(ensureDaemon({
      dataRoot,
      runtime: runtime(async () => healthResponse(false), () => ({ pid: 1002 }), () => true),
    })).rejects.toThrow(/health endpoint is not Memlume/);
  });

  test('cleans its PID after a child startup timeout', async () => {
    const dataRoot = await root();
    let killed = false;
    await expect(ensureDaemon({
      dataRoot,
      startTimeoutMs: 10,
      pollMs: 1,
      runtime: runtime(async () => healthResponse(false), () => ({ pid: 5151, kill: () => { killed = true; return true; } })),
    })).rejects.toThrow(/Timed out/);
    expect(killed).toBe(true);
    await expect(readFile(join(dataRoot, 'daemon.pid'))).rejects.toThrow();
  });
});
