import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { main } from '../src/index.js';

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

let server: Server;
let url: string;
let response: { readonly status: number; readonly body: unknown };
let requests: RecordedRequest[];

beforeEach(async () => {
  requests = [];
  response = { status: 200, body: {} };
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
    });
    reply.writeHead(response.status, { 'content-type': 'application/json' });
    reply.end(JSON.stringify(response.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

async function run(args: string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await main(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe('memlume CLI', () => {
  test('event add posts the event through the daemon', async () => {
    response = { status: 201, body: { event: { id: 'event-1', eventType: 'decision' } } };

    const result = await run([
      '--url',
      url,
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

    const result = await run(['--url', url, '--json', 'search', 'SQLite FTS5']);

    expect(result).toEqual({ code: 0, stdout: `${JSON.stringify(response.body)}\n`, stderr: '' });
    expect(requests).toEqual([{ method: 'GET', url: '/v1/memories/search?q=SQLite+FTS5', body: undefined }]);
  });

  test('remember policy posts its required structured data through the daemon', async () => {
    response = { status: 201, body: { memory: { id: 'memory-1', kind: 'policy' } } };

    const result = await run([
      '--url',
      url,
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

    const result = await run(['--url', url, 'search', 'SQLite']);

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'Error: daemon returned 400: invalid_request.\n' });
  });
});
