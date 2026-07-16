import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const request = JSON.parse(raw.trim());
  const root = process.env.MEMLUME_HOME ?? fileURLToPath(new URL('../..', import.meta.url));
  const safeRoot = await realpath(root);
  const entry = await realpath(resolve(safeRoot, 'packages', 'adapter-sdk', 'dist', 'index.js'));
  if (!isInside(safeRoot, entry)) throw new Error('Memlume Core is unavailable.');
  const { AdapterClient } = await import(pathToFileURL(entry).href);
  const defaultWriteBrainId = validBrainId(process.env.MEMLUME_BRAIN_ID);
  const client = new AdapterClient({
    daemonUrl: process.env.MEMLUME_DAEMON_URL ?? 'http://127.0.0.1:3849',
    token: process.env.MEMLUME_TOKEN,
    ...(defaultWriteBrainId === undefined ? {} : { defaultWriteBrainId }),
    ...(process.env.MEMLUME_OUTBOX_DIRECTORY ? { outboxDirectory: process.env.MEMLUME_OUTBOX_DIRECTORY } : {}),
    warn: () => undefined,
  });
  const result = await invoke(client, request);
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch {
  // Never reflect request data, token, or daemon errors through the bridge protocol.
  process.stdout.write('{"ok":false}\n');
  process.exitCode = 1;
}

async function invoke(client, request) {
  switch (request?.operation) {
    case 'beforeTask':
      return client.beforeTask(request.input);
    case 'onUserMessage':
      return client.onUserMessage(request.envelope, request.message);
    case 'onSubagentStart':
      return client.onSubagentStart(request.input);
    case 'recordAssistantFinal':
      return client.recordAssistantFinal(request.envelope, request.input);
    default:
      throw new Error('Unsupported bridge operation.');
  }
}

function validBrainId(value) {
  return typeof value === 'string' && uuidV7.test(value.trim()) ? value.trim() : undefined;
}

function isInside(root, file) {
  const path = relative(root, file);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
