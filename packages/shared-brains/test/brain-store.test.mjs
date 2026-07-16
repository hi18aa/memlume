import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, describe, test } from 'node:test';

import { AdapterHeartbeatSchema, AgentInstallationSchema, BrainMountSchema, BrainSchema } from '@memlume/contracts';
import { openDatabase } from '@memlume/database/internal';

import * as sharedBrains from '../dist/index.js';

const databases = [];

afterEach(() => {
  while (databases.length > 0) {
    databases.pop().close();
  }
});

function createStore() {
  const database = openDatabase(':memory:');
  databases.push(database);
  assert.equal(typeof sharedBrains.BrainStore, 'function');
  return { database, store: new sharedBrains.BrainStore(database) };
}

describe('BrainStore', () => {
  test('creates validated brains and lists them deterministically by creation time and id', () => {
    const { database, store } = createStore();
    const first = store.createBrain({ kind: 'project', name: 'Memlume' });
    const second = store.createBrain({ kind: 'project', name: 'Frontend' });

    assert.deepEqual(BrainSchema.parse(first), first);
    assert.deepEqual(BrainSchema.parse(second), second);
    database.prepare('UPDATE brains SET created_at = ?').run('2026-07-13T00:00:00.000Z');

    const brains = store.listBrains();
    assert.equal(brains.some((brain) => brain.id === first.id), true);
    assert.equal(brains.some((brain) => brain.id === second.id), true);
    assert.deepEqual(brains.map((brain) => brain.id), brains.map((brain) => brain.id).toSorted());
  });

  test('registers an installation with a generated token hash but never stores the plaintext token', () => {
    const { database, store } = createStore();
    const registered = store.registerInstallation({
      clientType: 'codex',
      installationId: 'desktop',
      profileId: 'default',
      displayName: 'Codex Desktop',
    });

    assert.deepEqual(AgentInstallationSchema.parse(registered.installation), registered.installation);
    assert.equal(Buffer.from(registered.token, 'base64url').byteLength >= 32, true);
    const row = database
      .prepare('SELECT token_hash, revoked_at FROM adapter_tokens WHERE agent_installation_id = ?')
      .get(registered.installation.id);
    assert.equal(row.token_hash, createHash('sha256').update(registered.token).digest('hex'));
    assert.equal(row.revoked_at, null);
    assert.equal(Object.hasOwn(row, 'token'), false);
    assert.equal(JSON.stringify(row).includes(registered.token), false);
  });

  test('re-registers an installation by rotating its token without creating a duplicate', () => {
    const { database, store } = createStore();
    const registration = {
      clientType: 'codex',
      installationId: 'desktop',
      profileId: 'default',
    };
    const first = store.registerInstallation(registration);
    const second = store.registerInstallation(registration);

    assert.equal(second.installation.id, first.installation.id);
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM agent_installations WHERE client_type = ? AND installation_id = ? AND profile_id = ?')
        .get(registration.clientType, registration.installationId, registration.profileId).count,
      1,
    );
    const replacedTokenError = thrownError(() => store.authenticateToken(first.token));
    assert.match(replacedTokenError.message, /Invalid adapter token/);
    assert.equal(replacedTokenError.message.includes(first.token), false);
    assert.deepEqual(store.authenticateToken(second.token), second.installation);
    const tokens = database
      .prepare('SELECT revoked_at FROM adapter_tokens WHERE agent_installation_id = ?')
      .all(first.installation.id);
    assert.equal(tokens.filter((token) => token.revoked_at === null).length, 1);
  });

  test('records verified callback heartbeats by adapter and protocol version', () => {
    const { store } = createStore();
    const { installation } = store.registerInstallation({
      clientType: 'codex',
      installationId: 'desktop',
      profileId: 'default',
    });
    const first = store.recordHeartbeat({
      agentInstallationId: installation.id,
      callback: 'beforeTask',
      protocolVersion: '1',
      adapterVersion: '0.2.0',
      seenAt: '2026-07-16T00:00:00.000Z',
    });
    const second = store.recordHeartbeat({
      agentInstallationId: installation.id,
      callback: 'beforeTask',
      protocolVersion: '1',
      adapterVersion: '0.2.0',
      seenAt: '2026-07-16T00:00:01.000Z',
    });
    assert.deepEqual(AdapterHeartbeatSchema.parse(second), second);
    assert.equal(first.firstSeenAt, second.firstSeenAt);
    assert.equal(second.lastSeenAt, '2026-07-16T00:00:01.000Z');
    assert.equal(store.listHeartbeats(installation.id).length, 1);
    assert.throws(() => store.recordHeartbeat({
      agentInstallationId: installation.id,
      callback: 'onUserMessage',
      protocolVersion: '1',
      adapterVersion: '',
    }), /Too small: expected string/);
  });

  test('does not allow a caller-controlled id to replace the generated installation id', () => {
    const { database, store } = createStore();
    const callerControlledId = '018f9d4e-7c2a-7b91-8dc0-61749dbcc01e';
    // JavaScript equivalent of TypeScript's `as unknown`: inject an untyped extra key.
    const untypedInput = /** @type {unknown} */ ({
      id: callerControlledId,
      clientType: 'codex',
      installationId: 'desktop',
      profileId: 'default',
    });

    const registered = store.registerInstallation(untypedInput);

    assert.deepEqual(AgentInstallationSchema.parse(registered.installation), registered.installation);
    assert.notEqual(registered.installation.id, callerControlledId);
    const row = database
      .prepare('SELECT id FROM agent_installations WHERE client_type = ? AND installation_id = ? AND profile_id = ?')
      .get('codex', 'desktop', 'default');
    assert.equal(row.id, registered.installation.id);
    assert.notEqual(row.id, callerControlledId);
  });

  test('upserts a brain mount and lists its current access exactly once', () => {
    const { database, store } = createStore();
    const brain = store.createBrain({ kind: 'project', name: 'Memlume' });
    const { installation } = store.registerInstallation({
      clientType: 'codex',
      installationId: 'desktop',
      profileId: 'default',
    });

    assert.deepEqual(
      BrainMountSchema.parse(store.mountBrain({ brainId: brain.id, agentInstallationId: installation.id, access: 'read' })),
      { brainId: brain.id, agentInstallationId: installation.id, access: 'read' },
    );
    store.mountBrain({ brainId: brain.id, agentInstallationId: installation.id, access: 'read_write' });

    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM brain_mounts WHERE brain_id = ? AND agent_installation_id = ?')
        .get(brain.id, installation.id).count,
      1,
    );
    assert.deepEqual(store.listMountedBrains(installation.id), [{ brain, access: 'read_write' }]);
  });

  test('allows mounted reads but requires read_write access for writes', () => {
    const { store } = createStore();
    const brain = store.createBrain({ kind: 'project', name: 'Memlume' });
    const unmountedBrain = store.createBrain({ kind: 'project', name: 'Frontend' });
    const { installation } = store.registerInstallation({
      clientType: 'codex',
      installationId: 'desktop',
      profileId: 'default',
    });
    store.mountBrain({ brainId: brain.id, agentInstallationId: installation.id, access: 'read' });

    assert.doesNotThrow(() => store.assertAccess(installation.id, brain.id, 'read'));
    assert.throws(() => store.assertAccess(installation.id, brain.id, 'read_write'), /write access/i);
    assert.throws(() => store.assertAccess(installation.id, unmountedBrain.id, 'read'), /not mounted/i);

    store.mountBrain({ brainId: brain.id, agentInstallationId: installation.id, access: 'read_write' });
    assert.doesNotThrow(() => store.assertAccess(installation.id, brain.id, 'read_write'));
  });

  test('authenticates only active tokens and never echoes unknown or revoked tokens', () => {
    const { database, store } = createStore();
    const registered = store.registerInstallation({
      clientType: 'codex',
      installationId: 'desktop',
      profileId: 'default',
    });

    assert.deepEqual(store.authenticateToken(registered.token), registered.installation);
    const unknownToken = 'not-a-real-adapter-token';
    const unknownError = thrownError(() => store.authenticateToken(unknownToken));
    assert.match(unknownError.message, /Invalid adapter token/);
    assert.equal(unknownError.message.includes(unknownToken), false);

    database.prepare('UPDATE adapter_tokens SET revoked_at = ? WHERE agent_installation_id = ?').run(
      '2026-07-13T00:00:00.000Z',
      registered.installation.id,
    );
    const revokedError = thrownError(() => store.authenticateToken(registered.token));
    assert.match(revokedError.message, /Invalid adapter token/);
    assert.equal(revokedError.message.includes(registered.token), false);
  });

  test('rotates an installation token by revoking every old active token in the same transaction', () => {
    const { database, store } = createStore();
    const registered = store.registerInstallation({
      clientType: 'codex',
      installationId: 'desktop',
      profileId: 'default',
    });
    const additionalOldToken = 'additional-active-token-for-rotation-test';
    database
      .prepare('INSERT INTO adapter_tokens (id, agent_installation_id, token_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(
        '00000000-0000-7000-8000-000000000002',
        registered.installation.id,
        createHash('sha256').update(additionalOldToken).digest('hex'),
        '2026-07-13T00:00:00.000Z',
      );
    assert.deepEqual(store.authenticateToken(additionalOldToken), registered.installation);

    const rotated = store.rotateToken(registered.installation.id);

    assert.deepEqual(store.authenticateToken(rotated.token), registered.installation);
    assert.match(thrownError(() => store.authenticateToken(registered.token)).message, /Invalid adapter token/);
    assert.match(thrownError(() => store.authenticateToken(additionalOldToken)).message, /Invalid adapter token/);
    const tokens = database
      .prepare('SELECT token_hash, revoked_at FROM adapter_tokens WHERE agent_installation_id = ? ORDER BY created_at, id')
      .all(registered.installation.id);
    assert.equal(tokens.length, 3);
    assert.equal(tokens.filter((token) => token.revoked_at === null).length, 1);
    assert.equal(tokens.filter((token) => token.revoked_at !== null).length, 2);
  });
});

function thrownError(action) {
  try {
    action();
  } catch (error) {
    assert.equal(error instanceof Error, true);
    return error;
  }
  assert.fail('Expected an error.');
}
