export type ConsolePage = 'dashboard' | 'brains' | 'memories' | 'inbox' | 'agents' | 'backup';

export type ConsolePageState =
  | { readonly status: 'success'; readonly data: unknown }
  | { readonly status: 'empty'; readonly data: unknown }
  | { readonly status: 'error'; readonly message: string };

export interface ConsoleApi {
  loadPage(page: ConsolePage): Promise<ConsolePageState>;
  createBrain(input: { readonly name: string; readonly kind: 'personal' | 'project' | 'domain' }): Promise<unknown>;
  reviewCandidate(memoryId: string, action: 'approve' | 'reject', reason: string, supersedeMemoryId?: string): Promise<unknown>;
  registerInstallation(input: { readonly clientType: string; readonly installationId: string; readonly profileId: string; readonly displayName?: string }): Promise<unknown>;
  mountBrain(input: { readonly brainId: string; readonly agentInstallationId: string; readonly access: 'read' | 'read_write' }): Promise<unknown>;
  rotateToken(agentInstallationId: string): Promise<string>;
  createBackup(password: string): Promise<Uint8Array>;
  restoreBackup(bundle: Uint8Array, password: string): Promise<void>;
}

export interface ConsoleApiOptions {
  readonly setupToken: string;
  readonly fetch?: typeof globalThis.fetch;
}

const pagePaths: Record<ConsolePage, string> = {
  dashboard: '/v1/setup/diagnostics',
  brains: '/v1/setup/brains',
  memories: '/v1/setup/memories',
  inbox: '/v1/setup/inbox',
  agents: '/v1/setup/installations',
  backup: '/v1/setup/diagnostics',
};

export function createConsoleApi({ setupToken, fetch = globalThis.fetch }: ConsoleApiOptions): ConsoleApi {
  const headers = { 'x-memlume-setup-token': setupToken };
  return {
    async loadPage(page) {
      try {
        const response = await fetch(pagePaths[page], { headers });
        if (!response.ok) {
          return { status: 'error', message: `無法讀取資料（HTTP ${response.status}）。` };
        }
        const data = await response.json() as unknown;
        return isEmpty(page, data) ? { status: 'empty', data } : { status: 'success', data };
      } catch {
        return { status: 'error', message: '無法連線到本機 daemon。' };
      }
    },
    async createBrain(input) {
      const response = await fetch('/v1/setup/brains', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        throw new Error(`建立 Brain 失敗（HTTP ${response.status}）。`);
      }
      return (await response.json() as { readonly brain: unknown }).brain;
    },
    async reviewCandidate(memoryId, action, reason, supersedeMemoryId) {
      const response = await fetch(`/v1/setup/inbox/${encodeURIComponent(memoryId)}/${action}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ reason, ...(action === 'approve' && supersedeMemoryId !== undefined && supersedeMemoryId !== '' ? { supersedeMemoryId } : {}) }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => undefined) as { readonly error?: unknown } | undefined;
        if (error?.error === 'confirmation_required' || error?.error === 'invalid_supersede') {
          throw new Error('此候選與既有記憶衝突，請輸入要取代的 memory ID。');
        }
        if (error?.error === 'active_duplicate') {
          throw new Error('已有相同的有效記憶，請拒絕此 candidate。');
        }
        if (error?.error === 'candidate_not_pending') {
          throw new Error('此 candidate 已被處理，請重新整理 Inbox。');
        }
        throw new Error(`候選治理失敗（HTTP ${response.status}）。`);
      }
      return (await response.json() as { readonly memory: unknown }).memory;
    },
    async registerInstallation(input) {
      const response = await fetch('/v1/setup/installations', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        throw new Error(`註冊 Agent 失敗（HTTP ${response.status}）。`);
      }
      return await response.json() as unknown;
    },
    async mountBrain(input) {
      const response = await fetch('/v1/setup/mounts', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        throw new Error(`掛載 Brain 失敗（HTTP ${response.status}）。`);
      }
      return (await response.json() as { readonly mount: unknown }).mount;
    },
    async rotateToken(agentInstallationId) {
      const response = await fetch(`/v1/setup/installations/${encodeURIComponent(agentInstallationId)}/token/rotate`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`輪替 token 失敗（HTTP ${response.status}）。`);
      }
      return (await response.json() as { readonly token: string }).token;
    },
    async createBackup(password) {
      const response = await fetch('/v1/setup/backups', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        throw new Error(`備份失敗（HTTP ${response.status}）。`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    async restoreBackup(bundle, password) {
      const response = await fetch('/v1/setup/backups/restore', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/vnd.memlume', 'x-memlume-backup-password': password },
        body: bundle,
      });
      if (!response.ok) {
        throw new Error(`還原失敗（HTTP ${response.status}）。`);
      }
    },
  };
}

function isEmpty(page: ConsolePage, data: unknown): boolean {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const value = data as Record<string, unknown>;
  if (page === 'dashboard' || page === 'backup') {
    return Array.isArray(value.brains) && value.brains.length === 0;
  }
  const field = page === 'agents' ? 'installations' : page === 'brains' ? 'brains' : 'memories';
  return Array.isArray(value[field]) && value[field].length === 0;
}
