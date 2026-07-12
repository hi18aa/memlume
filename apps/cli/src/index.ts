#!/usr/bin/env node
import { Command, CommanderError } from 'commander';

type Writer = (text: string) => void;

const REQUEST_TIMEOUT_MS = 10_000;
const DAEMON_URL_ERROR = 'daemon URL must be an http://127.0.0.1 or http://[::1] origin.';

interface Io {
  readonly stdout: Writer;
  readonly stderr: Writer;
}

interface GlobalOptions {
  readonly url: string;
  readonly json: boolean;
}

interface ScopeOptions {
  readonly scope?: string;
  readonly domain?: string;
  readonly agent?: string;
  readonly workspace?: string;
  readonly project?: string;
  readonly taskId?: string;
}

class DaemonResponseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`daemon returned ${status}: ${code}.`);
  }
}

class DaemonConnectionError extends Error {
  constructor() {
    super('unable to reach daemon.');
  }
}

export async function main(args: readonly string[], io: Io = defaultIo): Promise<number> {
  const program = createProgram(io);

  try {
    await program.parseAsync(args, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }

    io.stderr(`Error: ${errorMessage(error)}\n`);
    return 1;
  }
}

function createProgram(io: Io): Command {
  const program = new Command();
  program
    .name('memlume')
    .description('Use a local Memlume daemon.')
    .option('--url <url>', 'daemon URL', 'http://127.0.0.1:3849')
    .option('--json', 'print raw daemon JSON')
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .exitOverride();

  const event = program.command('event').description('Record daemon events.');
  event
    .command('add <content>')
    .description('Record an event.')
    .requiredOption('--type <eventType>', 'event type')
    .option('--agent <agent>', 'source agent')
    .option('--reference <reference>', 'source reference')
    .action(async (content: string, options: { readonly type: string; readonly agent?: string; readonly reference?: string }, command: Command) => {
      const global = command.optsWithGlobals<GlobalOptions>();
      const source = compact({ type: 'cli', agent: options.agent, reference: options.reference });
      const result = await request(global.url, '/v1/events', 'POST', {
        rawContent: content,
        eventType: options.type,
        source,
      });
      printResult(result, global.json, io.stdout, (body) => `Recorded event ${nestedId(body, 'event') ?? 'event'}.`);
    });

  const remember = program
    .command('remember <content>')
    .description('Save a structured memory.')
    .requiredOption('--kind <kind>', 'policy, preference, fact, or decision')
    .option('--title <title>', 'memory title')
    .option('--scope <scope>', 'global, domain, agent, workspace, project, or task', 'global')
    .option('--domain <domain>', 'scope domain')
    .option('--agent <agent>', 'scope agent')
    .option('--workspace <workspace>', 'scope workspace')
    .option('--project <project>', 'scope project')
    .option('--task-id <taskId>', 'scope task ID')
    .option('--priority <priority>', 'memory priority')
    .option('--confidence <confidence>', 'memory confidence')
    .option('--explicitness <explicitness>', 'memory explicitness')
    .option('--source-event-id <sourceEventId>', 'source event UUID')
    .option('--valid-from <date>', 'valid-from date')
    .option('--valid-until <date>', 'valid-until date')
    .option('--intent <intent...>', 'policy trigger intent')
    .option('--entity <entity...>', 'policy trigger entity')
    .option('--tool <tool...>', 'policy required tool')
    .option('--action-type <type>', 'policy action type')
    .option('--action-target <target>', 'policy action target')
    .option('--exclusive', 'make the policy exclusive')
    .option('--required', 'make the policy required')
    .option('--preference-domain <domain>', 'preference domain')
    .option('--subject <subject>', 'preference or fact subject')
    .option('--dimension <dimension>', 'preference dimension')
    .option('--value <value>', 'preference value')
    .option('--strength <strength>', 'preference strength')
    .option('--predicate <predicate>', 'fact predicate')
    .option('--object <object>', 'fact object')
    .option('--status <status>', 'decision status')
    .option('--rationale <rationale>', 'decision rationale')
    .option('--supersedes <memoryId>', 'decision superseded memory UUID')
    .action(async (content: string, options: RememberOptions, command: Command) => {
      const global = command.optsWithGlobals<GlobalOptions>();
      const body = memoryRequest(content, options);
      const result = await request(global.url, '/v1/memories', 'POST', body);
      printResult(result, global.json, io.stdout, (response) => `Saved ${options.kind} memory ${nestedId(response, 'memory') ?? 'memory'}.`);
    });

  program
    .command('search <query>')
    .description('Search memories.')
    .action(async (query: string, _options: unknown, command: Command) => {
      const global = command.optsWithGlobals<GlobalOptions>();
      const result = await request(global.url, `/v1/memories/search?${new URLSearchParams({ q: query })}`, 'GET');
      printResult(result, global.json, io.stdout, searchSummary);
    });

  const context = program.command('context').description('Resolve context through the daemon.');
  addScopeOptions(
    context
      .command('resolve')
      .description('Resolve a context pack.')
      .requiredOption('--intent <intent>', 'intent')
      .option('--task <task>', 'task description')
      .option('--budget <tokens>', 'context budget', '5000')
      .option('--tool <tool...>', 'available tool')
      .option('--entity <entity...>', 'task entity'),
  ).action(async (options: ResolveOptions, command: Command) => {
    const global = command.optsWithGlobals<GlobalOptions>();
    const body = compact({
      intent: options.intent,
      scope: scopeFor(options),
      task: options.task ?? null,
      contextBudget: nonNegativeInteger(options.budget, '--budget'),
      availableTools: options.tool,
      entities: options.entity,
    });
    const result = await request(global.url, '/v1/context/resolve', 'POST', body);
    printResult(result, global.json, io.stdout, contextSummary);
  });

  return program;
}

function addScopeOptions(command: Command): Command {
  return command
    .option('--scope <scope>', 'global, domain, agent, workspace, project, or task', 'global')
    .option('--domain <domain>', 'scope domain')
    .option('--agent <agent>', 'scope agent')
    .option('--workspace <workspace>', 'scope workspace')
    .option('--project <project>', 'scope project')
    .option('--task-id <taskId>', 'scope task ID');
}

type RememberOptions = ScopeOptions & {
  readonly kind: string;
  readonly title?: string;
  readonly priority?: string;
  readonly confidence?: string;
  readonly explicitness?: string;
  readonly sourceEventId?: string;
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly intent?: string[];
  readonly entity?: string[];
  readonly tool?: string[];
  readonly actionType?: string;
  readonly actionTarget?: string;
  readonly exclusive?: boolean;
  readonly required?: boolean;
  readonly preferenceDomain?: string;
  readonly subject?: string;
  readonly dimension?: string;
  readonly value?: string;
  readonly strength?: string;
  readonly predicate?: string;
  readonly object?: string;
  readonly status?: string;
  readonly rationale?: string;
  readonly supersedes?: string;
};

interface ResolveOptions extends ScopeOptions {
  readonly intent: string;
  readonly task?: string;
  readonly budget: string;
  readonly tool?: string[];
  readonly entity?: string[];
}

function memoryRequest(content: string, options: RememberOptions): Record<string, unknown> {
  const base = compact({
    kind: options.kind,
    title: options.title,
    canonicalText: content,
    scope: scopeFor(options),
    priority: optionalInteger(options.priority, '--priority'),
    confidence: optionalUnitNumber(options.confidence, '--confidence'),
    explicitness: optionalUnitNumber(options.explicitness, '--explicitness'),
    sourceEventId: options.sourceEventId,
    validFrom: options.validFrom,
    validUntil: options.validUntil,
  });

  switch (options.kind) {
    case 'policy':
      return {
        ...base,
        structuredData: {
          trigger: compact({
            intents: requiredList(options.intent, '--intent'),
            entities: options.entity,
            requiredToolAvailability: options.tool,
          }),
          action: { type: required(options.actionType, '--action-type'), target: required(options.actionTarget, '--action-target') },
          constraints: compact({ exclusive: options.exclusive || undefined, required: options.required || undefined }),
        },
      };
    case 'preference':
      return {
        ...base,
        structuredData: {
          domain: required(options.preferenceDomain, '--preference-domain'),
          subject: required(options.subject, '--subject'),
          dimension: required(options.dimension, '--dimension'),
          value: required(options.value, '--value'),
          strength: unitNumber(options.strength, '--strength'),
          confidence: unitNumber(options.confidence, '--confidence'),
        },
      };
    case 'fact':
      return {
        ...base,
        structuredData: compact({
          subject: required(options.subject, '--subject'),
          predicate: required(options.predicate, '--predicate'),
          object: required(options.object, '--object'),
          validFrom: options.validFrom,
          validUntil: options.validUntil,
          confidence: unitNumber(options.confidence, '--confidence'),
        }),
      };
    case 'decision':
      return {
        ...base,
        structuredData: compact({
          title: required(options.title, '--title'),
          status: required(options.status, '--status'),
          rationale: [required(options.rationale, '--rationale')],
          supersedes: options.supersedes,
        }),
      };
    default:
      throw new Error('--kind must be policy, preference, fact, or decision.');
  }
}

function scopeFor(options: ScopeOptions): Record<string, unknown> {
  switch (options.scope ?? 'global') {
    case 'global':
      return { level: 'global' };
    case 'domain':
      return { level: 'domain', domain: required(options.domain, '--domain') };
    case 'agent':
      return compact({ level: 'agent', domain: options.domain, agentId: required(options.agent, '--agent') });
    case 'workspace':
      return compact({ level: 'workspace', domain: options.domain, agentId: options.agent, workspace: required(options.workspace, '--workspace') });
    case 'project':
      return compact({
        level: 'project',
        domain: options.domain,
        agentId: options.agent,
        workspace: options.workspace,
        projectId: required(options.project, '--project'),
      });
    case 'task':
      return compact({
        level: 'task',
        domain: options.domain,
        agentId: options.agent,
        workspace: options.workspace,
        projectId: options.project,
        taskId: required(options.taskId, '--task-id'),
      });
    default:
      throw new Error('--scope must be global, domain, agent, workspace, project, or task.');
  }
}

function required(value: string | undefined, option: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${option} is required.`);
  }
  return value;
}

function requiredList(value: string[] | undefined, option: string): string[] {
  if (value === undefined || value.length === 0 || value.some((item) => item.trim() === '')) {
    throw new Error(`${option} is required.`);
  }
  return value;
}

function optionalInteger(value: string | undefined, option: string): number | undefined {
  return value === undefined ? undefined : integer(value, option);
}

function nonNegativeInteger(value: string, option: string): number {
  const parsed = integer(value, option);
  if (parsed < 0) {
    throw new Error(`${option} must be a non-negative integer.`);
  }
  return parsed;
}

function integer(value: string, option: string): number {
  if (value.trim() === '') {
    throw new Error(`${option} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${option} must be an integer.`);
  }
  return parsed;
}

function optionalUnitNumber(value: string | undefined, option: string): number | undefined {
  return value === undefined ? undefined : unitNumber(value, option);
}

function unitNumber(value: string | undefined, option: string): number {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${option} must be a number from 0 to 1.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${option} must be a number from 0 to 1.`);
  }
  return parsed;
}

async function request(url: string, path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
  const endpoint = daemonEndpoint(url, path);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error('daemon request timed out.');
    }
    throw new DaemonConnectionError();
  }

  if (response.ok) {
    try {
      return await response.json();
    } catch {
      throw new Error('daemon returned an invalid response.');
    }
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    result = undefined;
  }
  throw new DaemonResponseError(response.status, daemonErrorCode(result));
}

function daemonEndpoint(value: string, path: string): URL {
  let daemonUrl: URL;
  try {
    daemonUrl = new URL(value);
  } catch {
    throw new Error(DAEMON_URL_ERROR);
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
    throw new Error(DAEMON_URL_ERROR);
  }

  return new URL(path, daemonUrl);
}

function isTimeoutError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'TimeoutError';
}

function daemonErrorCode(result: unknown): string {
  if (typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'string') {
    return result.error;
  }
  return 'request_failed';
}

function printResult(result: unknown, json: boolean, write: Writer, summary: (body: unknown) => string): void {
  write(json ? `${JSON.stringify(result)}\n` : `${summary(result)}\n`);
}

function nestedId(result: unknown, key: string): string | undefined {
  if (typeof result !== 'object' || result === null || !(key in result)) {
    return undefined;
  }
  const nested = (result as Record<string, unknown>)[key];
  return typeof nested === 'object' && nested !== null && 'id' in nested && typeof nested.id === 'string' ? nested.id : undefined;
}

function searchSummary(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('memories' in result) || !Array.isArray(result.memories)) {
    return 'No memories found.';
  }
  if (result.memories.length === 0) {
    return 'No memories found.';
  }
  return result.memories
    .map((memory) => {
      if (typeof memory !== 'object' || memory === null) {
        return 'memory';
      }
      const kind = typeof memory.kind === 'string' ? memory.kind : 'memory';
      const id = typeof memory.id === 'string' ? ` ${memory.id}` : '';
      const text = typeof memory.title === 'string' ? memory.title : typeof memory.canonicalText === 'string' ? memory.canonicalText : '';
      return `${kind}${id}${text === '' ? '' : `: ${text}`}`;
    })
    .join('\n');
}

function contextSummary(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('context' in result) || typeof result.context !== 'object' || result.context === null) {
    return 'Resolved context.';
  }
  const context = result.context as Record<string, unknown>;
  const traceId = typeof context.traceId === 'string' ? ` ${context.traceId}` : '';
  const directiveCount = Array.isArray(context.directives) ? context.directives.length : 0;
  return `Resolved context${traceId}: ${directiveCount} directives.`;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'command failed.';
}

const defaultIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

if (process.argv[1]?.endsWith('index.js')) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
