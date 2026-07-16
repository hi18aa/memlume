import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PERSONAL_BRAIN_ID } from '@memlume/contracts';
import { afterEach, describe, expect, test } from 'vitest';

import { startDaemon, type RunningDaemon } from '../src/index.js';

const setupToken = 'automatic-capture-setup-token';
const roots: string[] = [];
const daemons: RunningDaemon[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'memlume-automatic-capture-'));
  roots.push(value);
  return value;
}

function url(daemon: RunningDaemon): string {
  return `http://127.0.0.1:${daemon.address.port}`;
}

async function json(daemon: RunningDaemon, path: string, init: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${url(daemon)}${path}`, init);
  return { response, body: await response.json() };
}

function setupHeaders(): HeadersInit {
  return { 'content-type': 'application/json', 'x-memlume-setup-token': setupToken };
}

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.stop();
  while (roots.length > 0) rmSync(roots.pop()!, { force: true, recursive: true });
});

describe('v0.3 automatic shared-brain capture', () => {
  test('routes workspace captures, resolves ReadSet, and consumes an approved final', async () => {
    const dataRoot = root();
    const daemon = await startDaemon({ databasePath: join(dataRoot, 'memlume.sqlite'), port: 0, setupToken });
    daemons.push(daemon);
    const workspacePath = join(dataRoot, 'workspace');
    const initialized = await json(daemon, '/v1/setup/init', {
      method: 'POST', headers: setupHeaders(), body: JSON.stringify({ workspacePath, name: 'memlume' }),
    });
    expect(initialized.response.status).toBe(201);
    const projectId = initialized.body.project.id as string;
    const registered = await json(daemon, '/v1/setup/installations', {
      method: 'POST', headers: setupHeaders(), body: JSON.stringify({ clientType: 'codex', installationId: 'automatic-codex', profileId: 'default' }),
    });
    expect(registered.response.status).toBe(201);
    const installationId = registered.body.installation.id as string;
    const token = registered.body.token as string;
    for (const brainId of [DEFAULT_PERSONAL_BRAIN_ID, projectId]) {
      const mounted = await json(daemon, '/v1/setup/mounts', {
        method: 'POST', headers: setupHeaders(), body: JSON.stringify({ agentInstallationId: installationId, brainId, access: 'read_write' }),
      });
      expect(mounted.response.status).toBe(201);
    }
    const adapterHeaders = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-memlume-callback': 'onUserMessage',
      'x-memlume-protocol-version': '1',
      'x-memlume-adapter-version': '0.3.0',
    };
    const captured = await json(daemon, '/v1/capture', {
      method: 'POST', headers: adapterHeaders, body: JSON.stringify({
        captureId: 'capture-personal-automatic',
        rawContent: '記住我偏好簡潔回答。',
        actor: 'user',
        source: { type: 'codex', agent: 'codex', conversationId: 'session-1', messageId: 'turn-1', reference: 'codex:session-1:turn-1' },
        workspacePath,
        sessionId: 'session-1',
        turnId: 'turn-1',
      }),
    });
    expect(captured.response.status, JSON.stringify(captured.body)).toBe(201);
    expect(captured.body.receipt.status).toBe('active');
    expect(captured.body.receipt.atoms[0].brainId).toBe(DEFAULT_PERSONAL_BRAIN_ID);

    const projectCapture = await json(daemon, '/v1/capture', {
      method: 'POST', headers: { ...adapterHeaders, 'x-memlume-callback': 'onUserMessage' }, body: JSON.stringify({
        captureId: 'capture-project-automatic',
        rawContent: '記住這個專案 memlume 使用 Vue。',
        actor: 'user',
        source: { type: 'codex', agent: 'codex', conversationId: 'session-1', messageId: 'turn-2', reference: 'codex:session-1:turn-2' },
        workspacePath,
        sessionId: 'session-1',
        turnId: 'turn-2',
      }),
    });
    expect(projectCapture.body.receipt.status).toBe('active');
    expect(projectCapture.body.receipt.atoms[0].brainId).toBe(projectId);
    const context = await json(daemon, '/v1/context/resolve', {
      method: 'POST', headers: { ...adapterHeaders, 'x-memlume-callback': 'beforeTask' }, body: JSON.stringify({
        intent: 'implementation', scope: { level: 'global' }, task: 'implement Vue UI in project memlume with 簡潔回答 preference', contextBudget: 500, workspacePath,
      }),
    });
    expect(context.response.status).toBe(200);
    expect(context.body.readSet.entries.map((entry: { brainId: string }) => entry.brainId)).toEqual([projectId, DEFAULT_PERSONAL_BRAIN_ID]);
    expect(JSON.stringify(context.body.context)).toContain('簡潔回答');
    expect(JSON.stringify(context.body.context)).toContain('Vue');

    const final = await json(daemon, '/v1/runtime/final', {
      method: 'POST', headers: { ...adapterHeaders, 'x-memlume-callback': 'onUserMessage' }, body: JSON.stringify({ sessionId: 'session-1', turnId: 'approval-turn', finalAnswer: 'I use Vue for the frontend.' }),
    });
    expect(final.response.status).toBe(201);
    const approved = await json(daemon, '/v1/capture', {
      method: 'POST', headers: adapterHeaders, body: JSON.stringify({
        captureId: 'capture-approval-word', rawContent: '可以', actor: 'user',
        source: { type: 'codex', agent: 'codex', conversationId: 'session-1', messageId: 'approval-turn', reference: 'codex:session-1:approval-turn' },
        workspacePath, sessionId: 'session-1', turnId: 'approval-turn',
      }),
    });
    expect(approved.body.receipt.status).toBe('active');
    expect(JSON.stringify(approved.body.receipt)).not.toContain('可以');
  });
});
