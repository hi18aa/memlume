import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const bridge = fileURLToPath(new URL('../bridge.mjs', import.meta.url));
const brainId = '00000000-0000-7000-8000-000000000013';
const scope = { level: 'project', projectId: '00000000-0000-7000-8000-000000000012' };
const requests = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
  response.setHeader('content-type', 'application/json');
  if (request.url === '/v1/context/resolve') {
    response.statusCode = 200;
    response.end(JSON.stringify({
      context: {
        traceId: '00000000-0000-7000-8000-000000000001',
        intent: 'shared_memory',
        scope,
        directives: [{ text: '只給 child 的專案內容。' }],
        procedures: [], preferences: [], knowledge: [], decisions: [],
        explanation: { sourceMemoryIds: [], exclusions: [], budget: { limitUnits: 600, usedUnits: 0, included: [], omitted: [], truncated: false } },
      },
    }));
    return;
  }
  response.statusCode = 201;
  response.end(JSON.stringify({
    capture: {
      memoryId: '00000000-0000-7000-8000-000000000014',
      status: 'active',
      brain: brainId,
      scope,
      requiresConfirmation: false,
      source: { eventId: '00000000-0000-7000-8000-000000000015' },
    },
  }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());

test('bridge uses AdapterClient to capture a Hermes project message without echoing its token', async () => {
  const address = server.address();
  const token = 'bridge-token-never-echoed';
  const result = await invoke({
    operation: 'onUserMessage',
    envelope: {
      clientType: 'hermes',
      installationId: '00000000-0000-7000-8000-000000000010',
      profileId: '00000000-0000-7000-8000-000000000011',
      sessionId: 'hermes-session',
      projectId: scope.projectId,
    },
    message: {
      messageId: 'hermes-turn-1',
      content: '記住專案使用 pnpm',
      brainId,
      scope,
    },
  }, {
    MEMLUME_DAEMON_URL: `http://127.0.0.1:${address.port}`,
    MEMLUME_TOKEN: token,
  });

  assert.deepEqual(result, { ok: true, result: { status: 'saved', memoryStatus: 'active' } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/memories/capture');
  assert.equal(requests[0].authorization, `Bearer ${token}`);
  assert.equal(requests[0].body.rawContent, '記住專案使用 pnpm');
  assert.deepEqual(requests[0].body.scope, scope);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('bridge reads restricted child context without forwarding host identifiers to Core', async () => {
  const address = server.address();
  const token = 'bridge-child-token-never-echoed';
  const result = await invoke({
    operation: 'onSubagentStart',
    input: {
      envelope: {
        clientType: 'hermes',
        installationId: '00000000-0000-7000-8000-000000000010',
        profileId: '00000000-0000-7000-8000-000000000011',
        sessionId: 'hermes-child-session',
        projectId: scope.projectId,
      },
      parentTaskId: 'parent-turn',
      subagentId: 'child-1',
      intent: 'shared_memory',
      scope,
      task: 'Research the adapter.',
      contextBudget: 600,
      requestedBrainIds: [brainId],
    },
  }, {
    MEMLUME_DAEMON_URL: `http://127.0.0.1:${address.port}`,
    MEMLUME_TOKEN: token,
    MEMLUME_BRAIN_ID: brainId,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(requests.at(-1), {
    url: '/v1/context/resolve',
    authorization: `Bearer ${token}`,
    body: {
      intent: 'shared_memory',
      scope,
      task: 'Research the adapter.',
      contextBudget: 600,
      requestedBrainIds: [brainId],
    },
  });
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('bridge uses the validated configured Brain as a default capture target', async () => {
  const address = server.address();
  const result = await invoke({
    operation: 'onUserMessage',
    envelope: {
      clientType: 'hermes',
      installationId: '00000000-0000-7000-8000-000000000010',
      profileId: '00000000-0000-7000-8000-000000000011',
      sessionId: 'hermes-session-default-brain',
      projectId: scope.projectId,
    },
    message: {
      messageId: 'hermes-turn-default-brain',
      content: '記住專案使用 pnpm',
      scope,
    },
  }, {
    MEMLUME_DAEMON_URL: `http://127.0.0.1:${address.port}`,
    MEMLUME_TOKEN: 'bridge-default-brain-token',
    MEMLUME_BRAIN_ID: brainId,
  });

  assert.deepEqual(result, { ok: true, result: { status: 'saved', memoryStatus: 'active' } });
  assert.equal(requests.at(-1).body.brainId, brainId);
});

function invoke(payload, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge], { env: { ...process.env, ...environment }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { errors += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(errors || `bridge exited with ${code}`));
        return;
      }
      resolve(JSON.parse(output));
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}
