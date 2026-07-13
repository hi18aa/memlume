import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const WRITE_TIMEOUT_MS = 250;
const CONTEXT_BUDGET = 320;
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

void run();

async function run() {
  let output = {};
  try {
    const input = await readInput();
    output = await handle(input);
  } catch {
    output = {};
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function handle(input) {
  if (!isRecord(input)) return {};
  const configuration = envelopeFor(input);
  if (configuration === undefined) return {};

  if (input.hook_event_name === 'SessionStart') {
    await createClient();
    return {};
  }
  if (input.hook_event_name === 'UserPromptSubmit') return beforePrompt(input, configuration);
  if (input.hook_event_name === 'Stop') return afterTurn(input, configuration);
  return {};
}

async function beforePrompt(input, configuration) {
  const prompt = text(input.prompt);
  const turnId = text(input.turn_id);
  if (prompt === undefined || turnId === undefined) return {};
  const client = await createClient();
  const [context] = await Promise.all([
    client.beforeTask({
      envelope: configuration.envelope,
      intent: 'shared_memory',
      scope: configuration.scope,
      task: prompt,
      contextBudget: CONTEXT_BUDGET,
    }),
    client.onUserMessage(configuration.envelope, {
      messageId: `codex:${configuration.envelope.sessionId}:${turnId}`,
      content: prompt,
      brainId: configuration.brainId,
      scope: configuration.scope,
    }),
  ]);
  const additionalContext = compactContext(context);
  return additionalContext === undefined
    ? {}
    : { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } };
}

async function afterTurn(input, configuration) {
  const turnId = text(input.turn_id);
  const message = text(input.last_assistant_message);
  if (turnId === undefined || message === undefined) return {};
  const client = await createClient();
  await client.afterTask(configuration.envelope, {
    messageId: `codex:${configuration.envelope.sessionId}:${turnId}:assistant`,
    content: message,
    brainId: configuration.brainId,
  });
  return {};
}

function envelopeFor(input) {
  const sessionId = text(input.session_id);
  const installationId = environmentText('MEMLUME_INSTALLATION_ID');
  const profileId = environmentText('MEMLUME_PROFILE_ID');
  const projectId = environmentText('MEMLUME_PROJECT_ID');
  const brainId = environmentText('MEMLUME_BRAIN_ID');
  if (sessionId === undefined || installationId === undefined || profileId === undefined || projectId === undefined || brainId === undefined || !uuidV7.test(brainId)) return undefined;
  const workspacePath = text(input.cwd) ?? environmentText('MEMLUME_WORKSPACE_PATH');
  const envelope = {
    clientType: 'codex',
    installationId,
    profileId,
    sessionId,
    projectId,
    ...(workspacePath === undefined ? {} : { workspacePath }),
  };
  return { envelope, brainId, scope: { level: 'project', projectId } };
}

async function createClient() {
  const { AdapterClient } = await loadAdapterSdk();
  const directory = outboxDirectory();
  return new AdapterClient({
    daemonUrl: process.env.MEMLUME_DAEMON_URL ?? 'http://127.0.0.1:3849',
    token: process.env.MEMLUME_TOKEN,
    ...(directory === undefined ? {} : { outboxDirectory: directory }),
    writeTimeoutMs: WRITE_TIMEOUT_MS,
    warn: () => undefined,
  });
}

async function loadAdapterSdk() {
  const root = environmentText('MEMLUME_HOME');
  if (root === undefined) throw new Error('Memlume Core is unavailable.');
  const safeRoot = await realpath(root);
  const entry = await realpath(resolve(safeRoot, 'packages', 'adapter-sdk', 'dist', 'index.js'));
  if (!isInside(safeRoot, entry)) throw new Error('Memlume Core is unavailable.');
  const module = await import(pathToFileURL(entry).href);
  if (typeof module.AdapterClient !== 'function') throw new Error('Memlume Core is unavailable.');
  return module;
}

function compactContext(context) {
  if (!isRecord(context)) return undefined;
  const lines = [];
  for (const key of ['directives', 'preferences', 'decisions']) collectText(lines, context[key], 'text');
  collectText(lines, context.knowledge, 'summary');
  for (const procedure of array(context.procedures)) collectText(lines, isRecord(procedure) ? procedure.steps : undefined, undefined);
  const content = lines.slice(0, 8).join('\n');
  return content === '' ? undefined : `Memlume shared context:\n${content.slice(0, 1200)}`;
}

function collectText(lines, values, key) {
  for (const value of array(values)) {
    const candidate = key === undefined ? text(value) : isRecord(value) ? text(value[key]) : undefined;
    if (candidate !== undefined) lines.push(`- ${candidate}`);
  }
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function outboxDirectory() {
  return environmentText('MEMLUME_OUTBOX_DIRECTORY') ?? environmentText('PLUGIN_DATA');
}

function environmentText(name) {
  return text(process.env[name]);
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readInput() {
  let source = '';
  for await (const chunk of process.stdin) source += chunk;
  return JSON.parse(source);
}

function isInside(root, file) {
  const path = relative(root, file);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
