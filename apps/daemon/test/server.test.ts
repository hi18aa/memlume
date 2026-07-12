import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { startDaemon, type RunningDaemon } from '../src/index.js';

const directories: string[] = [];
const daemons: RunningDaemon[] = [];

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-daemon-'));
  directories.push(directory);
  return join(directory, 'memlume.sqlite');
}

async function requestJson(
  daemon: RunningDaemon,
  path: string,
  init?: RequestInit,
): Promise<{ readonly response: Response; readonly body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${daemon.address.port}${path}`, init);
  return { response, body: await response.json() };
}

afterEach(async () => {
  while (daemons.length > 0) {
    await daemons.pop()!.stop();
  }
  while (directories.length > 0) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

describe('localhost daemon API', () => {
  test('serves health only over 127.0.0.1 and closes its resources', async () => {
    const daemon = await startDaemon({ databasePath: createDatabasePath(), port: 0 });
    daemons.push(daemon);

    expect(daemon.address.address).toBe('127.0.0.1');

    const { response, body } = await requestJson(daemon, '/v1/health');
    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'ok' });
  });

  test('records events and saves searchable facts through the same daemon store', async () => {
    const daemon = await startDaemon({ databasePath: createDatabasePath(), port: 0 });
    daemons.push(daemon);

    const event = await requestJson(daemon, '/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rawContent: 'Use local SQLite for the first release.',
        eventType: 'decision',
        source: { type: 'test', agent: 'daemon-test', reference: 'daemon:event:1' },
      }),
    });
    expect(event.response.status).toBe(201);
    expect(event.body).toMatchObject({ event: { eventType: 'decision' } });

    const fact = await requestJson(daemon, '/v1/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'fact',
        title: 'Memlume storage',
        canonicalText: 'Memlume uses SQLite FTS5 for the first release.',
        structuredData: {
          subject: 'Memlume',
          predicate: 'uses',
          object: 'SQLite FTS5',
          confidence: 1,
        },
        scope: { level: 'global' },
      }),
    });
    expect(fact.response.status).toBe(201);
    expect(fact.body).toMatchObject({ memory: { kind: 'fact', title: 'Memlume storage' } });

    const search = await requestJson(daemon, '/v1/memories/search?q=SQLite');
    expect(search.response.status).toBe(200);
    expect(search.body).toMatchObject({
      memories: [expect.objectContaining({ kind: 'fact', canonicalText: expect.stringContaining('SQLite FTS5') })],
    });
  });

  test('resolves a stored policy as a directive', async () => {
    const daemon = await startDaemon({ databasePath: createDatabasePath(), port: 0 });
    daemons.push(daemon);

    const policy = await requestJson(daemon, '/v1/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'policy',
        canonicalText: 'Use the local image route.',
        structuredData: {
          trigger: { intents: ['image_generation'] },
          action: { type: 'route_tool', target: 'local-image-route' },
          constraints: { required: true },
        },
        scope: { level: 'global' },
      }),
    });
    expect(policy.response.status).toBe(201);

    const context = await requestJson(daemon, '/v1/context/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intent: 'image_generation',
        scope: { level: 'global' },
        task: null,
        contextBudget: 100,
      }),
    });
    expect(context.response.status).toBe(200);
    expect(context.body).toMatchObject({
      context: {
        directives: [expect.objectContaining({ text: 'Use the local image route.', actionTarget: 'local-image-route' })],
      },
    });
  });

  test('returns safe errors for invalid input and unknown routes', async () => {
    const daemon = await startDaemon({ databasePath: createDatabasePath(), port: 0 });
    daemons.push(daemon);

    const invalid = await requestJson(daemon, '/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rawContent: 'Missing source.', eventType: 'test' }),
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'invalid_request' });

    const missing = await requestJson(daemon, '/v1/not-a-route');
    expect(missing.response.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found' });
  });
});
