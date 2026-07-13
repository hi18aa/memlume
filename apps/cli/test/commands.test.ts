import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { main } from '../src/index.js';

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly authorization: string | undefined;
}

let server: Server;
let url: string;
let response: { readonly status: number; readonly body: unknown };
let requests: RecordedRequest[];
let rawResponse: string | undefined;
let hangResponse: boolean;

beforeEach(async () => {
  requests = [];
  response = { status: 200, body: {} };
  rawResponse = undefined;
  hangResponse = false;
  server = createServer(async (request, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString();
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      body: text === '' ? undefined : JSON.parse(text),
      authorization: request.headers.authorization,
    });
    if (hangResponse) {
      return;
    }
    reply.writeHead(response.status, { 'content-type': 'application/json' });
    reply.end(rawResponse ?? JSON.stringify(response.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

async function run(
  args: string[],
  environment: NodeJS.ProcessEnv = {},
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await main(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  }, environment);
  return { code, stdout, stderr };
}

describe('memlume CLI', () => {
  test('event add posts the event through the daemon', async () => {
    response = { status: 201, body: { event: { id: 'event-1', eventType: 'decision' } } };

    const result = await run([
      '--url',
      url,
      '--token',
      'cli-adapter-token',
      'event',
      'add',
      'Use SQLite.',
      '--type',
      'decision',
      '--agent',
      'codex-cli',
      '--reference',
      'task-7',
    ]);

    expect(result).toEqual({ code: 0, stdout: 'Recorded event event-1.\n', stderr: '' });
    expect(requests).toEqual([
      {
        method: 'POST',
        url: '/v1/events',
        authorization: 'Bearer cli-adapter-token',
        body: {
          rawContent: 'Use SQLite.',
          eventType: 'decision',
          source: { type: 'cli', agent: 'codex-cli', reference: 'task-7' },
        },
      },
    ]);
  });

  test('search sends the query and prints the raw daemon JSON with --json', async () => {
    response = { status: 200, body: { memories: [{ id: 'memory-1', kind: 'fact', canonicalText: 'SQLite FTS5' }] } };

    const result = await run(['--url', url, '--token', 'cli-adapter-token', '--json', 'search', 'SQLite FTS5']);

    expect(result).toEqual({ code: 0, stdout: `${JSON.stringify(response.body)}\n`, stderr: '' });
    expect(requests).toEqual([
      { method: 'GET', url: '/v1/memories/search?q=SQLite+FTS5', body: undefined, authorization: 'Bearer cli-adapter-token' },
    ]);
  });

  test('remember policy posts its required structured data through the daemon', async () => {
    response = { status: 201, body: { memory: { id: 'memory-1', kind: 'policy' } } };

    const result = await run([
      '--url',
      url,
      '--token',
      'cli-adapter-token',
      'remember',
      'Use the local image route.',
      '--kind',
      'policy',
      '--intent',
      'image_generation',
      '--action-type',
      'route_tool',
      '--action-target',
      'local-image-route',
      '--required',
    ]);

    expect(result).toEqual({ code: 0, stdout: 'Saved policy memory memory-1.\n', stderr: '' });
    expect(requests).toEqual([
      {
        method: 'POST',
        url: '/v1/memories',
        authorization: 'Bearer cli-adapter-token',
        body: {
          kind: 'policy',
          canonicalText: 'Use the local image route.',
          scope: { level: 'global' },
          structuredData: {
            trigger: { intents: ['image_generation'] },
            action: { type: 'route_tool', target: 'local-image-route' },
            constraints: { required: true },
          },
        },
      },
    ]);
  });

  test('context resolve posts scope options and prints raw daemon JSON with --json', async () => {
    response = { status: 200, body: { context: { traceId: 'trace-1', directives: [] } } };

    const result = await run([
      '--url',
      url,
      '--token',
      'cli-adapter-token',
      'context',
      'resolve',
      '--intent',
      'image_generation',
      '--task',
      'Generate art.',
      '--tool',
      'codex-img-gen',
      '--entity',
      'sprite',
      '--budget',
      '200',
      '--json',
    ]);

    expect(result).toEqual({ code: 0, stdout: `${JSON.stringify(response.body)}\n`, stderr: '' });
    expect(requests).toEqual([
      {
        method: 'POST',
        url: '/v1/context/resolve',
        authorization: 'Bearer cli-adapter-token',
        body: {
          intent: 'image_generation',
          scope: { level: 'global' },
          task: 'Generate art.',
          contextBudget: 200,
          availableTools: ['codex-img-gen'],
          entities: ['sprite'],
        },
      },
    ]);
  });

  test('returns a nonzero exit and safe daemon error text', async () => {
    response = { status: 400, body: { error: 'invalid_request' } };

    const result = await run(['--url', url, '--token', 'cli-adapter-token', 'search', 'SQLite']);

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'Error: daemon returned 400: invalid_request.\n' });
  });

  test('returns a nonzero timeout error when the daemon does not respond', async () => {
    hangResponse = true;

    const result = await run(['--url', url, '--token', 'cli-adapter-token', 'search', 'SQLite']);

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'Error: daemon request timed out.\n' });
  }, 15_000);

  test('rejects a successful daemon response with an invalid JSON body', async () => {
    rawResponse = 'not JSON';

    const result = await run(['--url', url, '--token', 'cli-adapter-token', '--json', 'search', 'SQLite']);

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'Error: daemon returned an invalid response.\n' });
  });

  test('rejects unsafe daemon URLs without leaking them or making a request', async () => {
    for (const unsafeUrl of [
      url.replace('http:', 'https:'),
      'http://localhost:3849',
      url.replace('http://', 'http://alice:top-secret@'),
      `${url}/other`,
      `${url}/?q=secret`,
      `${url}/#fragment`,
      'not a URL',
    ]) {
      const result = await run(['--url', unsafeUrl, '--token', 'cli-adapter-token', 'search', 'SQLite']);

      expect(result).toEqual({
        code: 1,
        stdout: '',
        stderr: 'Error: daemon URL must be an http://127.0.0.1 or http://[::1] origin.\n',
      });
      expect(result.stderr).not.toContain('top-secret');
    }
    expect(requests).toEqual([]);
  });

  test('rejects a blank integer option before making a daemon request', async () => {
    const result = await run(['--url', url, '--token', 'cli-adapter-token', 'context', 'resolve', '--intent', 'image_generation', '--budget', '']);

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'Error: --budget must be an integer.\n' });
    expect(requests).toEqual([]);
  });

  test('rejects a blank unit-number option before making a daemon request', async () => {
    const result = await run([
      '--url',
      url,
      '--token',
      'cli-adapter-token',
      'remember',
      'SQLite is local.',
      '--kind',
      'fact',
      '--subject',
      'Memlume',
      '--predicate',
      'uses',
      '--object',
      'SQLite',
      '--confidence',
      '',
    ]);

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'Error: --confidence must be a number from 0 to 1.\n' });
    expect(requests).toEqual([]);
  });

  test('uses MEMLUME_TOKEN when --token is not provided', async () => {
    const result = await run(['--url', url, 'search', 'SQLite'], { MEMLUME_TOKEN: 'environment-adapter-token' });

    expect(result).toEqual({ code: 0, stdout: 'No memories found.\n', stderr: '' });
    expect(requests).toEqual([
      { method: 'GET', url: '/v1/memories/search?q=SQLite', body: undefined, authorization: 'Bearer environment-adapter-token' },
    ]);
  });

  test('uses --token ahead of MEMLUME_TOKEN', async () => {
    const result = await run(
      ['--url', url, '--token', 'explicit-adapter-token', 'search', 'SQLite'],
      { MEMLUME_TOKEN: 'environment-adapter-token' },
    );

    expect(result).toEqual({ code: 0, stdout: 'No memories found.\n', stderr: '' });
    expect(requests).toEqual([
      { method: 'GET', url: '/v1/memories/search?q=SQLite', body: undefined, authorization: 'Bearer explicit-adapter-token' },
    ]);
  });

  test('does not contact the daemon when no adapter token is configured', async () => {
    const result = await run(['--url', url, 'search', 'SQLite']);

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Error: adapter token is required. Create one through the protected setup API, then set MEMLUME_TOKEN or pass --token.\n',
    });
    expect(requests).toEqual([]);
  });

  test('does not echo the adapter token when the daemon rejects it', async () => {
    response = { status: 401, body: { error: 'unauthorized' } };
    const secret = 'cli-secret-that-must-not-appear';

    const result = await run(['--url', url, '--token', secret, 'search', 'SQLite']);

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Error: adapter authentication failed. Create a new token through the protected setup API and update MEMLUME_TOKEN.\n',
    });
    expect(result.stderr).not.toContain(secret);
  });
});
