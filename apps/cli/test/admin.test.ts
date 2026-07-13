import { basename, dirname } from 'node:path';

import { describe, expect, test } from 'vitest';

import { main } from '../src/index.js';

type RecordedRequest = {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: string | Uint8Array | undefined;
};

type FakeReply = {
  readonly status?: number;
  readonly body?: unknown;
  readonly binary?: Uint8Array;
};

function createRuntime(replies: readonly FakeReply[] = [], options: { readonly interactive?: boolean; readonly confirm?: boolean; readonly verifyError?: Error; readonly manifestScope?: 'full' | 'brain'; readonly removeDirectoryError?: Error } = {}) {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  const requests: RecordedRequest[] = [];
  const removeFileCalls: string[] = [];
  const removeDirectoryCalls: string[] = [];
  let verifyCalls = 0;
  const replyQueue = [...replies];
  const runtime = {
    configPath: () => '/settings/memlume.json',
    cwd: () => '/workspace',
    isInteractive: () => options.interactive ?? false,
    confirm: async () => options.confirm ?? true,
    readFile: async (path: string) => files.get(path),
    writeFile: async (path: string, value: string | Uint8Array) => {
      files.set(path, typeof value === 'string' ? new TextEncoder().encode(value) : value);
    },
    mkdir: async (path: string) => {
      if (directories.has(path)) return false;
      directories.add(path);
      return true;
    },
    removeFile: async (path: string) => {
      removeFileCalls.push(path);
      if (directories.has(path)) throw new Error('EISDIR');
      files.delete(path);
    },
    removeEmptyDirectory: async (path: string) => {
      removeDirectoryCalls.push(path);
      if (options.removeDirectoryError !== undefined) throw options.removeDirectoryError;
      if ([...files.keys()].some((file) => dirname(file) === path)) throw new Error('ENOTEMPTY');
      directories.delete(path);
    },
    readdir: async (path: string) => [...files.keys()].filter((file) => dirname(file) === path).map((file) => basename(file)),
    homePath: () => '/home/memlume',
    pathExists: async (path: string) => files.has(path) || directories.has(path),
    copyDirectory: async (_source: string, destination: string) => {
      directories.add(destination);
    },
    removeDirectory: async (path: string) => {
      directories.delete(path);
    },
    verifyBackup: async (_path: string, _password: string | undefined) => {
      verifyCalls += 1;
      if (options.verifyError !== undefined) throw options.verifyError;
      return { scope: options.manifestScope ?? 'full', brainIds: ['brain-1'] };
    },
    fetch: async (input: string | URL | Request, init: RequestInit = {}) => {
      const endpoint = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      requests.push({
        method: init.method ?? 'GET',
        path: `${endpoint.pathname}${endpoint.search}`,
        headers: new Headers(init.headers),
        body: typeof init.body === 'string' || init.body instanceof Uint8Array
          ? init.body
          : init.body instanceof ArrayBuffer ? new Uint8Array(init.body) : undefined,
      });
      const reply = replyQueue.shift() ?? { body: {} };
      return new Response(reply.binary ?? JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: { 'content-type': reply.binary === undefined ? 'application/json' : 'application/vnd.memlume' },
      });
    },
  };
  return {
    runtime,
    files,
    directories,
    requests,
    removeFileCalls,
    removeDirectoryCalls,
    verifyCalls: () => verifyCalls,
  };
}

async function run(args: string[], runtime: ReturnType<typeof createRuntime>['runtime'], environment: NodeJS.ProcessEnv = {}) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } }, environment, runtime);
  return { code, stdout, stderr };
}

function fileText(files: ReadonlyMap<string, Uint8Array>, path: string): string {
  return new TextDecoder().decode(files.get(path));
}

describe('memlume CLI administration', () => {
  test('setup shows a diff, backs up the old config, applies the backup directory, then smoke-tests diagnostics', async () => {
    const fake = createRuntime([{ body: { health: 'ok', integrity: 'ok', schema: { migrations: ['001'] }, brains: [], mounts: [] } }]);
    await fake.runtime.writeFile('/settings/memlume.json', JSON.stringify({ version: 1, backupDirectory: '/old-backups' }));

    const result = await run(['--url', 'http://127.0.0.1:3849', '--setup-token', 'setup-secret', 'setup', '--backup-dir', '/new-backups'], fake.runtime);

    expect(result).toEqual({ code: 0, stdout: '設定變更：\nbackupDirectory: /old-backups -> /new-backups\n設定已套用並通過診斷檢查。\n', stderr: '' });
    expect(fileText(fake.files, '/settings/memlume.json')).toBe(JSON.stringify({ version: 1, backupDirectory: '/new-backups' }));
    expect(fileText(fake.files, '/settings/memlume.json.backup')).toBe(JSON.stringify({ version: 1, backupDirectory: '/old-backups' }));
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.headers.get('x-memlume-setup-token')).toBe('setup-secret');
    expect(result.stdout + result.stderr).not.toContain('setup-secret');
  });

  test('setup restores the prior config when the diagnostics smoke test fails', async () => {
    const fake = createRuntime([{ status: 500, body: { error: 'internal_error' } }]);
    await fake.runtime.writeFile('/settings/memlume.json', JSON.stringify({ version: 1, backupDirectory: '/old-backups' }));

    const result = await run(['--url', 'http://127.0.0.1:3849', '--setup-token', 'setup-secret', 'setup', '--backup-dir', '/new-backups'], fake.runtime);

    expect(result).toEqual({ code: 1, stdout: '設定變更：\nbackupDirectory: /old-backups -> /new-backups\n', stderr: 'Error: 設定已還原，診斷檢查失敗。\n' });
    expect(fileText(fake.files, '/settings/memlume.json')).toBe(JSON.stringify({ version: 1, backupDirectory: '/old-backups' }));
    expect(result.stdout + result.stderr).not.toContain('setup-secret');
  });

  test('setup rollback preserves an existing config backup and removes only the backup directory it created', async () => {
    const fake = createRuntime([{ status: 500, body: { error: 'internal_error' } }]);
    await fake.runtime.writeFile('/settings/memlume.json', JSON.stringify({ version: 1, backupDirectory: '/old-backups' }));
    await fake.runtime.writeFile('/settings/memlume.json.backup', 'previous backup');
    await fake.runtime.mkdir('/old-backups');

    const result = await run(['--url', 'http://127.0.0.1:3849', '--setup-token', 'setup-secret', 'setup', '--backup-dir', '/new-backups'], fake.runtime);

    expect(result.code).toBe(1);
    expect(fileText(fake.files, '/settings/memlume.json')).toBe(JSON.stringify({ version: 1, backupDirectory: '/old-backups' }));
    expect(fileText(fake.files, '/settings/memlume.json.backup')).toBe('previous backup');
    expect(fake.directories.has('/old-backups')).toBe(true);
    expect(fake.directories.has('/new-backups')).toBe(false);
  });

  test('setup preserves an existing backup and creates a uniquely named snapshot for the current config', async () => {
    const fake = createRuntime([{ body: { health: 'ok', integrity: 'ok', schema: { migrations: [] }, brains: [], mounts: [] } }]);
    const current = JSON.stringify({ version: 1, backupDirectory: '/old-backups' });
    await fake.runtime.writeFile('/settings/memlume.json', current);
    await fake.runtime.writeFile('/settings/memlume.json.backup', 'previous backup');
    await fake.runtime.writeFile('/settings/memlume.json.backup.snapshot-1', 'older snapshot');

    const result = await run(['--url', 'http://127.0.0.1:3849', '--setup-token', 'setup-secret', 'setup', '--backup-dir', '/new-backups'], fake.runtime);

    expect(result.code).toBe(0);
    expect(fileText(fake.files, '/settings/memlume.json.backup')).toBe('previous backup');
    expect(fileText(fake.files, '/settings/memlume.json.backup.snapshot-1')).toBe('older snapshot');
    expect(fileText(fake.files, '/settings/memlume.json.backup.snapshot-2')).toBe(current);
  });

  test('setup rollback uses empty-directory cleanup and keeps the restored-config error when cleanup fails', async () => {
    const fake = createRuntime([{ status: 500, body: { error: 'internal_error' } }], { removeDirectoryError: new Error('EPERM') });
    await fake.runtime.writeFile('/settings/memlume.json', JSON.stringify({ version: 1, backupDirectory: '/old-backups' }));

    const result = await run(['--url', 'http://127.0.0.1:3849', '--setup-token', 'setup-secret', 'setup', '--backup-dir', '/new-backups'], fake.runtime);

    expect(result).toEqual({ code: 1, stdout: '設定變更：\nbackupDirectory: /old-backups -> /new-backups\n', stderr: 'Error: 設定已還原，診斷檢查失敗。\n' });
    expect(fileText(fake.files, '/settings/memlume.json')).toBe(JSON.stringify({ version: 1, backupDirectory: '/old-backups' }));
    expect(fake.removeFileCalls).not.toContain('/new-backups');
    expect(fake.removeDirectoryCalls).toEqual(['/new-backups']);
    expect(fake.directories.has('/new-backups')).toBe(true);
  });

  test('doctor reports public health and protected diagnostics without printing the setup token', async () => {
    const fake = createRuntime([
      { body: { status: 'ok' } },
      { body: { health: 'ok', integrity: 'ok', schema: { migrations: ['001', '002'] }, brains: [{ id: 'brain-1' }], mounts: [{ brainId: 'brain-1' }] } },
    ]);

    const result = await run(['--url', 'http://127.0.0.1:3849', '--setup-token', 'setup-secret', 'doctor'], fake.runtime);

    expect(result).toEqual({ code: 0, stdout: 'Daemon: ok.\nIntegrity: ok.\nMigrations: 2.\nBrains: 1.\nMounts: 1.\n', stderr: '' });
    expect(fake.requests.map(({ path }) => path)).toEqual(['/v1/health', '/v1/setup/diagnostics']);
    expect(result.stdout).not.toContain('setup-secret');
  });

  test('doctor performs a read-only check for every local Adapter profile without exposing its token', async () => {
    const fake = createRuntime([
      { body: { status: 'ok' } },
      { body: { health: 'ok', integrity: 'ok', schema: { migrations: ['001'] }, brains: [{ id: 'brain-1' }], mounts: [{ brainId: 'brain-1', agentInstallationId: 'installation-1', access: 'read_write' }] } },
      { body: { installations: [{ id: 'installation-1', clientType: 'hermes', installationId: 'hermes-main', profileId: 'default' }] } },
      { body: { context: { directives: [] } } },
    ]);
    await fake.runtime.writeFile('/settings/memlume.json', JSON.stringify({
      version: 1,
      backupDirectory: '/backups',
      adapters: [{
        clientType: 'hermes',
        installationId: 'hermes-main',
        profileId: 'default',
        projectId: 'memlume',
        brainId: 'brain-1',
        token: 'profile-secret',
        corePath: '/workspace/memlume',
        daemonUrl: 'http://127.0.0.1:3849',
      }],
    }));

    const result = await run(['--url', 'http://127.0.0.1:3849', '--setup-token', 'setup-secret', 'doctor'], fake.runtime);

    expect(result).toEqual({
      code: 0,
      stdout: 'Daemon: ok.\nIntegrity: ok.\nMigrations: 1.\nBrains: 1.\nMounts: 1.\nAdapter profiles: 1.\nHermes hermes-main/default -> Brain brain-1: mount read_write; token configured; read check: ok.\n',
      stderr: '',
    });
    expect(fake.requests.map(({ path }) => path)).toEqual(['/v1/health', '/v1/setup/diagnostics', '/v1/setup/installations', '/v1/context/resolve']);
    expect(fake.requests[3]?.headers.get('authorization')).toBe('Bearer profile-secret');
    expect(result.stdout + result.stderr).not.toContain('profile-secret');
  });

  test('brain list uses the setup token and returns the daemon Brain inventory', async () => {
    const fake = createRuntime([{ body: { brains: [{ id: 'brain-1', name: 'Personal' }] } }]);

    const result = await run(['--url', 'http://127.0.0.1:3849', '--setup-token', 'setup-secret', 'brain', 'list'], fake.runtime);

    expect(result).toEqual({ code: 0, stdout: 'brain-1: Personal\n', stderr: '' });
    expect(fake.requests[0]).toMatchObject({ method: 'GET', path: '/v1/setup/brains' });
    expect(fake.requests[0]?.headers.get('x-memlume-setup-token')).toBe('setup-secret');
  });

  test('brain export requests exactly one Brain bundle and keeps the password out of output', async () => {
    const fake = createRuntime([{ binary: new Uint8Array([1, 2, 3]) }]);

    const result = await run(
      ['--url', 'http://127.0.0.1:3849', '--setup-token', 'setup-secret', 'brain', 'export', 'brain-1', '--output', '/exports/brain.memlume', '--password-env', 'EXPORT_PASSWORD'],
      fake.runtime,
      { EXPORT_PASSWORD: 'backup-secret' },
    );

    expect(result).toEqual({ code: 0, stdout: '已匯出 Brain brain-1 至 /exports/brain.memlume。\n', stderr: '' });
    expect(fake.files.get('/exports/brain.memlume')).toEqual(new Uint8Array([1, 2, 3]));
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ method: 'POST', path: '/v1/setup/backups', body: JSON.stringify({ brainId: 'brain-1', password: 'backup-secret' }) });
    expect(fake.requests[0]?.headers.get('x-memlume-setup-token')).toBe('setup-secret');
    expect(result.stdout + result.stderr).not.toContain('backup-secret');
  });

  test('brain import uploads a local bundle and prints the imported Brain ID', async () => {
    const fake = createRuntime([{ status: 201, body: { brain: { id: 'brain-imported' } } }]);
    await fake.runtime.writeFile('/exports/brain.memlume', new Uint8Array([4, 5, 6]));

    const result = await run(['--url', 'http://127.0.0.1:3849', '--setup-token', 'setup-secret', 'brain', 'import', '/exports/brain.memlume', '--name', '匯入測試'], fake.runtime);

    expect(result).toEqual({ code: 0, stdout: '已匯入 Brain brain-imported。\n', stderr: '' });
    expect(fake.requests[0]).toMatchObject({ method: 'POST', path: '/v1/setup/brains/import?name=%E5%8C%AF%E5%85%A5%E6%B8%AC%E8%A9%A6', body: new Uint8Array([4, 5, 6]) });
    expect(fake.requests[0]?.headers.get('content-type')).toBe('application/vnd.memlume');
  });

  test('backup create requires a password environment variable before it contacts the daemon', async () => {
    const fake = createRuntime();

    const result = await run(['--url', 'http://127.0.0.1:3849', '--setup-token', 'setup-secret', 'backup', 'create', '--output', '/backups/new.memlume'], fake.runtime);

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'Error: 完整備份必須提供 --password-env 或 MEMLUME_BACKUP_PASSWORD。\n' });
    expect(fake.requests).toEqual([]);
  });

  test('backup create writes a complete local bundle and backup list only shows local .memlume files', async () => {
    const fake = createRuntime([{ binary: new Uint8Array([7, 8]) }]);
    await fake.runtime.writeFile('/settings/memlume.json', JSON.stringify({ version: 1, backupDirectory: '/backups' }));
    await fake.runtime.writeFile('/backups/older.memlume', new Uint8Array([1]));
    await fake.runtime.writeFile('/backups/notes.txt', new Uint8Array([2]));

    const created = await run(['--url', 'http://127.0.0.1:3849', '--setup-token', 'setup-secret', 'backup', 'create', '--output', '/backups/new.memlume'], fake.runtime, { MEMLUME_BACKUP_PASSWORD: 'backup-secret' });
    const listed = await run(['backup', 'list'], fake.runtime);

    expect(created).toEqual({ code: 0, stdout: '已建立完整備份 /backups/new.memlume。\n', stderr: '' });
    expect(fake.files.get('/backups/new.memlume')).toEqual(new Uint8Array([7, 8]));
    expect(listed).toEqual({ code: 0, stdout: 'new.memlume\nolder.memlume\n', stderr: '' });
    expect(fake.requests[0]).toMatchObject({ method: 'POST', path: '/v1/setup/backups', body: '{"password":"backup-secret"}' });
  });

  test('backup verify uses the local offline verifier without contacting the daemon', async () => {
    const fake = createRuntime();

    const result = await run(['backup', 'verify', '/backups/full.memlume'], fake.runtime);

    expect(result).toEqual({ code: 0, stdout: '備份驗證成功：完整備份，1 個 Brain。\n', stderr: '' });
    expect(fake.verifyCalls()).toBe(1);
    expect(fake.requests).toEqual([]);
  });

  test('backup restore requires --yes in non-interactive mode before local verification or daemon access', async () => {
    const fake = createRuntime();

    const result = await run(['--url', 'http://127.0.0.1:3849', '--setup-token', 'setup-secret', 'backup', 'restore', '/backups/full.memlume'], fake.runtime);

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'Error: 非互動環境還原備份必須明確傳入 --yes。\n' });
    expect(fake.verifyCalls()).toBe(0);
    expect(fake.requests).toEqual([]);
  });

  test('backup restore stops after offline verification when given a single Brain bundle', async () => {
    const fake = createRuntime([{ body: { status: 'restored' } }], { manifestScope: 'brain' });
    await fake.runtime.writeFile('/backups/brain.memlume', new Uint8Array([9, 10]));

    const result = await run(['--url', 'http://127.0.0.1:3849', '--setup-token', 'setup-secret', 'backup', 'restore', '/backups/brain.memlume', '--yes'], fake.runtime);

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'Error: 單一 Brain 匯出不能還原，請改用 brain import。\n' });
    expect(fake.verifyCalls()).toBe(1);
    expect(fake.requests).toEqual([]);
  });

  test('backup restore cancellation in interactive mode does not verify or upload', async () => {
    const fake = createRuntime([], { interactive: true, confirm: false });

    const result = await run(['--url', 'http://127.0.0.1:3849', '--setup-token', 'setup-secret', 'backup', 'restore', '/backups/full.memlume'], fake.runtime);

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'Error: 已取消還原備份。\n' });
    expect(fake.verifyCalls()).toBe(0);
    expect(fake.requests).toEqual([]);
  });

  test('backup restore verifies locally before it uploads the binary bundle', async () => {
    const fake = createRuntime([{ body: { status: 'restored' } }]);
    await fake.runtime.writeFile('/backups/full.memlume', new Uint8Array([9, 10]));

    const result = await run(['--url', 'http://127.0.0.1:3849', '--setup-token', 'setup-secret', 'backup', 'restore', '/backups/full.memlume', '--yes'], fake.runtime);

    expect(result).toEqual({ code: 0, stdout: '已還原備份。\n', stderr: '' });
    expect(fake.verifyCalls()).toBe(1);
    expect(fake.requests[0]).toMatchObject({ method: 'POST', path: '/v1/setup/backups/restore', body: new Uint8Array([9, 10]) });
  });
});
