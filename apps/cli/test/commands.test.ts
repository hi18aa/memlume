import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { main, type CliRuntime } from '../src/index.js';

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
let responseForRequest: ((request: RecordedRequest) => { readonly status: number; readonly body: unknown }) | undefined;

beforeEach(async () => {
  requests = [];
  response = { status: 200, body: {} };
  rawResponse = undefined;
  hangResponse = false;
  responseForRequest = undefined;
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
    const nextResponse = responseForRequest?.(requests.at(-1)!) ?? response;
    reply.writeHead(nextResponse.status, { 'content-type': 'application/json' });
    reply.end(rawResponse ?? JSON.stringify(nextResponse.body));
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
  runtime?: CliRuntime,
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
  }, environment, runtime);
  return { code, stdout, stderr };
}

function memoryRuntime(config: Record<string, string>, configPath = 'C:/memlume/config.json'): CliRuntime {
  const directories = new Set<string>();
  return {
    configPath: () => configPath,
    cwd: () => 'C:/memlume',
    isInteractive: () => false,
    confirm: async () => true,
    readFile: async (path) => config[path] === undefined ? undefined : new TextEncoder().encode(config[path]),
    writeFile: async (path, value) => {
      config[path] = typeof value === 'string' ? value : new TextDecoder().decode(value);
    },
    mkdir: async (path) => {
      if (directories.has(path)) return false;
      directories.add(path);
      return true;
    },
    removeFile: async (path) => {
      delete config[path];
    },
    removeEmptyDirectory: async (path) => {
      directories.delete(path);
    },
    readdir: async () => [],
    verifyBackup: async () => ({
      format: 'memlume-backup',
      version: 1,
      createdAt: '2026-07-13T00:00:00.000Z',
      encrypted: false,
      checksum: 'checksum',
      files: [],
    }),
    fetch: globalThis.fetch,
  };
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

  test('setup adapter registers an isolated profile, mounts its brain, and keeps its token out of terminal output', async () => {
    const files: Record<string, string> = {};
    const adapterToken = 'hermes-adapter-token-that-must-not-print';
    responseForRequest = (request) => {
      if (request.url === '/v1/setup/installations' && request.method === 'GET') {
        return { status: 200, body: { installations: [] } };
      }
      if (request.url === '/v1/setup/installations') {
        expect(request.method).toBe('POST');
        expect(request.authorization).toBeUndefined();
        expect(request.body).toEqual({
          clientType: 'hermes',
          installationId: 'hermes-main',
          profileId: 'default',
          displayName: 'Memlume Hermes',
        });
        return {
          status: 201,
          body: {
            installation: {
              id: '00000000-0000-7000-8000-000000000021',
              clientType: 'hermes',
              installationId: 'hermes-main',
              profileId: 'default',
              displayName: 'Memlume Hermes',
            },
            token: adapterToken,
          },
        };
      }
      if (request.url === '/v1/setup/mounts') {
        expect(request.method).toBe('POST');
        expect(request.body).toEqual({
          agentInstallationId: '00000000-0000-7000-8000-000000000021',
          brainId: '00000000-0000-7000-8000-000000000020',
          access: 'read_write',
        });
        return { status: 201, body: { mount: {} } };
      }
      if (request.url === '/v1/context/resolve') {
        expect(request.method).toBe('POST');
        expect(request.authorization).toBe(`Bearer ${adapterToken}`);
        expect(request.body).toEqual({
          intent: 'shared_memory',
          scope: { level: 'project', projectId: 'memlume' },
          task: 'Memlume adapter setup smoke test.',
          contextBudget: 1,
          availableTools: [],
          entities: [],
        });
        return { status: 200, body: { context: { directives: [] } } };
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    };

    const result = await run([
      '--url', url,
      '--setup-token', 'setup-token',
      'setup', 'adapter', 'hermes',
      '--installation-id', 'hermes-main',
      '--project-id', 'memlume',
      '--brain-id', '00000000-0000-7000-8000-000000000020',
    ], {}, memoryRuntime(files));

    expect(result).toEqual({
      code: 0,
      stdout: 'Hermes adapter profile is registered, mounted, and passed the daemon smoke test.\n',
      stderr: '',
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(adapterToken);
    expect(requests.map((request) => request.url)).toEqual([
      '/v1/setup/installations',
      '/v1/setup/installations',
      '/v1/setup/mounts',
      '/v1/context/resolve',
    ]);
    expect(JSON.parse(files['C:/memlume/config.json']!)).toMatchObject({
      version: 1,
      adapters: [{
        clientType: 'hermes',
        installationId: 'hermes-main',
        profileId: 'default',
        projectId: 'memlume',
        brainId: '00000000-0000-7000-8000-000000000020',
        token: adapterToken,
      }],
    });
  });

  test('setup adapter does not silently replace a daemon installation whose local profile is missing', async () => {
    responseForRequest = (request) => {
      if (request.method === 'GET' && request.url === '/v1/setup/installations') {
        return {
          status: 200,
          body: {
            installations: [{
              id: '00000000-0000-7000-8000-000000000021',
              clientType: 'hermes',
              installationId: 'hermes-main',
              profileId: 'default',
            }],
          },
        };
      }
      return { status: 500, body: { error: 'unexpected_request' } };
    };

    const result = await run([
      '--url', url,
      '--setup-token', 'setup-token',
      'setup', 'adapter', 'hermes',
      '--installation-id', 'hermes-main',
      '--project-id', 'memlume',
      '--brain-id', '00000000-0000-7000-8000-000000000020',
    ], {}, memoryRuntime({}));

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Error: daemon already has this Adapter installation, but its local profile is missing. Restore the local config or rotate the token explicitly.\n',
    });
    expect(requests).toHaveLength(1);
  });
});
