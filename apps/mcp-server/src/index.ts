#!/usr/bin/env node
import {
  DecisionDataSchema,
  EventSourceSchema,
  FactDataSchema,
  IsoDateSchema,
  IsoUtcDateTimeSchema,
  JsonValueSchema,
  MemoryScopeSchema,
  NonEmptyTextSchema,
  PolicyDataSchema,
  PreferenceDataSchema,
  UuidV7Schema,
} from '@memlume/contracts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:3849';
const REQUEST_TIMEOUT_MS = 10_000;
const DAEMON_URL_ERROR = 'Daemon URL must be an http://127.0.0.1 or http://[::1] origin.';

const ResolveContextSchema = z
  .object({
    intent: NonEmptyTextSchema.describe('The task intent to resolve.'),
    scope: MemoryScopeSchema.describe('The memory scope to resolve.'),
    task: z.string().nullable().describe('A task description, or null when unavailable.'),
    contextBudget: z.number().int().nonnegative().describe('Maximum context budget in units.'),
    entities: z.array(NonEmptyTextSchema).optional().describe('Relevant task entities.'),
    available_tools: z.array(NonEmptyTextSchema).optional().describe('Tools available to the calling agent.'),
  })
  .strict();

const RecordEventSchema = z
  .object({
    rawContent: z.string().refine((value) => value.trim().length > 0, 'Expected non-empty text.').describe('Immutable event content.'),
    eventType: NonEmptyTextSchema.describe('Event type.'),
    source: EventSourceSchema.describe('At least one source identifier.'),
    structuredData: JsonValueSchema.optional().describe('Optional JSON event data.'),
    occurredAt: IsoUtcDateTimeSchema.optional().describe('Optional UTC ISO 8601 timestamp.'),
  })
  .strict();

const MemoryRequestBaseSchema = z.object({
  canonicalText: NonEmptyTextSchema.describe('Canonical memory text.'),
  title: NonEmptyTextSchema.optional().describe('Optional memory title.'),
  scope: MemoryScopeSchema.describe('Memory scope.'),
  priority: z.number().int().optional().describe('Optional integer priority.'),
  confidence: z.number().min(0).max(1).optional().describe('Optional confidence from 0 to 1.'),
  explicitness: z.number().min(0).max(1).optional().describe('Optional explicitness from 0 to 1.'),
  sourceEventId: UuidV7Schema.optional().describe('Optional source event UUIDv7.'),
  validFrom: IsoDateSchema.optional().describe('Optional validity start date.'),
  validUntil: IsoDateSchema.optional().describe('Optional validity end date.'),
});

const RememberSchema = z.discriminatedUnion('kind', [
  MemoryRequestBaseSchema.extend({ kind: z.literal('policy'), structuredData: PolicyDataSchema }),
  MemoryRequestBaseSchema.extend({ kind: z.literal('preference'), structuredData: PreferenceDataSchema }),
  MemoryRequestBaseSchema.extend({ kind: z.literal('fact'), structuredData: FactDataSchema }),
  MemoryRequestBaseSchema.extend({ kind: z.literal('decision'), structuredData: DecisionDataSchema }),
]);

const RememberInputSchema = MemoryRequestBaseSchema.extend({
  kind: z.enum(['policy', 'preference', 'fact', 'decision']).describe('Memory kind.'),
  structuredData: z
    .union([PolicyDataSchema, PreferenceDataSchema, FactDataSchema, DecisionDataSchema])
    .describe('Data for the selected memory kind.'),
}).strict();

const SearchSchema = z
  .object({
    query: NonEmptyTextSchema.refine((value) => /[\p{L}\p{N}_]/u.test(value), 'Expected searchable text.').describe('Memory search query.'),
  })
  .strict();

export interface McpServerOptions {
  readonly daemonUrl?: string;
}

export function createMcpServer({ daemonUrl = DEFAULT_DAEMON_URL }: McpServerOptions = {}): McpServer {
  const safeDaemonUrl = daemonOrigin(daemonUrl);
  const server = new McpServer({ name: 'memlume', version: '0.1.0' });

  server.registerTool(
    'memlume.resolve_context',
    {
      title: 'Resolve Memlume context',
      description: 'Resolve scoped Memlume context for an agent task.',
      inputSchema: ResolveContextSchema,
    },
    async ({ available_tools, ...input }) => daemonTool(safeDaemonUrl, '/v1/context/resolve', 'POST', {
      ...input,
      availableTools: available_tools,
    }),
  );

  server.registerTool(
    'memlume.record_event',
    {
      title: 'Record Memlume event',
      description: 'Append an immutable event through the local Memlume daemon.',
      inputSchema: RecordEventSchema,
    },
    async (input) => daemonTool(safeDaemonUrl, '/v1/events', 'POST', input),
  );

  server.registerTool(
    'memlume.remember',
    {
      title: 'Save Memlume memory',
      description: 'Save a policy, preference, fact, or decision through the local Memlume daemon.',
      inputSchema: RememberInputSchema,
    },
    async (input) => {
      const parsed = RememberSchema.safeParse(input);
      if (!parsed.success) {
        return { content: [{ type: 'text', text: 'Invalid remember request.' }], isError: true };
      }
      return daemonTool(safeDaemonUrl, '/v1/memories', 'POST', parsed.data);
    },
  );

  server.registerTool(
    'memlume.search',
    {
      title: 'Search Memlume memories',
      description: 'Search memories through the local Memlume daemon.',
      inputSchema: SearchSchema,
    },
    async ({ query }) => daemonTool(safeDaemonUrl, `/v1/memories/search?${new URLSearchParams({ q: query })}`, 'GET'),
  );

  return server;
}

async function daemonTool(
  daemonUrl: string,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<CallToolResult> {
  try {
    const result = await requestDaemon(daemonUrl, path, method, body);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) {
    const message = error instanceof DaemonRequestError ? error.message : 'Daemon request failed.';
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

async function requestDaemon(
  daemonUrl: string,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(new URL(path, daemonUrl), {
      method,
      redirect: 'error',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new DaemonRequestError(isTimeoutError(error) ? 'Daemon request timed out.' : 'Unable to reach daemon.');
  }

  if (!response.ok) {
    throw new DaemonRequestError(`Daemon request failed (${response.status}: ${daemonErrorCode(await responseJson(response))}).`);
  }

  const result = await responseJson(response);
  if (!isRecord(result)) {
    throw new DaemonRequestError('Daemon returned an invalid response.');
  }
  return result;
}

function daemonOrigin(value: string): string {
  let daemonUrl: URL;
  try {
    daemonUrl = new URL(value);
  } catch {
    throw new DaemonRequestError(DAEMON_URL_ERROR);
  }

  if (
    daemonUrl.protocol !== 'http:' ||
    (daemonUrl.hostname !== '127.0.0.1' && daemonUrl.hostname !== '[::1]') ||
    daemonUrl.username !== '' ||
    daemonUrl.password !== '' ||
    daemonUrl.pathname !== '/' ||
    daemonUrl.search !== '' ||
    daemonUrl.hash !== ''
  ) {
    throw new DaemonRequestError(DAEMON_URL_ERROR);
  }

  return daemonUrl.toString();
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function daemonErrorCode(result: unknown): string {
  if (isRecord(result) && typeof result.error === 'string' && /^[a-z][a-z0-9_-]{0,63}$/i.test(result.error)) {
    return result.error;
  }
  return 'request_failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimeoutError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'TimeoutError';
}

class DaemonRequestError extends Error {}

export async function main(): Promise<void> {
  const server = createMcpServer({ daemonUrl: process.env.MEMLUME_DAEMON_URL });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1]?.endsWith('index.js')) {
  void main().catch((error) => {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : 'Unable to start MCP server.'}\n`);
    process.exitCode = 1;
  });
}
