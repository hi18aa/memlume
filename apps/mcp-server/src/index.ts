#!/usr/bin/env node
import {
  DecisionDataSchema,
  EventSourceSchema,
  FactDataSchema,
  IsoDateSchema,
  IsoUtcDateTimeSchema,
  JsonValueSchema,
  MemoryScopeSchema,
  MemoryUsageOutcomeSchema,
  NonEmptyTextSchema,
  OutcomeResultSchema,
  PolicyDataSchema,
  PreferenceDataSchema,
  UuidV7Schema,
  createUuidV7,
  ReadSetSchema,
  AdapterCallbackSchema,
} from '@memlume/contracts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:3849';
const REQUEST_TIMEOUT_MS = 10_000;
const DAEMON_URL_ERROR = 'Daemon URL must be an http://127.0.0.1 or http://[::1] origin.';
const MCP_PROTOCOL_VERSION = '1';
const MCP_ADAPTER_VERSION = '0.3.0';

const ResolveContextSchema = z
  .object({
    intent: NonEmptyTextSchema.describe('The task intent to resolve.'),
    scope: MemoryScopeSchema.describe('The memory scope to resolve.'),
    task: z.string().nullable().describe('A task description, or null when unavailable.'),
    contextBudget: z.number().int().nonnegative().describe('Maximum context budget in units.'),
    entities: z.array(NonEmptyTextSchema).optional().describe('Relevant task entities.'),
    available_tools: z.array(NonEmptyTextSchema).optional().describe('Tools available to the calling agent.'),
    requested_brain_ids: z.array(UuidV7Schema).min(1).optional().describe('Optional subset; daemon validates against ReadSet.'),
    workspace_path: NonEmptyTextSchema.optional().describe('Workspace path evidence for Brain routing.'),
    task_id: NonEmptyTextSchema.optional().describe('Stable task identity.'),
    agent_type: NonEmptyTextSchema.optional().describe('Calling host type.'),
    subagent_id: NonEmptyTextSchema.optional().describe('Optional sub-agent identity.'),
    child_goal: z.string().nullable().optional().describe('Optional child goal.'),
    parent_read_set: ReadSetSchema.optional().describe('Parent ReadSet grant to intersect.'),
  })
  .strict();

const RecordEventSchema = z
  .object({
    brainId: UuidV7Schema.optional().describe('Optional mounted shared Brain UUIDv7.'),
    rawContent: z.string().refine((value) => value.trim().length > 0, 'Expected non-empty text.').describe('Immutable event content.'),
    eventType: NonEmptyTextSchema.describe('Event type.'),
    source: EventSourceSchema.describe('At least one source identifier.'),
    structuredData: JsonValueSchema.optional().describe('Optional JSON event data.'),
    occurredAt: IsoUtcDateTimeSchema.optional().describe('Optional UTC ISO 8601 timestamp.'),
  })
  .strict();

const MemoryRequestBaseSchema = z.object({
  brainId: UuidV7Schema.optional().describe('Optional mounted shared Brain UUIDv7.'),
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

const RecordMemoryUsageSchema = z.object({
  trace_id: UuidV7Schema.describe('Trace UUIDv7 returned by memlume.resolve_context.'),
  memory_id: UuidV7Schema.describe('Memory UUIDv7 returned by context or search.'),
  task_id: NonEmptyTextSchema.describe('Stable task identifier.'),
  retrieval_rank: z.number().int().nonnegative().nullable().optional().describe('Rank at retrieval time, when known.'),
  was_included: z.boolean().describe('Whether the memory was included in the agent context.'),
  outcome: MemoryUsageOutcomeSchema.nullable().optional().describe('adopted, ignored, or corrected when already known.'),
}).strict();

const RecordOutcomeSchema = z.object({
  trace_id: UuidV7Schema.describe('Trace UUIDv7 returned by memlume.resolve_context; each trace accepts one task outcome.'),
  task_id: NonEmptyTextSchema.describe('Stable task identifier.'),
  result: OutcomeResultSchema.describe('Overall task result.'),
  correction_type: NonEmptyTextSchema.nullable().optional().describe('Optional correction category.'),
  correction_data: JsonValueSchema.nullable().optional().describe('Optional redacted correction details.'),
  used_memory_ids: z.array(UuidV7Schema).min(1).max(256).describe('Memory UUIDs used by the task.'),
  used_tool_ids: z.array(NonEmptyTextSchema).max(256).describe('Tools used by the task.'),
}).strict();

export interface McpServerOptions {
  readonly daemonUrl?: string;
  readonly token?: string;
}

export function createMcpServer({ daemonUrl = DEFAULT_DAEMON_URL, token = process.env.MEMLUME_TOKEN }: McpServerOptions = {}): McpServer {
  const safeDaemonUrl = daemonOrigin(daemonUrl);
  const server = new McpServer({ name: 'memlume', version: '0.3.0' });

  server.registerTool(
    'memlume.resolve_context',
    {
      title: 'Resolve Memlume context',
      description: 'Resolve scoped Memlume context for an agent task.',
      inputSchema: ResolveContextSchema,
    },
    async ({ available_tools, requested_brain_ids, workspace_path, task_id, agent_type, subagent_id, child_goal, parent_read_set, ...input }) => daemonTool(safeDaemonUrl, token, '/v1/context/resolve', 'POST', {
      ...input,
      availableTools: available_tools,
      ...(requested_brain_ids === undefined ? {} : { requestedBrainIds: requested_brain_ids }),
      ...(workspace_path === undefined ? {} : { workspacePath: workspace_path }),
      ...(task_id === undefined ? {} : { taskId: task_id }),
      ...(agent_type === undefined ? {} : { agentType: agent_type }),
      ...(subagent_id === undefined ? {} : { subagentId: subagent_id }),
      ...(child_goal === undefined ? {} : { childGoal: child_goal }),
      ...(parent_read_set === undefined ? {} : { parentReadSet: parent_read_set }),
    }),
  );

  server.registerTool(
    'memlume.record_event',
    {
      title: 'Record Memlume event',
      description: 'Append an immutable event through the local Memlume daemon.',
      inputSchema: RecordEventSchema,
    },
    async (input) => daemonWriteTool(safeDaemonUrl, token, '/v1/events', input, 'event'),
  );

  server.registerTool(
    'memlume.remember',
    {
      title: 'Save Memlume memory',
      description: 'Submit a policy, preference, fact, or decision as a reviewable candidate through the local Memlume daemon.',
      inputSchema: RememberInputSchema,
    },
    async (input) => {
      const parsed = RememberSchema.safeParse(input);
      if (!parsed.success) {
        return rejectedRemember('Invalid remember request.');
      }
      return rememberTool(safeDaemonUrl, token, parsed.data);
    },
  );

  server.registerTool(
    'memlume.record_memory_usage',
    {
      title: 'Record memory usage',
      description: 'Record whether a retrieved shared memory was included and adopted, ignored, or corrected.',
      inputSchema: RecordMemoryUsageSchema,
    },
    async ({ trace_id, memory_id, task_id, retrieval_rank, was_included, outcome }) => daemonTool(
      safeDaemonUrl,
      token,
      `/v1/memories/${encodeURIComponent(memory_id)}/usage`,
      'POST',
      {
        traceId: trace_id,
        taskId: task_id,
        retrievalRank: retrieval_rank,
        wasIncluded: was_included,
        outcome,
      },
    ),
  );

  server.registerTool(
    'memlume.record_outcome',
    {
      title: 'Record task outcome',
      description: 'Record a task result and the memories/tools that contributed to it.',
      inputSchema: RecordOutcomeSchema,
    },
    async ({ trace_id, task_id, result, correction_type, correction_data, used_memory_ids, used_tool_ids }) => daemonTool(
      safeDaemonUrl,
      token,
      '/v1/outcomes',
      'POST',
      {
        traceId: trace_id,
        taskId: task_id,
        result,
        correctionType: correction_type,
        correctionData: correction_data,
        usedMemoryIds: used_memory_ids,
        usedToolIds: used_tool_ids,
      },
    ),
  );

  server.registerTool(
    'memlume.search',
    {
      title: 'Search Memlume memories',
      description: 'Search memories through the local Memlume daemon.',
      inputSchema: SearchSchema,
    },
    async ({ query }) => daemonTool(safeDaemonUrl, token, `/v1/memories/search?${new URLSearchParams({ q: query })}`, 'GET'),
  );

  // Canonical v0.3 names are intentionally unprefixed.  The v0.2
  // memlume.* names above remain as one-release compatibility aliases.
  server.registerTool(
    'search',
    { title: 'Search shared memory', description: 'Search active memories through the local daemon.', inputSchema: SearchSchema },
    async ({ query }) => daemonTool(safeDaemonUrl, token, `/v1/memories/search?${new URLSearchParams({ q: query })}`, 'GET'),
  );
  server.registerTool(
    'remember',
    {
      title: 'Capture a memory',
      description: 'Submit user/agent evidence through the automatic capture pipeline; the daemon decides Brain and activation.',
      inputSchema: z.object({
        text: NonEmptyTextSchema,
        capture_id: NonEmptyTextSchema.optional(),
        event_type: NonEmptyTextSchema.optional(),
        source: EventSourceSchema.optional(),
      }).strict(),
    },
    async ({ text, capture_id, event_type, source }) => daemonTool(safeDaemonUrl, token, '/v1/capture', 'POST', {
      captureId: capture_id ?? UuidV7Schema.parse(createUuidV7()),
      rawContent: text,
      eventType: event_type ?? 'user_message',
      source: source ?? { type: 'mcp', agent: 'mcp' },
      actor: 'tool',
    }),
  );
  server.registerTool(
    'forget',
    { title: 'Forget memory', description: 'Request a tombstone for one memory.', inputSchema: z.object({ memory_id: UuidV7Schema }).strict() },
    async ({ memory_id }) => daemonTool(safeDaemonUrl, token, `/v1/memories/${encodeURIComponent(memory_id)}`, 'DELETE'),
  );
  server.registerTool(
    'explain',
    { title: 'Explain memory', description: 'Show source and version history for a memory.', inputSchema: z.object({ memory_id: UuidV7Schema }).strict() },
    async ({ memory_id }) => daemonTool(safeDaemonUrl, token, `/v1/memories/${encodeURIComponent(memory_id)}/history`, 'GET'),
  );
  server.registerTool(
    'review',
    {
      title: 'Review candidate',
      description: 'Approve or reject a candidate with an auditable reason.',
      inputSchema: z.object({ memory_id: UuidV7Schema, action: z.enum(['approve', 'reject']), reason: NonEmptyTextSchema, supersede_memory_id: UuidV7Schema.optional() }).strict(),
    },
    async ({ memory_id, action, reason, supersede_memory_id }) => daemonTool(safeDaemonUrl, token, `/v1/memories/${encodeURIComponent(memory_id)}/${action}`, 'POST', {
      actor: 'mcp',
      reason,
      ...(supersede_memory_id === undefined ? {} : { supersedeMemoryId: supersede_memory_id }),
    }),
  );
  server.registerTool(
    'route',
    {
      title: 'Route inbox item',
      description: 'Resolve a durable routing Inbox item to an explicitly selected Brain.',
      inputSchema: z.object({ record_id: NonEmptyTextSchema, brain_id: UuidV7Schema }).strict(),
    },
    async ({ record_id, brain_id }) => daemonTool(safeDaemonUrl, token, `/v1/inbox/${encodeURIComponent(record_id)}/route`, 'POST', { brainId: brain_id }),
  );
  server.registerTool(
    'status',
    { title: 'Memlume status', description: 'Read daemon health without memory content or tokens.', inputSchema: z.object({}).strict() },
    async () => daemonTool(safeDaemonUrl, token, '/v1/status', 'GET'),
  );

  return server;
}

async function daemonTool(
  daemonUrl: string,
  token: string | undefined,
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
): Promise<CallToolResult> {
  try {
    const result = await requestDaemon(daemonUrl, token, path, method, body);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) {
    const message = error instanceof DaemonRequestError ? error.message : 'Daemon request failed.';
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

async function requestDaemon(
  daemonUrl: string,
  token: string | undefined,
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
): Promise<Record<string, unknown>> {
  const adapterToken = requiredAdapterToken(token);
  let response: Response;
  try {
    const callback = callbackFor(path);
    response = await fetch(new URL(path, daemonUrl), {
      method,
      redirect: 'error',
      headers: {
        authorization: `Bearer ${adapterToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(callback === undefined ? {} : {
          'x-memlume-callback': callback,
          'x-memlume-protocol-version': MCP_PROTOCOL_VERSION,
          'x-memlume-adapter-version': MCP_ADAPTER_VERSION,
        }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new DaemonRequestError(isTimeoutError(error) ? 'Daemon request timed out.' : 'Unable to reach daemon.');
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new DaemonRequestError('Memlume adapter authentication failed. Create a new token through the protected setup API and update MEMLUME_TOKEN.');
    }
    throw new DaemonRequestError(`Daemon request failed (${response.status}: ${daemonErrorCode(await responseJson(response))}).`);
  }

  const result = await responseJson(response);
  if (!isRecord(result)) {
    throw new DaemonRequestError('Daemon returned an invalid response.');
  }
  return result;
}

function callbackFor(path: string): z.infer<typeof AdapterCallbackSchema> | undefined {
  if (path === '/v1/context/resolve') return 'beforeTask';
  if (path === '/v1/capture' || path === '/v1/events' || path === '/v1/memories/capture') return 'onUserMessage';
  return undefined;
}

async function daemonWriteTool(
  daemonUrl: string,
  token: string | undefined,
  path: '/v1/events' | '/v1/memories',
  body: unknown,
  resource: 'event' | 'memory',
): Promise<CallToolResult> {
  try {
    const result = await requestDaemon(daemonUrl, token, path, 'POST', body);
    const sourceBrainId = responseBrainId(result, resource);
    if (sourceBrainId === undefined) {
      throw new DaemonRequestError('Daemon returned an invalid response.');
    }
    return successfulTool({ ...result, sourceBrainId });
  } catch (error) {
    return failedTool(error);
  }
}

async function rememberTool(daemonUrl: string, token: string | undefined, body: unknown): Promise<CallToolResult> {
  try {
    const result = await requestDaemon(daemonUrl, token, '/v1/memories/candidate', 'POST', body);
    const sourceBrainId = responseBrainId(result, 'memory');
    if (sourceBrainId === undefined) {
      throw new DaemonRequestError('Daemon returned an invalid response.');
    }
    return successfulTool({ ...result, status: 'candidate', sourceBrainId });
  } catch (error) {
    return rejectedRemember(errorMessage(error));
  }
}

function successfulTool(result: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}

function failedTool(error: unknown): CallToolResult {
  return { content: [{ type: 'text', text: errorMessage(error) }], isError: true };
}

function rejectedRemember(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true, structuredContent: { status: 'rejected' } };
}

function errorMessage(error: unknown): string {
  return error instanceof DaemonRequestError ? error.message : 'Daemon request failed.';
}

function responseBrainId(result: Record<string, unknown>, resource: 'event' | 'memory'): string | undefined {
  const item = result[resource];
  if (!isRecord(item)) {
    return undefined;
  }
  return UuidV7Schema.safeParse(item.brainId).data;
}

function requiredAdapterToken(token: string | undefined): string {
  if (token === undefined || token.trim() === '') {
    throw new DaemonRequestError('Memlume adapter token is required. Create one through the protected setup API, then set MEMLUME_TOKEN.');
  }
  return token;
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
