import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createMcpServer } from '../src/index.js';

const PROJECT_BRAIN_ID = '00000000-0000-7000-8000-000000000002';

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly authorization: string | undefined;
}

let daemon: Server;
let daemonUrl: string;
let requests: RecordedRequest[];
let response: { readonly status: number; readonly body: unknown };
let rawResponse: string | undefined;
let responseHeaders: Record<string, string> | undefined;

beforeEach(async () => {
  requests = [];
  response = { status: 200, body: { context: { traceId: 'trace-1', directives: [] } } };
  rawResponse = undefined;
  responseHeaders = undefined;
  daemon = createServer(async (request, reply) => {
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
    reply.writeHead(response.status, { 'content-type': 'application/json', ...responseHeaders });
    reply.end(rawResponse ?? JSON.stringify(response.body));
  });
  await new Promise<void>((resolve) => daemon.listen(0, '127.0.0.1', resolve));
  daemonUrl = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  daemon.closeAllConnections();
  await new Promise<void>((resolve, reject) => daemon.close((error) => (error === undefined ? resolve() : reject(error))));
});

async function connect(options: { readonly token?: string } = { token: 'mcp-adapter-token' }) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'memlume-test', version: '0.2.0' });
  const server = createMcpServer({ daemonUrl, ...options });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

describe('Memlume MCP server', () => {
  test('lists daemon-backed tools with required resolve-context schema', async () => {
    const { client, server } = await connect();

    await expect(client.listTools()).resolves.toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({
          name: 'memlume.resolve_context',
          inputSchema: expect.objectContaining({ required: expect.arrayContaining(['intent', 'scope', 'task', 'contextBudget']) }),
        }),
        expect.objectContaining({ name: 'memlume.record_event' }),
        expect.objectContaining({ name: 'memlume.remember' }),
        expect.objectContaining({ name: 'memlume.search' }),
        expect.objectContaining({ name: 'memlume.record_memory_usage' }),
        expect.objectContaining({ name: 'memlume.record_outcome' }),
      ]),
    });
    await server.close();
  });

  test('exposes v0.3 ReadSet/workspace evidence fields for context planning', async () => {
    const { client, server } = await connect();
    const { tools } = await client.listTools();
    const resolve = tools.find((tool) => tool.name === 'memlume.resolve_context');
    const inputSchema = resolve?.inputSchema as { readonly properties?: Record<string, unknown> };
    expect(inputSchema.properties).toEqual(expect.objectContaining({
      workspace_path: expect.anything(),
      requested_brain_ids: expect.anything(),
      parent_read_set: expect.anything(),
    }));
    await server.close();
  });

  test('canonical remember exposes workspace and turn identity for automatic capture', async () => {
    const { client, server } = await connect();
    const { tools } = await client.listTools();
    const remember = tools.find((tool) => tool.name === 'remember');
    const properties = (remember?.inputSchema as { readonly properties?: Record<string, unknown> }).properties;
    expect(properties).toEqual(expect.objectContaining({
      workspace_path: expect.anything(),
      session_id: expect.anything(),
      turn_id: expect.anything(),
    }));
    await server.close();
  });

  test('exposes the remember object schema to MCP clients', async () => {
    const { client, server } = await connect();
    const { tools } = await client.listTools();
    const remember = tools.find((tool) => tool.name === 'memlume.remember');
    const inputSchema = remember?.inputSchema as {
      readonly additionalProperties?: boolean;
      readonly properties?: Record<string, unknown>;
      readonly required?: readonly string[];
      readonly type?: string;
    };

    expect(inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining(['canonicalText', 'scope', 'kind', 'structuredData']),
    });
    expect(inputSchema.properties).toEqual(expect.objectContaining({
      canonicalText: expect.anything(),
      scope: expect.anything(),
      kind: expect.objectContaining({ enum: expect.arrayContaining(['policy', 'preference', 'fact', 'decision']) }),
      structuredData: expect.objectContaining({ anyOf: expect.any(Array) }),
    }));
    await server.close();
  });

  test('resolve_context posts its arguments and returns the daemon JSON as structured content', async () => {
    const { client, server } = await connect();
    const body = { context: { traceId: 'trace-1', directives: [] } };
    response = { status: 200, body };

    await expect(
      client.callTool({
        name: 'memlume.resolve_context',
        arguments: {
          intent: 'image_generation',
          scope: { level: 'global' },
          task: 'Generate art.',
          contextBudget: 200,
          entities: ['sprite'],
          available_tools: ['image-gen'],
        },
      }),
    ).resolves.toMatchObject({
      structuredContent: body,
      content: [{ type: 'text', text: JSON.stringify(body) }],
    });
    expect(requests).toEqual([
      {
        method: 'POST',
        url: '/v1/context/resolve',
        authorization: 'Bearer mcp-adapter-token',
        body: {
          intent: 'image_generation',
          scope: { level: 'global' },
          task: 'Generate art.',
          contextBudget: 200,
          entities: ['sprite'],
          availableTools: ['image-gen'],
        },
      },
    ]);
    await server.close();
  });

  test('posts explainable memory usage and task outcome feedback', async () => {
    const { client, server } = await connect();
    const memoryId = '018f9d4e-7c2a-7b91-8dc0-61749dbcc01e';
    const traceId = '018f9d4e-7c2f-7b91-8dc0-61749dbcc01e';
    response = { status: 201, body: { usage: { id: memoryId }, outcome: { id: memoryId } } };

    await client.callTool({
      name: 'memlume.record_memory_usage',
      arguments: { trace_id: traceId, memory_id: memoryId, task_id: 'task-feedback', retrieval_rank: 1, was_included: true, outcome: 'adopted' },
    });
    await client.callTool({
      name: 'memlume.record_outcome',
      arguments: { trace_id: traceId, task_id: 'task-feedback', result: 'success', used_memory_ids: [memoryId], used_tool_ids: ['terminal'] },
    });

    expect(requests).toEqual([
      {
        method: 'POST',
        url: `/v1/memories/${memoryId}/usage`,
        authorization: 'Bearer mcp-adapter-token',
        body: { traceId, taskId: 'task-feedback', retrievalRank: 1, wasIncluded: true, outcome: 'adopted' },
      },
      {
        method: 'POST',
        url: '/v1/outcomes',
        authorization: 'Bearer mcp-adapter-token',
        body: { traceId, taskId: 'task-feedback', result: 'success', usedMemoryIds: [memoryId], usedToolIds: ['terminal'] },
      },
    ]);
    await server.close();
  });

  test('record_event forwards an explicit brain selection and returns its source brain', async () => {
    const { client, server } = await connect();
    const body = { event: { id: 'event-1', eventType: 'decision', brainId: PROJECT_BRAIN_ID } };
    response = { status: 201, body };

    await expect(
      client.callTool({
        name: 'memlume.record_event',
        arguments: { brainId: PROJECT_BRAIN_ID, rawContent: 'Use SQLite.', eventType: 'decision', source: { type: 'mcp', agent: 'test' } },
      }),
    ).resolves.toMatchObject({ structuredContent: { ...body, sourceBrainId: PROJECT_BRAIN_ID } });
    expect(requests).toEqual([
      {
        method: 'POST',
        url: '/v1/events',
        authorization: 'Bearer mcp-adapter-token',
        body: { brainId: PROJECT_BRAIN_ID, rawContent: 'Use SQLite.', eventType: 'decision', source: { type: 'mcp', agent: 'test' } },
      },
    ]);
    await server.close();
  });

  test('does not forward a remember request whose data does not match its kind', async () => {
    const { client, server } = await connect();

    await expect(
      client.callTool({
        name: 'memlume.remember',
        arguments: {
          kind: 'policy',
          canonicalText: 'SQLite is local.',
          scope: { level: 'global' },
          structuredData: { subject: 'SQLite', predicate: 'is', object: 'local', confidence: 1 },
        },
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(requests).toEqual([]);
    await server.close();
  });

  test('returns saved status and source brain only after a successful remember response', async () => {
    const { client, server } = await connect();
    const body = { memory: { id: 'memory-1', kind: 'fact', brainId: PROJECT_BRAIN_ID } };
    response = { status: 201, body };

    await expect(
      client.callTool({
        name: 'memlume.remember',
        arguments: {
          brainId: PROJECT_BRAIN_ID,
          kind: 'fact',
          canonicalText: 'Memlume uses SQLite.',
          scope: { level: 'global' },
          structuredData: { subject: 'Memlume', predicate: 'uses', object: 'SQLite', confidence: 1 },
        },
      }),
    ).resolves.toMatchObject({
      structuredContent: { ...body, status: 'candidate', sourceBrainId: PROJECT_BRAIN_ID },
      content: [{ type: 'text', text: JSON.stringify({ ...body, status: 'candidate', sourceBrainId: PROJECT_BRAIN_ID }) }],
    });
    expect(requests).toEqual([
      {
        method: 'POST',
        url: '/v1/memories/candidate',
        authorization: 'Bearer mcp-adapter-token',
        body: {
          brainId: PROJECT_BRAIN_ID,
          kind: 'fact',
          canonicalText: 'Memlume uses SQLite.',
          scope: { level: 'global' },
          structuredData: { subject: 'Memlume', predicate: 'uses', object: 'SQLite', confidence: 1 },
        },
      },
    ]);
    await server.close();
  });

  test('does not let remember use a tool argument to impersonate another installation or bypass a rejected mount', async () => {
    const { client, server } = await connect();
    response = { status: 403, body: { error: 'forbidden' } };

    await expect(
      client.callTool({
        name: 'memlume.remember',
        arguments: {
          brainId: PROJECT_BRAIN_ID,
          agentInstallationId: '00000000-0000-7000-8000-000000000003',
          kind: 'fact',
          canonicalText: 'A caller must not choose another installation.',
          scope: { level: 'global' },
          structuredData: { subject: 'access', predicate: 'is', object: 'token-bound', confidence: 1 },
        },
      }),
    ).resolves.toMatchObject({
      isError: true,
      content: [
        {
          type: 'text',
          text: expect.stringContaining('Unrecognized key: \\"agentInstallationId\\"'),
        },
      ],
    });
    expect(requests).toEqual([]);
    await server.close();
  });

  test('reports a mounted-brain rejection instead of claiming remember was saved or queued', async () => {
    const { client, server } = await connect();
    response = { status: 403, body: { error: 'forbidden' } };

    const result = await client.callTool({
      name: 'memlume.remember',
      arguments: {
        brainId: PROJECT_BRAIN_ID,
        kind: 'fact',
        canonicalText: 'A token only writes to mounted brains.',
        scope: { level: 'global' },
        structuredData: { subject: 'access', predicate: 'is', object: 'mounted', confidence: 1 },
      },
    });

    expect(result).toMatchObject({ isError: true, structuredContent: { status: 'rejected' } });
    expect(requests).toEqual([
      {
        method: 'POST',
        url: '/v1/memories/candidate',
        authorization: 'Bearer mcp-adapter-token',
        body: {
          brainId: PROJECT_BRAIN_ID,
          kind: 'fact',
          canonicalText: 'A token only writes to mounted brains.',
          scope: { level: 'global' },
          structuredData: { subject: 'access', predicate: 'is', object: 'mounted', confidence: 1 },
        },
      },
    ]);
    expect(JSON.stringify(result).toLowerCase()).not.toContain('saved');
    expect(JSON.stringify(result).toLowerCase()).not.toContain('queued');
    await server.close();
  });

  test('uses MEMLUME_TOKEN when no token option is supplied', async () => {
    vi.stubEnv('MEMLUME_TOKEN', 'environment-adapter-token');
    const { client, server } = await connect({});

    await expect(client.callTool({ name: 'memlume.search', arguments: { query: 'SQLite' } })).resolves.toMatchObject({ structuredContent: response.body });
    expect(requests).toEqual([
      { method: 'GET', url: '/v1/memories/search?q=SQLite', body: undefined, authorization: 'Bearer environment-adapter-token' },
    ]);
    await server.close();
  });

  test('uses an explicit token ahead of MEMLUME_TOKEN', async () => {
    vi.stubEnv('MEMLUME_TOKEN', 'environment-adapter-token');
    const { client, server } = await connect({ token: 'explicit-adapter-token' });

    await expect(client.callTool({ name: 'memlume.search', arguments: { query: 'SQLite' } })).resolves.toMatchObject({ structuredContent: response.body });
    expect(requests).toEqual([
      { method: 'GET', url: '/v1/memories/search?q=SQLite', body: undefined, authorization: 'Bearer explicit-adapter-token' },
    ]);
    await server.close();
  });

  test('does not contact the daemon when no adapter token is configured', async () => {
    vi.stubEnv('MEMLUME_TOKEN', '');
    const { client, server } = await connect({});

    await expect(client.callTool({ name: 'memlume.search', arguments: { query: 'SQLite' } })).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Memlume adapter token is required. Create one through the protected setup API, then set MEMLUME_TOKEN.' }],
    });
    expect(requests).toEqual([]);
    await server.close();
  });

  test('does not echo a rejected adapter token or claim that remember was saved', async () => {
    const secret = 'mcp-secret-that-must-not-appear';
    response = { status: 401, body: { error: 'unauthorized' } };
    const { client, server } = await connect({ token: secret });

    const result = await client.callTool({
      name: 'memlume.remember',
      arguments: {
        kind: 'fact',
        canonicalText: 'Memlume uses SQLite.',
        scope: { level: 'global' },
        structuredData: { subject: 'Memlume', predicate: 'uses', object: 'SQLite', confidence: 1 },
      },
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Memlume adapter authentication failed. Create a new token through the protected setup API and update MEMLUME_TOKEN.' }],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result).toLowerCase()).not.toContain('saved');
    await server.close();
  });

  test.each([
    [400, 'invalid_request'],
    [500, 'internal_error'],
  ])('maps a daemon %i response to a safe MCP tool error', async (status, error) => {
    const { client, server } = await connect();
    response = { status, body: { error } };

    await expect(client.callTool({ name: 'memlume.search', arguments: { query: 'SQLite' } })).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: `Daemon request failed (${status}: ${error}).` }],
    });
    expect(requests).toEqual([
      { method: 'GET', url: '/v1/memories/search?q=SQLite', body: undefined, authorization: 'Bearer mcp-adapter-token' },
    ]);
    await server.close();
  });

  test('maps an invalid daemon JSON response to a safe MCP tool error', async () => {
    const { client, server } = await connect();
    rawResponse = 'not json';

    await expect(client.callTool({ name: 'memlume.search', arguments: { query: 'SQLite' } })).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Daemon returned an invalid response.' }],
    });
    await server.close();
  });

  test('does not follow daemon redirects', async () => {
    let redirectedRequests = 0;
    const redirectTarget = createServer((_request, reply) => {
      redirectedRequests += 1;
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.end('{}');
    });
    await new Promise<void>((resolve) => redirectTarget.listen(0, '127.0.0.1', resolve));
    const redirectUrl = `http://127.0.0.1:${(redirectTarget.address() as AddressInfo).port}/received`;
    response = { status: 307, body: {} };
    responseHeaders = { location: redirectUrl };

    const { client, server } = await connect();
    await expect(client.callTool({ name: 'memlume.search', arguments: { query: 'SQLite' } })).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Unable to reach daemon.' }],
    });
    expect(redirectedRequests).toBe(0);
    await server.close();
    redirectTarget.closeAllConnections();
    await new Promise<void>((resolve, reject) => redirectTarget.close((error) => (error === undefined ? resolve() : reject(error))));
  });
});
