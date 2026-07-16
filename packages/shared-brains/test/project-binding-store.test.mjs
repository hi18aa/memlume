import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { openDatabase } from '@memlume/database/internal';

import {
  AmbiguousProjectAliasError,
  ProjectBindingStore,
  canonicalGitRemote,
  canonicalWorkspacePath,
} from '../dist/index.js';

const fixtures = [];
afterEach(() => {
  while (fixtures.length > 0) {
    const value = fixtures.pop();
    if (typeof value === 'string') rmSync(value, { recursive: true, force: true });
    else value.close();
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'memlume-project-binding-'));
  fixtures.push(root);
  const database = openDatabase(':memory:');
  fixtures.push(database);
  return { root, database, store: new ProjectBindingStore(database, { markdownRoot: root }) };
}

describe('ProjectBindingStore', () => {
  test('normalizes local paths and HTTPS/SSH remotes without credentials', () => {
    const path = canonicalWorkspacePath(join(process.cwd(), 'Workspace', '..', 'workspace'));
    assert.equal(path, canonicalWorkspacePath(path));
    assert.equal(canonicalGitRemote('https://user:token@GitHub.com/hi18aa/memlume.git?x=1#readme'), 'https://github.com/hi18aa/memlume.git');
    assert.equal(canonicalGitRemote('git@GitHub.com:hi18aa/memlume.git'), 'ssh://github.com/hi18aa/memlume.git');
  });

  test('creates project metadata and writes a Brain document', () => {
    const { root, store } = fixture();
    const project = store.createProject('Memlume');
    assert.equal(project.kind, 'project');
    assert.equal(existsSync(join(root, 'brains', project.id, 'brain.md')), true);
  });

  test('keeps aliases explicit and rejects ambiguous resolution', () => {
    const { store } = fixture();
    const first = store.createProject('One');
    const second = store.createProject('Two');
    store.addAlias(first.id, 'Frontend');
    assert.equal(store.resolveAlias(' frontend ')?.id, first.id);
    store.addAlias(second.id, 'frontend');
    assert.throws(() => store.resolveAlias('frontend'), (error) => error instanceof AmbiguousProjectAliasError);
  });

  test('binds one primary and read-only linked projects without auto-creating unknown workspaces', () => {
    const { store } = fixture();
    const first = store.createProject('One');
    const second = store.createProject('Two');
    const workspace = join(process.cwd(), 'memlume-project-binding-workspace');
    assert.deepEqual(store.resolveWorkspace(workspace), []);
    assert.equal(store.bindWorkspace({ workspacePath: workspace, brainId: first.id, role: 'primary' }).access, 'read_write');
    assert.equal(store.bindWorkspace({ workspacePath: workspace, brainId: second.id, role: 'linked' }).access, 'read');
    assert.throws(() => store.bindWorkspace({ workspacePath: workspace, brainId: second.id, role: 'primary' }), /workspace_primary_exists/);
    assert.deepEqual(store.listWorkspace(workspace).map(({ role, access }) => [role, access]), [['primary', 'read_write'], ['linked', 'read']]);
  });

  test('resolves a project key by canonical path or remote', () => {
    const { store } = fixture();
    const project = store.createProject('Memlume');
    store.addProjectKey({ brainId: project.id, keyType: 'canonical_path', value: join(process.cwd(), 'repo', '..', 'repo') });
    store.addProjectKey({ brainId: project.id, keyType: 'git_remote', value: 'git@github.com:hi18aa/memlume.git' });
    assert.equal(store.findByProjectKey('git_remote', 'https://github.com/hi18aa/memlume.git')?.id, project.id);
  });
});
