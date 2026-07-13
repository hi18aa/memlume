import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AdapterClient } from '../../../packages/adapter-sdk/src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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

async function createBrain(daemon: RunningDaemon): Promise<string> {
  const result = await requestJson(daemon, '/v1/setup/brains', {
    method: 'POST',
    headers: setupHeaders(),
    body: JSON.stringify({ kind: 'project', name: 'Shared project' }),
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

function invokeHermesBridge(daemon: RunningDaemon, token: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HERMES_BRIDGE], {
      env: { ...process.env, MEMLUME_DAEMON_URL: daemonUrl(daemon), MEMLUME_TOKEN: token },
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

async function rememberThroughMcp(daemon: RunningDaemon, token: string, brainId: string): Promise<unknown> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'memlume-shared-brain-e2e', version: '0.1.0' });
  const server = createMcpServer({ daemonUrl: daemonUrl(daemon), token });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await client.callTool({
      name: 'memlume.remember',
      arguments: {
        brainId,
        kind: 'policy',
        canonicalText: 'Use pnpm for this shared project.',
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

afterEach(async () => {
  while (daemons.length > 0) {
    await daemons.pop()!.stop();
  }
  while (directories.length > 0) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

describe('shared brain adapter end-to-end flow', () => {
  test('shares a mounted project brain with another adapter but keeps an unmounted adapter isolated', async () => {
    const { daemon } = await start();
    const brainId = await createBrain(daemon);
    const hermes = await registerAdapter(daemon, 'hermes', 'hermes-desktop');
    const codex = await registerAdapter(daemon, 'codex', 'codex-cli');
    const claude = await registerAdapter(daemon, 'claude-code', 'claude-code');
    await mount(daemon, hermes.id, brainId, 'read_write');
    await mount(daemon, codex.id, brainId, 'read');

    await expect(rememberThroughMcp(daemon, hermes.token, brainId)).resolves.toMatchObject({
      structuredContent: { status: 'saved', sourceBrainId: brainId },
    });

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
