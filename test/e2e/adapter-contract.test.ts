import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AdapterClient } from '../../packages/adapter-sdk/src/index.js';
import { createAdapterHostCallbacks } from '../../adapters/fixtures/host-events.js';
import { afterEach, describe, expect, test } from 'vitest';

const directories: string[] = [];
const token = 'adapter-contract-token';
const brainId = '00000000-0000-7000-8000-000000000002';
const envelope = {
  clientType: 'contract-host',
  installationId: 'contract-installation',
  profileId: 'default',
  sessionId: 'session-1',
  projectId: 'memlume',
  workspacePath: 'C:/work/memlume',
};

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-adapter-contract-'));
  directories.push(directory);
  return directory;
}

function context(body: { readonly intent: string; readonly scope: unknown; readonly contextBudget: number }) {
  return {
    traceId: '00000000-0000-7000-8000-000000000001',
    intent: body.intent,
    scope: body.scope,
    directives: [],
    procedures: [],
    preferences: [],
    knowledge: [],
    decisions: [],
    explanation: {
      sourceMemoryIds: [],
      exclusions: [],
      budget: { limitUnits: body.contextBudget, usedUnits: 0, included: [], omitted: [], truncated: false },
    },
  };
}

function savedCapture() {
  return {
    capture: {
      memoryId: '00000000-0000-7000-8000-000000000003',
      status: 'active',
      brain: brainId,
      scope: { level: 'project', projectId: 'memlume' },
      requiresConfirmation: false,
      source: { eventId: '00000000-0000-7000-8000-000000000004' },
    },
  };
}

async function resolvesWithin<T>(value: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Expected callback within ${milliseconds}ms.`)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

describe('Adapter compatibility contract', () => {
  test('keeps both shared-brain and adapter-contract suites in the root E2E command', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { readonly scripts: Record<string, string> };

    expect(manifest.scripts['test:e2e']).toContain('apps/daemon/test/shared-brain.e2e.test.ts');
    expect(manifest.scripts['test:e2e']).toContain('test/e2e/adapter-contract.test.ts');
  });

  test('exposes only the three shared callbacks and rejects a subagent callback before initialization', () => {
    const callbacks = createAdapterHostCallbacks(new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxDirectory: temporaryDirectory(),
      fetch: async () => new Response(),
    }));

    expect(Object.keys(callbacks).sort()).toEqual(['beforeTask', 'initialize', 'onSubagentStart', 'onUserMessage']);
    expect(() => callbacks.onSubagentStart({
      intent: 'implementation',
      scope: { level: 'project', projectId: 'memlume' },
      task: 'Start a child task.',
      contextBudget: 120,
      parentTaskId: 'parent-task',
    })).toThrow('Adapter callback must be initialized before receiving events.');
  });

  test('allows a new session only for the initialized adapter identity', () => {
    const callbacks = createAdapterHostCallbacks(new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxDirectory: temporaryDirectory(),
      fetch: async () => new Response(),
    }));
    callbacks.initialize({ envelope });

    expect(() => callbacks.initialize({ envelope: { ...envelope, sessionId: 'session-2' } })).not.toThrow();
    expect(() => callbacks.initialize({ envelope: { ...envelope, clientType: 'other-host' } })).toThrow('Adapter identity cannot change after initialization.');
    expect(() => callbacks.initialize({ envelope: { ...envelope, installationId: 'other-installation' } })).toThrow('Adapter identity cannot change after initialization.');
    expect(() => callbacks.initialize({ envelope: { ...envelope, profileId: 'other-profile' } })).toThrow('Adapter identity cannot change after initialization.');
  });

  test('fails open without waiting for a hung outbox retry or context read', async () => {
    const outboxPath = join(temporaryDirectory(), 'outbox.jsonl');
    const unavailable = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: async () => new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }),
    });
    await unavailable.onUserMessage(envelope, { messageId: 'pending-1', content: 'Remember this project uses Vue.', brainId });

    const hung = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxPath,
      fetch: async () => new Promise<Response>(() => {}),
    });
    const callbacks = createAdapterHostCallbacks(hung);
    callbacks.initialize({ envelope });

    await expect(resolvesWithin(callbacks.beforeTask({
      intent: 'implementation',
      scope: { level: 'project', projectId: 'memlume' },
      task: 'Continue while Memlume is unavailable.',
      contextBudget: 120,
    }), 500)).resolves.toMatchObject({ directives: [], explanation: { budget: { limitUnits: 120 } } });
  });

  test('uses one initialized envelope across task, user, and subagent callbacks', async () => {
    const calls: Array<{ readonly path: string; readonly body: Record<string, unknown> }> = [];
    const client = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxDirectory: temporaryDirectory(),
      fetch: async (input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const path = new URL(String(input)).pathname;
        calls.push({ path, body });
        if (path === '/v1/context/resolve') {
          return new Response(JSON.stringify(context(body as { intent: string; scope: unknown; contextBudget: number })), { status: 200 });
        }
        if (path === '/v1/memories/capture') {
          return new Response(JSON.stringify(savedCapture()), { status: 201 });
        }
        return new Response(JSON.stringify({ event: { id: 'event-id', brainId } }), { status: 201 });
      },
    });
    const callbacks = createAdapterHostCallbacks(client);
    callbacks.initialize({ envelope });

    await expect(callbacks.beforeTask({
      intent: 'implementation',
      scope: { level: 'project', projectId: 'memlume' },
      task: 'Add one adapter.',
      contextBudget: 120,
      requestedBrainIds: [brainId],
    })).resolves.toMatchObject({ intent: 'implementation', directives: [] });
    await expect(callbacks.onUserMessage({ messageId: 'user-1', content: 'Remember this project uses Vue.', brainId })).resolves.toEqual({
      status: 'saved',
      memoryStatus: 'active',
    });
    await expect(callbacks.onSubagentStart({
      intent: 'implementation',
      scope: { level: 'project', projectId: 'memlume' },
      task: 'Implement the adapter child task.',
      contextBudget: 80,
      requestedBrainIds: [brainId],
      parentTaskId: 'task-1',
      subagentId: 'child-1',
    })).resolves.toMatchObject({ intent: 'implementation', directives: [] });

    expect(calls.map(({ path }) => path)).toEqual(['/v1/context/resolve', '/v1/memories/capture', '/v1/context/resolve']);
    expect((calls[1].body.structuredData as { readonly envelope: unknown }).envelope).toEqual(envelope);
    expect(calls[0].body).toMatchObject({ requestedBrainIds: [brainId] });
    expect(calls[2].body).toMatchObject({ requestedBrainIds: [brainId] });
    expect(calls[2].body).not.toHaveProperty('parentTaskId');
    expect(calls[2].body).not.toHaveProperty('subagentId');
    expect(calls[2].body).not.toHaveProperty('envelope');
  });

  test('fails open when context read is unavailable', async () => {
    const warnings: string[] = [];
    const client = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxDirectory: temporaryDirectory(),
      fetch: async () => { throw new Error('daemon offline'); },
      warn: (message) => warnings.push(message),
    });
    const callbacks = createAdapterHostCallbacks(client);
    callbacks.initialize({ envelope });

    await expect(callbacks.beforeTask({
      intent: 'implementation',
      scope: { level: 'project', projectId: 'memlume' },
      task: null,
      contextBudget: 120,
    })).resolves.toMatchObject({ directives: [], explanation: { budget: { limitUnits: 120 } } });
    expect(warnings).toEqual(['Memlume context unavailable; continuing without shared context.']);
  });

  test('reports queued work truthfully and retries it at the next task callback', async () => {
    let captures = 0;
    const client = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxDirectory: temporaryDirectory(),
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/memories/capture') {
          captures += 1;
          return captures === 1
            ? new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 })
            : new Response(JSON.stringify(savedCapture()), { status: 201 });
        }
        return new Response(JSON.stringify({ context: context({
          intent: 'implementation',
          scope: { level: 'project', projectId: 'memlume' },
          contextBudget: 120,
        }) }), { status: 200 });
      },
    });
    const callbacks = createAdapterHostCallbacks(client);
    callbacks.initialize({ envelope });

    await expect(callbacks.onUserMessage({ messageId: 'retry-1', content: 'Remember this project uses Vue.', brainId })).resolves.toEqual({ status: 'queued' });
    await expect(callbacks.beforeTask({
      intent: 'implementation',
      scope: { level: 'project', projectId: 'memlume' },
      task: 'Retry pending work.',
      contextBudget: 120,
    })).resolves.toMatchObject({ intent: 'implementation' });
    await expect(client.outboxStatus()).resolves.toEqual({ state: 'empty', pending: 0, retry: 0, discarded: 0 });
  });

  test('reports a denied mount as rejected without claiming a saved memory', async () => {
    const client = new AdapterClient({
      daemonUrl: 'http://127.0.0.1:3849',
      token,
      outboxDirectory: temporaryDirectory(),
      fetch: async () => new Response(JSON.stringify({ error: 'mount_denied' }), { status: 403 }),
    });
    const callbacks = createAdapterHostCallbacks(client);
    callbacks.initialize({ envelope });

    await expect(callbacks.onUserMessage({ messageId: 'denied-1', content: 'Remember this must not be written.', brainId })).resolves.toEqual({ status: 'rejected' });
  });
});
