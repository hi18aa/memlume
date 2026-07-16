import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

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

function memoryRuntime(
  config: Record<string, string>,
  configPath = 'C:/memlume/config.json',
  commands: string[][] = [],
  copies: string[][] = [],
): CliRuntime {
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
    homePath: () => 'C:/Users/memlume',
    pathExists: async () => false,
    copyDirectory: async (source: string, destination: string) => {
      copies.push([source, destination]);
    },
    removeDirectory: async () => undefined,
    verifyBackup: async () => ({
      format: 'memlume-backup',
      version: 1,
      createdAt: '2026-07-13T00:00:00.000Z',
      encrypted: false,
      checksum: 'checksum',
      files: [],
    }),
    fetch: globalThis.fetch,
    run: async (command: string, args: string[]) => {
      commands.push([command, ...args]);
      return { code: 0, stdout: '', stderr: '' };
    },
  } as CliRuntime;
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

  test('setup adapter installs Codex from its existing profile without issuing another token', async () => {
    const commands: string[][] = [];
    const files = {
      'C:/memlume/config.json': JSON.stringify({
        version: 1,
        backupDirectory: 'C:/memlume/backups',
        adapters: [{
          clientType: 'codex',
          installationId: 'codex-main',
          profileId: 'default',
          projectId: 'memlume',
          brainId: '00000000-0000-7000-8000-000000000020',
          token: 'codex-token-not-for-output',
          corePath: 'C:/work/memlume',
          daemonUrl: url,
        }],
      }),
    };

    const result = await run([
      '--config', 'C:/memlume/config.json',
      'setup', 'adapter', 'codex',
      '--installation-id', 'codex-main',
      '--project-id', 'memlume',
      '--brain-id', '00000000-0000-7000-8000-000000000020',
      '--install-host', '--yes',
    ], {}, memoryRuntime(files, 'C:/memlume/config.json', commands));

    expect(result).toEqual({
      code: 0,
      stdout: 'Codex Plugin was installed. Pending user action: review and trust its hooks in Codex before using Shared Brain context.\n',
      stderr: '',
    });
    expect(commands).toEqual([
      ['codex', 'plugin', 'marketplace', 'add', 'C:/work/memlume'],
      ['codex', 'plugin', 'add', 'memlume-codex@memlume'],
    ]);
    expect(requests).toEqual([]);
    expect(`${result.stdout}${result.stderr}`).not.toContain('codex-token-not-for-output');
  });

  test('setup adapter copies and enables Hermes only in its reserved local plugin directory', async () => {
    const commands: string[][] = [];
    const copies: string[][] = [];
    const files = {
      'C:/memlume/config.json': JSON.stringify({
        version: 1,
        backupDirectory: 'C:/memlume/backups',
        adapters: [{
          clientType: 'hermes', installationId: 'hermes-main', profileId: 'default', projectId: 'memlume',
          brainId: '00000000-0000-7000-8000-000000000020', token: 'hermes-token-not-for-output',
          corePath: 'C:/work/memlume', daemonUrl: url,
        }],
      }),
    };

    const result = await run([
      '--config', 'C:/memlume/config.json',
      'setup', 'adapter', 'hermes',
      '--installation-id', 'hermes-main', '--project-id', 'memlume', '--brain-id', '00000000-0000-7000-8000-000000000020',
      '--install-host', '--yes',
    ], {}, memoryRuntime(files, 'C:/memlume/config.json', commands, copies));

    expect(result).toEqual({ code: 0, stdout: 'Hermes Plugin was installed and enabled.\n', stderr: '' });
    expect(copies).toEqual([[
      join('C:/work/memlume', 'adapters', 'hermes'),
      join('C:/Users/memlume', '.hermes', 'plugins', 'memlume'),
    ]]);
    expect(commands).toEqual([
      ['hermes', 'plugins', 'enable', 'memlume'],
      ['hermes', 'plugins', 'list'],
    ]);
    expect(`${result.stdout}${result.stderr}${JSON.stringify(copies)}`).not.toContain('hermes-token-not-for-output');
  });

  test('setup adapter installs OpenClaw with only non-secret plugin configuration', async () => {
    const commands: string[][] = [];
    const files = {
      'C:/memlume/config.json': JSON.stringify({
        version: 1,
        backupDirectory: 'C:/memlume/backups',
        adapters: [{
          clientType: 'openclaw', installationId: 'openclaw-main', profileId: 'default', projectId: 'memlume',
          brainId: '00000000-0000-7000-8000-000000000020', token: 'openclaw-token-not-for-config',
          corePath: 'C:/work/memlume', daemonUrl: url, workspacePath: 'C:/work/project',
        }],
      }),
    };

    const result = await run([
      '--config', 'C:/memlume/config.json',
      'setup', 'adapter', 'openclaw',
      '--installation-id', 'openclaw-main', '--project-id', 'memlume', '--brain-id', '00000000-0000-7000-8000-000000000020',
      '--install-host', '--yes',
    ], {}, memoryRuntime(files, 'C:/memlume/config.json', commands));

    expect(result).toEqual({ code: 0, stdout: 'OpenClaw Plugin was installed and passed runtime inspection.\n', stderr: '' });
    expect(commands).toEqual([
      ['openclaw', 'plugins', 'install', '--link', join('C:/work/memlume', 'adapters', 'openclaw')],
      ['openclaw', 'plugins', 'enable', 'memlume-openclaw'],
      ['openclaw', 'config', 'unset', 'plugins.entries.memlume-openclaw.hooks.allowConversationAccess'],
      ['openclaw', 'config', 'set', 'plugins.entries.memlume-openclaw.hooks.allowPromptInjection', 'true', '--strict-json'],
      ['openclaw', 'config', 'set', 'plugins.entries.memlume-openclaw.config', JSON.stringify({
        installationId: 'openclaw-main', profileId: 'default', projectId: 'memlume', brainId: '00000000-0000-7000-8000-000000000020',
        corePath: 'C:/work/memlume', daemonUrl: url, workspacePath: 'C:/work/project',
      }), '--strict-json'],
      ['openclaw', 'gateway', 'restart'],
      ['openclaw', 'plugins', 'inspect', 'memlume-openclaw', '--runtime', '--json'],
    ]);
    expect(JSON.stringify(commands)).not.toContain('openclaw-token-not-for-config');
  });

  test('setup adapter installs Claude Code from its existing profile without printing the token', async () => {
    const commands: string[][] = [];
    const files = {
      'C:/memlume/config.json': JSON.stringify({
        version: 1,
        backupDirectory: 'C:/memlume/backups',
        adapters: [{
          clientType: 'claude-code', installationId: 'claude-main', profileId: 'default', projectId: 'memlume',
          brainId: '00000000-0000-7000-8000-000000000020', token: 'claude-token-not-for-output',
          corePath: 'C:/work/memlume', daemonUrl: url,
        }],
      }),
    };

    const result = await run([
      '--config', 'C:/memlume/config.json',
      'setup', 'adapter', 'claude-code',
      '--installation-id', 'claude-main', '--project-id', 'memlume', '--brain-id', '00000000-0000-7000-8000-000000000020',
      '--install-host', '--yes',
    ], {}, memoryRuntime(files, 'C:/memlume/config.json', commands));

    expect(result).toEqual({
      code: 0,
      stdout: 'Claude Code Plugin was installed. Pending user action: review and trust its hooks in Claude Code before using Shared Brain context.\n',
      stderr: '',
    });
    expect(commands).toEqual([
      ['claude', 'plugin', 'marketplace', 'add', 'C:/work/memlume'],
      ['claude', 'plugin', 'install', 'memlume-claude-code@memlume'],
    ]);
    expect(`${result.stdout}${result.stderr}${JSON.stringify(commands)}`).not.toContain('claude-token-not-for-output');
  });

  test('setup adapter dry run previews only non-secret OpenClaw host commands', async () => {
    const commands: string[][] = [];
    const files = {
      'C:/memlume/config.json': JSON.stringify({
        version: 1,
        backupDirectory: 'C:/memlume/backups',
        adapters: [{
          clientType: 'openclaw', installationId: 'openclaw-main', profileId: 'default', projectId: 'memlume',
          brainId: '00000000-0000-7000-8000-000000000020', token: 'openclaw-token-not-for-preview',
          corePath: 'C:/work/memlume', daemonUrl: url, workspacePath: 'C:/work/project',
        }],
      }),
    };

    const result = await run([
      '--config', 'C:/memlume/config.json',
      'setup', 'adapter', 'openclaw',
      '--installation-id', 'openclaw-main', '--project-id', 'memlume', '--brain-id', '00000000-0000-7000-8000-000000000020',
      '--install-host', '--dry-run',
    ], {}, memoryRuntime(files, 'C:/memlume/config.json', commands));

    expect(result).toEqual({
      code: 0,
      stdout: [
        'Dry run; no host command will be executed:',
        `openclaw plugins install --link ${join('C:/work/memlume', 'adapters', 'openclaw')}`,
        'openclaw plugins enable memlume-openclaw',
        'openclaw config unset plugins.entries.memlume-openclaw.hooks.allowConversationAccess',
        'openclaw config set plugins.entries.memlume-openclaw.hooks.allowPromptInjection true --strict-json',
        `openclaw config set plugins.entries.memlume-openclaw.config ${JSON.stringify(JSON.stringify({
          installationId: 'openclaw-main', profileId: 'default', projectId: 'memlume', brainId: '00000000-0000-7000-8000-000000000020',
          corePath: 'C:/work/memlume', daemonUrl: url, workspacePath: 'C:/work/project',
        }))} --strict-json`,
        'openclaw gateway restart',
        'openclaw plugins inspect memlume-openclaw --runtime --json',
        '',
      ].join('\n'),
      stderr: '',
    });
    expect(commands).toEqual([]);
    expect(`${result.stdout}${result.stderr}`).not.toContain('openclaw-token-not-for-preview');
  });

  test('setup adapter refuses a non-interactive host installation until --yes is explicit', async () => {
    const commands: string[][] = [];
    const files = {
      'C:/memlume/config.json': JSON.stringify({
        version: 1,
        backupDirectory: 'C:/memlume/backups',
        adapters: [{
          clientType: 'codex', installationId: 'codex-main', profileId: 'default', projectId: 'memlume',
          brainId: '00000000-0000-7000-8000-000000000020', token: 'codex-token-not-for-confirmation',
          corePath: 'C:/work/memlume', daemonUrl: url,
        }],
      }),
    };

    const result = await run([
      '--config', 'C:/memlume/config.json',
      'setup', 'adapter', 'codex',
      '--installation-id', 'codex-main', '--project-id', 'memlume', '--brain-id', '00000000-0000-7000-8000-000000000020',
      '--install-host',
    ], {}, memoryRuntime(files, 'C:/memlume/config.json', commands));

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Error: 非互動環境安裝 Host Plugin 必須明確傳入 --yes。\n',
    });
    expect(commands).toEqual([]);
    expect(`${result.stdout}${result.stderr}`).not.toContain('codex-token-not-for-confirmation');
  });

  test('init and project commands use protected daemon workflows', async () => {
    responseForRequest = (request) => {
      if (request.url === '/v1/setup/init') return { status: 200, body: { personal: { id: 'personal-1' } } };
      if (request.url === '/v1/setup/projects') return { status: 201, body: { project: { id: 'project-1', name: 'Memlume' } } };
      if (request.url === '/v1/setup/projects/project-1/bindings') return { status: 201, body: { binding: { brainId: 'project-1', role: 'primary', access: 'read_write' } } };
      if (request.url === '/v1/setup/projects/project-1/aliases') return { status: 201, body: { alias: 'frontend' } };
      if (request.url?.startsWith('/v1/setup/projects/inspect?')) return { status: 200, body: { bindings: [{ brainId: 'project-1', role: 'primary', access: 'read_write' }] } };
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    };
    const args = ['--url', url, '--setup-token', 'setup-token'];
    expect((await run([...args, 'init', '--path', 'C:/work'])).code).toBe(0);
    expect((await run([...args, 'project', 'create', 'Memlume'])).code).toBe(0);
    expect((await run([...args, 'project', 'bind', 'project-1', '--path', 'C:/work', '--role', 'primary'])).code).toBe(0);
    expect((await run([...args, 'project', 'alias', 'project-1', 'frontend'])).code).toBe(0);
    expect((await run([...args, 'project', 'inspect', '--path', 'C:/work'])).code).toBe(0);
    expect(requests.map((request) => request.url)).toEqual([
      '/v1/setup/init',
      '/v1/setup/projects',
      '/v1/setup/projects/project-1/bindings',
      '/v1/setup/projects/project-1/aliases',
      '/v1/setup/projects/inspect?workspacePath=C%3A%2Fwork',
    ]);
    expect(requests[0]?.body).toEqual({ workspacePath: 'C:/work', name: 'Personal' });
    expect(requests[2]?.body).toEqual({ workspacePath: 'C:/work', role: 'primary' });
  });

  test('edit and reindex are daemon maintenance requests with explicit repair mode', async () => {
    responseForRequest = (request) => {
      if (request.url === '/v1/setup/records/record-1/edit') return { status: 200, body: { recordId: 'record-2' } };
      if (request.url === '/v1/setup/reindex') return { status: 200, body: { projected: [{ recordId: 'record-2' }] } };
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    };
    const args = ['--url', url, '--setup-token', 'setup-token'];
    expect((await run([...args, 'edit', 'record-1', '--text', 'Updated.', '--repair'])).code).toBe(0);
    expect((await run([...args, 'reindex', '--repair'])).code).toBe(0);
    expect(requests[0]?.body).toEqual({ text: 'Updated.', repair: true });
    expect(requests[1]?.body).toEqual({ repair: true });
  });
});
