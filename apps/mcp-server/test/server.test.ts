import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createMcpServer } from '../src/index.js';

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
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
    requests.push({ method: request.method ?? '', url: request.url ?? '', body: text === '' ? undefined : JSON.parse(text) });
    reply.writeHead(response.status, { 'content-type': 'application/json', ...responseHeaders });
    reply.end(rawResponse ?? JSON.stringify(response.body));
  });
  await new Promise<void>((resolve) => daemon.listen(0, '127.0.0.1', resolve));
  daemonUrl = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;
});

afterEach(async () => {
  daemon.closeAllConnections();
  await new Promise<void>((resolve, reject) => daemon.close((error) => (error === undefined ? resolve() : reject(error))));
});

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'memlume-test', version: '0.1.0' });
  const server = createMcpServer({ daemonUrl });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

describe('Memlume MCP server', () => {
  test('lists the four daemon-backed tools with required resolve-context schema', async () => {
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
      ]),
    });
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

  test('record_event forwards its arguments to the daemon', async () => {
    const { client, server } = await connect();
    const body = { event: { id: 'event-1', eventType: 'decision' } };
    response = { status: 201, body };

    await expect(
      client.callTool({
        name: 'memlume.record_event',
        arguments: { rawContent: 'Use SQLite.', eventType: 'decision', source: { type: 'mcp', agent: 'test' } },
      }),
    ).resolves.toMatchObject({ structuredContent: body });
    expect(requests).toEqual([
      {
        method: 'POST',
        url: '/v1/events',
        body: { rawContent: 'Use SQLite.', eventType: 'decision', source: { type: 'mcp', agent: 'test' } },
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
