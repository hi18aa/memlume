import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AdapterClient } from '../../../packages/adapter-sdk/src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createUuidV7 } from '@memlume/contracts';
import { openDatabase } from '@memlume/database/internal';
import { afterEach, describe, expect, test } from 'vitest';

import { createMcpServer } from '../../mcp-server/src/index.js';
import { startDaemon, type RunningDaemon } from '../src/index.js';

const SETUP_TOKEN = 'setup-token-for-shared-brain-e2e';
const HERMES_BRIDGE = fileURLToPath(new URL('../../../adapters/hermes/bridge.mjs', import.meta.url));
const directories: string[] = [];
const daemons: RunningDaemon[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-shared-brain-e2e-'));
  directories.push(directory);
  return directory;
}

async function start(): Promise<{ readonly daemon: RunningDaemon; readonly databasePath: string }> {
  const databasePath = join(temporaryDirectory(), 'memlume.sqlite');
  const daemon = await startDaemon({ databasePath, port: 0, setupToken: SETUP_TOKEN });
  daemons.push(daemon);
  return { daemon, databasePath };
}

function daemonUrl(daemon: RunningDaemon): string {
  return `http://127.0.0.1:${daemon.address.port}`;
}

function setupHeaders(): HeadersInit {
  return { 'content-type': 'application/json', 'x-memlume-setup-token': SETUP_TOKEN };
}

async function requestJson(
  daemon: RunningDaemon,
  path: string,
  init?: RequestInit,
): Promise<{ readonly response: Response; readonly body: Record<string, unknown> }> {
  const response = await fetch(`${daemonUrl(daemon)}${path}`, init);
  return { response, body: (await response.json()) as Record<string, unknown> };
}

async function createBrain(
  daemon: RunningDaemon,
  kind: 'personal' | 'project' | 'domain' = 'project',
  name = 'Shared project',
): Promise<string> {
  const result = await requestJson(daemon, '/v1/setup/brains', {
    method: 'POST',
    headers: setupHeaders(),
    body: JSON.stringify({ kind, name }),
  });
  expect(result.response.status).toBe(201);
  return (result.body.brain as { readonly id: string }).id;
}

async function registerAdapter(
  daemon: RunningDaemon,
  clientType: string,
  installationId: string,
): Promise<{ readonly id: string; readonly token: string }> {
  const result = await requestJson(daemon, '/v1/setup/installations', {
    method: 'POST',
    headers: setupHeaders(),
    body: JSON.stringify({ clientType, installationId, profileId: 'default' }),
  });
  expect(result.response.status).toBe(201);
  return {
    id: (result.body.installation as { readonly id: string }).id,
    token: result.body.token as string,
  };
}

async function mount(daemon: RunningDaemon, agentInstallationId: string, brainId: string, access: 'read' | 'read_write'): Promise<void> {
  const result = await requestJson(daemon, '/v1/setup/mounts', {
    method: 'POST',
    headers: setupHeaders(),
    body: JSON.stringify({ agentInstallationId, brainId, access }),
  });
  expect(result.response.status).toBe(201);
}

function envelope(clientType: string, installationId: string) {
  return { clientType, installationId, profileId: 'default', sessionId: 'shared-session', projectId: 'memlume' };
}

function resolveContext(daemon: RunningDaemon, token: string, requestedBrainIds?: readonly string[]) {
  return requestJson(daemon, '/v1/context/resolve', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      intent: 'implementation',
      scope: { level: 'project', projectId: 'memlume' },
      task: null,
      contextBudget: 100,
      ...(requestedBrainIds === undefined ? {} : { requestedBrainIds }),
    }),
  });
}

function invokeHermesBridge(daemon: RunningDaemon, token: string, payload: unknown, outboxDirectory?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HERMES_BRIDGE], {
      env: {
        ...process.env,
        MEMLUME_DAEMON_URL: daemonUrl(daemon),
        MEMLUME_TOKEN: token,
        ...(outboxDirectory === undefined ? {} : { MEMLUME_OUTBOX_DIRECTORY: outboxDirectory }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stderr!.setEncoding('utf8').on('data', (chunk) => { errors += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(errors || `Hermes bridge exited with ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(output) as unknown);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin!.end(`${JSON.stringify(payload)}\n`);
  });
}

function defaultOutboxLockPath(source: ReturnType<typeof envelope>, outboxDirectory: string): string {
  const identity = JSON.stringify([source.clientType, source.installationId, source.profileId]);
  return join(outboxDirectory, 'outbox', `${createHash('sha256').update(identity).digest('hex')}.jsonl.lock`);
}

async function rememberThroughMcp(daemon: RunningDaemon, token: string, brainId: string, canonicalText = 'Use pnpm for this shared project.'): Promise<unknown> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'memlume-shared-brain-e2e', version: '0.2.0' });
  const server = createMcpServer({ daemonUrl: daemonUrl(daemon), token });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await client.callTool({
      name: 'memlume.remember',
      arguments: {
        brainId,
        kind: 'policy',
        canonicalText,
        structuredData: {
          trigger: { intents: ['implementation'] },
          action: { type: 'apply_process', target: 'pnpm' },
          constraints: {},
        },
        scope: { level: 'project', projectId: 'memlume' },
      },
    });
  } finally {
    await client.close();
    await server.close();
  }
}

async function approveCandidate(daemon: RunningDaemon, memoryId: string): Promise<void> {
  const result = await requestJson(daemon, `/v1/setup/inbox/${memoryId}/approve`, {
    method: 'POST',
    headers: setupHeaders(),
    body: JSON.stringify({ reason: 'Approved for the shared-brain flow.' }),
  });
  expect(result.response.status).toBe(200);
  expect(result.body).toMatchObject({ memory: { id: memoryId, status: 'active' } });
}

afterEach(async () => {
  while (daemons.length > 0) {
    await daemons.pop()!.stop();
  }
  while (directories.length > 0) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

describe('shared brain adapter end-to-end flow', () => {
  test('resolves default brain priority and exposes only the ordered requested brain subset', async () => {
    const { daemon, databasePath } = await start();
    const projectBrainId = await createBrain(daemon, 'project', 'Project');
    const domainBrainId = await createBrain(daemon, 'domain', 'Company');
    const personalBrainId = await createBrain(daemon, 'personal', 'Personal');
    const adapter = await registerAdapter(daemon, 'codex', 'brain-routing');
    await mount(daemon, adapter.id, personalBrainId, 'read_write');
    await mount(daemon, adapter.id, domainBrainId, 'read_write');
    await mount(daemon, adapter.id, projectBrainId, 'read_write');

    const projectText = 'Use the project directive.';
    const domainText = 'Use the domain directive.';
    const personalText = 'Use the personal directive.';
    const projectRemembered = await rememberThroughMcp(daemon, adapter.token, projectBrainId, projectText);
    const domainRemembered = await rememberThroughMcp(daemon, adapter.token, domainBrainId, domainText);
    const personalRemembered = await rememberThroughMcp(daemon, adapter.token, personalBrainId, personalText);
    const projectMemoryId = (projectRemembered as { readonly structuredContent: { readonly memory: { readonly id: string } } }).structuredContent.memory.id;
    const domainMemoryId = (domainRemembered as { readonly structuredContent: { readonly memory: { readonly id: string } } }).structuredContent.memory.id;
    const personalMemoryId = (personalRemembered as { readonly structuredContent: { readonly memory: { readonly id: string } } }).structuredContent.memory.id;
    await approveCandidate(daemon, projectMemoryId);
    await approveCandidate(daemon, domainMemoryId);
    await approveCandidate(daemon, personalMemoryId);

    const defaultContext = await resolveContext(daemon, adapter.token);
    const requestedContext = await resolveContext(daemon, adapter.token, [domainBrainId, projectBrainId, domainBrainId]);

    expect(defaultContext.response.status).toBe(200);
    expect(requestedContext.response.status).toBe(200);
    expect(
      (defaultContext.body.context as { readonly directives: readonly { readonly brainId: string; readonly text: string }[] }).directives
        .map(({ brainId, text }) => ({ brainId, text })),
    ).toEqual([
      { brainId: projectBrainId, text: projectText },
      { brainId: domainBrainId, text: domainText },
      { brainId: personalBrainId, text: personalText },
    ]);
    expect(
      (requestedContext.body.context as { readonly directives: readonly { readonly brainId: string; readonly text: string }[] }).directives
        .map(({ brainId, text }) => ({ brainId, text })),
    ).toEqual([
      { brainId: domainBrainId, text: domainText },
      { brainId: projectBrainId, text: projectText },
    ]);
    const defaultTraceId = (defaultContext.body.context as { readonly traceId: string }).traceId;
    const requestedTraceId = (requestedContext.body.context as { readonly traceId: string }).traceId;

    await daemon.stop();
    const database = openDatabase(databasePath);
    try {
      const defaultReceipt = database
        .prepare('SELECT brain_ids FROM context_receipts WHERE trace_id = ?')
        .get(defaultTraceId) as { readonly brain_ids: string };
      const requestedReceipt = database
        .prepare('SELECT brain_ids FROM context_receipts WHERE trace_id = ?')
        .get(requestedTraceId) as { readonly brain_ids: string };
      expect(JSON.parse(defaultReceipt.brain_ids)).toEqual([projectBrainId, domainBrainId, personalBrainId]);
      expect(JSON.parse(requestedReceipt.brain_ids)).toEqual([domainBrainId, projectBrainId]);
    } finally {
      database.close();
    }
  });

  test('rejects a requested subset that includes an unmounted brain without issuing a receipt', async () => {
    const { daemon, databasePath } = await start();
    const mountedBrainId = await createBrain(daemon, 'project', 'Mounted');
    const unmountedBrainId = await createBrain(daemon, 'domain', 'Unmounted');
    const adapter = await registerAdapter(daemon, 'codex', 'restricted-routing');
    await mount(daemon, adapter.id, mountedBrainId, 'read');

    const context = await resolveContext(daemon, adapter.token, [mountedBrainId, unmountedBrainId]);

    expect(context.response.status).toBe(403);
    expect(context.body).toEqual({ error: 'forbidden' });
    await daemon.stop();
    const database = openDatabase(databasePath);
    try {
      expect(database.prepare('SELECT COUNT(*) AS count FROM context_receipts').get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  test('routes an unmounted requested brain collection to access control', async () => {
    const { daemon } = await start();
    const adapter = await registerAdapter(daemon, 'codex', 'unbounded-routing');

    const context = await resolveContext(daemon, adapter.token, Array.from({ length: 65 }, () => createUuidV7()));

    expect(context.response.status).toBe(403);
    expect(context.body).toEqual({ error: 'forbidden' });
  });

  test('rejects an empty requested brain collection without issuing a receipt', async () => {
    const { daemon, databasePath } = await start();
    const brainId = await createBrain(daemon, 'project', 'Mounted');
    const adapter = await registerAdapter(daemon, 'codex', 'empty-routing');
    await mount(daemon, adapter.id, brainId, 'read');

    const context = await resolveContext(daemon, adapter.token, []);

    expect(context.response.status).toBe(400);
    await daemon.stop();
    const database = openDatabase(databasePath);
    try {
      expect(database.prepare('SELECT COUNT(*) AS count FROM context_receipts').get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  test('shares a mounted project brain with another adapter but keeps an unmounted adapter isolated', async () => {
    const { daemon } = await start();
    const brainId = await createBrain(daemon);
    const hermes = await registerAdapter(daemon, 'hermes', 'hermes-desktop');
    const codex = await registerAdapter(daemon, 'codex', 'codex-cli');
    const claude = await registerAdapter(daemon, 'claude-code', 'claude-code');
    await mount(daemon, hermes.id, brainId, 'read_write');
    await mount(daemon, codex.id, brainId, 'read');

    const remembered = await rememberThroughMcp(daemon, hermes.token, brainId);
    expect(remembered).toMatchObject({ structuredContent: { status: 'candidate', sourceBrainId: brainId } });
    const rememberedBody = (remembered as { readonly structuredContent: { readonly memory: { readonly id: string } } }).structuredContent;
    await approveCandidate(daemon, rememberedBody.memory.id);

    const hermesClient = new AdapterClient({ daemonUrl: daemonUrl(daemon), token: hermes.token, outboxDirectory: temporaryDirectory() });
    const hermesContext = await hermesClient.beforeTask({
      envelope: envelope('hermes', 'hermes-desktop'),
      intent: 'implementation',
      scope: { level: 'project', projectId: 'memlume' },
      task: null,
      contextBudget: 100,
    });

    const usage = await requestJson(daemon, `/v1/memories/${rememberedBody.memory.id}/usage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hermes.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ traceId: hermesContext.traceId, taskId: 'shared-task', retrievalRank: 1, wasIncluded: true, outcome: 'adopted' }),
    });
    expect(usage.response.status).toBe(201);
    const outcome = await requestJson(daemon, '/v1/outcomes', {
      method: 'POST',
      headers: { authorization: `Bearer ${hermes.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ traceId: hermesContext.traceId, result: 'success', taskId: 'shared-task', usedMemoryIds: [rememberedBody.memory.id], usedToolIds: ['terminal'] }),
    });
    expect(outcome.response.status).toBe(201);

    const codexClient = new AdapterClient({ daemonUrl: daemonUrl(daemon), token: codex.token, outboxDirectory: temporaryDirectory() });
    const sharedContext = await codexClient.beforeTask({
      envelope: envelope('codex', 'codex-cli'),
      intent: 'implementation',
      scope: { level: 'project', projectId: 'memlume' },
      task: null,
      contextBudget: 100,
    });
    expect(sharedContext.directives.map(({ text }) => text)).toEqual(['Use pnpm for this shared project.']);

    const isolatedClient = new AdapterClient({ daemonUrl: daemonUrl(daemon), token: claude.token, outboxDirectory: temporaryDirectory() });
    const isolatedDirectContext = await requestJson(daemon, '/v1/context/resolve', {
      method: 'POST',
      headers: { authorization: `Bearer ${claude.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'implementation', scope: { level: 'project', projectId: 'memlume' }, task: null, contextBudget: 100 }),
    });
    expect(isolatedDirectContext.response.status).toBe(403);
    expect(isolatedDirectContext.body).toEqual({ error: 'forbidden' });
    const isolatedContext = await isolatedClient.beforeTask({
      envelope: envelope('claude-code', 'claude-code'),
      intent: 'implementation',
      scope: { level: 'project', projectId: 'memlume' },
      task: null,
      contextBudget: 100,
    });
    expect(isolatedContext.explanation.sourceMemoryIds).toEqual([]);
    expect(isolatedContext.directives).toEqual([]);

    await expect(
      isolatedClient.onUserMessage(envelope('claude-code', 'claude-code'), {
        brainId,
        messageId: 'isolated-write',
        content: 'This must not enter the shared project brain.',
      }),
    ).resolves.toEqual({ status: 'rejected' });
  });

  test('deduplicates retried governed SDK captures in their mounted brain', async () => {
    const { daemon, databasePath } = await start();
    const brainId = await createBrain(daemon);
    const hermes = await registerAdapter(daemon, 'hermes', 'hermes-desktop');
    await mount(daemon, hermes.id, brainId, 'read_write');
    const client = new AdapterClient({ daemonUrl: daemonUrl(daemon), token: hermes.token, outboxDirectory: temporaryDirectory() });
    const source = envelope('hermes', 'hermes-desktop');
    const message = { brainId, messageId: 'retry-once', content: 'Remember this project uses pnpm.' };

    await expect(client.onUserMessage(source, message)).resolves.toEqual({ status: 'saved', memoryStatus: 'active' });
    await expect(client.onUserMessage(source, message)).resolves.toEqual({ status: 'saved', memoryStatus: 'active' });

    await daemon.stop();
    const database = openDatabase(databasePath);
    try {
      const result = database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM events AS event
             INNER JOIN event_brains AS event_brain ON event_brain.event_id = event.id
             WHERE event_brain.brain_id = ? AND event.source_reference = ?`,
        )
        .get(brainId, JSON.stringify(['hermes', 'hermes-desktop', 'default', 'shared-session', 'retry-once'])) as { readonly count: number };
      expect(result.count).toBe(1);
      const memories = database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM memory_items AS memory
             INNER JOIN memory_brains AS memory_brain ON memory_brain.memory_id = memory.id
             WHERE memory_brain.brain_id = ? AND memory.status = 'active'`,
        )
        .get(brainId) as { readonly count: number };
      expect(memories.count).toBe(1);
    } finally {
      database.close();
    }
  });

  test('accepts a mounted Hermes bridge capture and rejects the same bridge without write access', async () => {
    const { daemon } = await start();
    const brainId = await createBrain(daemon);
    const hermes = await registerAdapter(daemon, 'hermes', 'hermes-plugin');
    const reader = await registerAdapter(daemon, 'codex', 'hermes-reader');
    const readOnlyHermes = await registerAdapter(daemon, 'hermes', 'hermes-read-only');
    await mount(daemon, hermes.id, brainId, 'read_write');
    await mount(daemon, reader.id, brainId, 'read');
    await mount(daemon, readOnlyHermes.id, brainId, 'read');

    const message = {
      brainId,
      messageId: 'hermes-pnpm',
      content: '記住專案使用 pnpm',
      scope: { level: 'project' as const, projectId: 'memlume' },
    };
    await expect(invokeHermesBridge(daemon, hermes.token, {
      operation: 'onUserMessage',
      envelope: envelope('hermes', 'hermes-plugin'),
      message,
    })).resolves.toEqual({ ok: true, result: { status: 'saved', memoryStatus: 'active' } });

    const readerClient = new AdapterClient({ daemonUrl: daemonUrl(daemon), token: reader.token, outboxDirectory: temporaryDirectory() });
    await expect(readerClient.beforeTask({
      envelope: envelope('codex', 'hermes-reader'),
      intent: 'implementation',
      scope: message.scope,
      task: 'pnpm',
      contextBudget: 100,
    })).resolves.toMatchObject({ knowledge: [{ brainId, summary: '專案使用 pnpm' }] });

    await expect(invokeHermesBridge(daemon, readOnlyHermes.token, {
      operation: 'onUserMessage',
      envelope: envelope('hermes', 'hermes-read-only'),
      message: { ...message, messageId: 'hermes-denied' },
    })).resolves.toEqual({ ok: true, result: { status: 'rejected' } });
  });

  test('flushes a queued Hermes bridge capture after a daemon restart without leaving an outbox lock', async () => {
    const { daemon, databasePath } = await start();
    const brainId = await createBrain(daemon);
    const hermes = await registerAdapter(daemon, 'hermes', 'hermes-offline-bridge');
    await mount(daemon, hermes.id, brainId, 'read_write');
    const source = envelope('hermes', 'hermes-offline-bridge');
    const outboxDirectory = temporaryDirectory();
    const lockPath = defaultOutboxLockPath(source, outboxDirectory);
    const message = {
      brainId,
      messageId: 'hermes-offline-pnpm',
      content: '記住專案使用 pnpm',
      scope: { level: 'project' as const, projectId: 'memlume' },
    };

    await daemon.stop();
    await expect(invokeHermesBridge(daemon, hermes.token, {
      operation: 'onUserMessage',
      envelope: source,
      message,
    }, outboxDirectory)).resolves.toEqual({ ok: true, result: { status: 'queued' } });
    expect(existsSync(lockPath)).toBe(false);

    const restarted = await startDaemon({ databasePath, port: daemon.address.port, setupToken: SETUP_TOKEN });
    daemons.push(restarted);
    await expect(invokeHermesBridge(restarted, hermes.token, {
      operation: 'onSessionEnd',
      envelope: source,
    }, outboxDirectory)).resolves.toEqual({ ok: true, result: [{ status: 'saved', memoryStatus: 'active' }] });
    expect(existsSync(lockPath)).toBe(false);

    const reader = new AdapterClient({ daemonUrl: daemonUrl(restarted), token: hermes.token, outboxDirectory: temporaryDirectory() });
    await expect(reader.beforeTask({
      envelope: source,
      intent: 'implementation',
      scope: message.scope,
      task: 'pnpm',
      contextBudget: 100,
    })).resolves.toMatchObject({ knowledge: [{ brainId, summary: '專案使用 pnpm' }] });
  });

  test('continues without shared context then resends a queued capture after daemon restart', async () => {
    const { daemon, databasePath } = await start();
    const brainId = await createBrain(daemon);
    const codex = await registerAdapter(daemon, 'codex', 'offline-codex');
    await mount(daemon, codex.id, brainId, 'read_write');
    const warnings: string[] = [];
    const outboxPath = join(temporaryDirectory(), 'offline.jsonl');
    await daemon.stop();
    const client = new AdapterClient({
      daemonUrl: daemonUrl(daemon),
      token: codex.token,
      outboxPath,
      warn: (message) => warnings.push(message),
    });
    const source = envelope('codex', 'offline-codex');

    await expect(
      client.beforeTask({
        envelope: source,
        intent: 'implementation',
        scope: { level: 'project', projectId: 'memlume' },
        task: 'Continue safely.',
        contextBudget: 42,
      }),
    ).resolves.toMatchObject({
      intent: 'implementation',
      directives: [],
      explanation: { sourceMemoryIds: [], budget: { limitUnits: 42 } },
    });
    await expect(
      client.onUserMessage(source, { brainId, messageId: 'offline-message', content: 'Remember this project uses pnpm.' }),
    ).resolves.toEqual({ status: 'queued' });
    expect(warnings).toEqual(['Memlume context unavailable; continuing without shared context.']);
    expect(readFileSync(outboxPath, 'utf8')).toContain('Remember this project uses pnpm.');
    await expect(client.outboxStatus()).resolves.toEqual({ state: 'pending', pending: 1, retry: 0, discarded: 0 });

    const restarted = await startDaemon({ databasePath, port: 0, setupToken: SETUP_TOKEN });
    daemons.push(restarted);
    const retrying = new AdapterClient({ daemonUrl: daemonUrl(restarted), token: codex.token, outboxPath });
    await expect(retrying.onSessionEnd()).resolves.toEqual([{ status: 'saved', memoryStatus: 'active' }]);
    await expect(retrying.outboxStatus()).resolves.toEqual({ state: 'empty', pending: 0, retry: 0, discarded: 0 });
  });
});
