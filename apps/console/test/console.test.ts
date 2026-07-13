// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, test, vi } from 'vitest';

import { createConsoleApi, type ConsolePage } from '../src/api.js';
import AgentsView from '../src/views/AgentsView.vue';
import BackupView from '../src/views/BackupView.vue';
import BrainsView from '../src/views/BrainsView.vue';
import DashboardView from '../src/views/DashboardView.vue';
import InboxView from '../src/views/InboxView.vue';
import MemoriesView from '../src/views/MemoriesView.vue';

type Reply = { readonly status?: number; readonly body?: unknown; readonly binary?: Uint8Array };

function createFetch(replies: readonly Reply[]) {
  const queue = [...replies];
  const requests: Array<{ readonly path: string; readonly headers: Headers; readonly body: string | undefined }> = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, 'http://127.0.0.1');
    requests.push({ path: `${url.pathname}${url.search}`, headers: new Headers(init.headers), body: typeof init.body === 'string' ? init.body : undefined });
    const reply = queue.shift() ?? { body: {} };
    return new Response(reply.binary ?? JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': reply.binary === undefined ? 'application/json' : 'application/vnd.memlume' },
    });
  };
  return { fetch, requests };
}

const successfulResponses: Record<ConsolePage, unknown> = {
  dashboard: { health: 'ok', integrity: 'ok', schema: { migrations: ['001'] }, brains: [{ id: 'brain-1' }], mounts: [] },
  brains: { brains: [{ id: 'brain-1', name: 'Personal Brain', kind: 'personal' }] },
  memories: { memories: [{ id: 'memory-1', canonicalText: 'Use pnpm.' }] },
  inbox: { memories: [{ id: 'candidate-1', status: 'candidate' }] },
  agents: { installations: [{ id: 'agent-1', displayName: 'Codex' }] },
  backup: { health: 'ok', integrity: 'ok', schema: { migrations: ['001'] }, brains: [{ id: 'brain-1' }], mounts: [] },
};

const emptyResponses: Record<ConsolePage, unknown> = {
  dashboard: { health: 'ok', integrity: 'ok', schema: { migrations: ['001'] }, brains: [], mounts: [] },
  brains: { brains: [] },
  memories: { memories: [] },
  inbox: { memories: [] },
  agents: { installations: [] },
  backup: { health: 'ok', integrity: 'ok', schema: { migrations: ['001'] }, brains: [], mounts: [] },
};

describe('Console API page states', () => {
  test.each(Object.keys(successfulResponses) as ConsolePage[])('%s has a success state and sends the local setup token header', async (page) => {
    const fake = createFetch([{ body: successfulResponses[page] }]);
    const api = createConsoleApi({ setupToken: 'local-setup-token', fetch: fake.fetch });

    await expect(api.loadPage(page)).resolves.toMatchObject({ status: 'success', data: successfulResponses[page] });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.headers.get('x-memlume-setup-token')).toBe('local-setup-token');
  });

  test.each(Object.keys(emptyResponses) as ConsolePage[])('%s has an explicit empty state', async (page) => {
    const fake = createFetch([{ body: emptyResponses[page] }]);
    const api = createConsoleApi({ setupToken: 'local-setup-token', fetch: fake.fetch });

    await expect(api.loadPage(page)).resolves.toMatchObject({ status: 'empty', data: emptyResponses[page] });
  });

  test.each(Object.keys(successfulResponses) as ConsolePage[])('%s reports a safe error state when the daemon is unavailable', async (page) => {
    const fake = createFetch([{ status: 503, body: { error: 'setup_unavailable' } }]);
    const api = createConsoleApi({ setupToken: 'local-setup-token', fetch: fake.fetch });

    await expect(api.loadPage(page)).resolves.toEqual({ status: 'error', message: '無法讀取資料（HTTP 503）。' });
  });

  test('reports a safe error state when fetch rejects before an HTTP response exists', async () => {
    const api = createConsoleApi({ setupToken: 'local-setup-token', fetch: async () => { throw new TypeError('offline'); } });

    await expect(api.loadPage('brains')).resolves.toEqual({ status: 'error', message: '無法連線到本機 daemon。' });
  });

  test('announces a Dashboard load failure to assistive technology', async () => {
    const wrapper = mount(DashboardView, { props: { api: { loadPage: vi.fn().mockResolvedValue({ status: 'error', message: '無法讀取 Dashboard。' }) } } });
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('無法讀取 Dashboard。');
  });

  test('announces a Brains load failure to assistive technology', async () => {
    const wrapper = mount(BrainsView, { props: { api: { loadPage: vi.fn().mockResolvedValue({ status: 'error', message: '無法讀取 Brain 資料。' }) } } });
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('無法讀取 Brain 資料。');
  });

  test('announces a Memories load failure to assistive technology', async () => {
    const wrapper = mount(MemoriesView, { props: { api: { loadPage: vi.fn().mockResolvedValue({ status: 'error', message: '無法讀取記憶。' }) } } });
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('無法讀取記憶。');
  });

  test('announces an Inbox load failure to assistive technology', async () => {
    const wrapper = mount(InboxView, { props: { api: { loadPage: vi.fn().mockResolvedValue({ status: 'error', message: '無法讀取 Inbox。' }) } } });
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('無法讀取 Inbox。');
  });

  test('announces an Agents load failure to assistive technology', async () => {
    const wrapper = mount(AgentsView, { props: { api: { loadPage: vi.fn().mockResolvedValue({ status: 'error', message: '無法讀取 Agent。' }) } } });
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('無法讀取 Agent。');
  });

  test('announces a Backup load failure to assistive technology', async () => {
    const wrapper = mount(BackupView, { props: { api: { loadPage: vi.fn().mockResolvedValue({ status: 'error', message: '無法讀取備份狀態。' }) } } });
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('無法讀取備份狀態。');
  });

  test('creates a Brain with the in-memory setup token', async () => {
    const fake = createFetch([{ status: 201, body: { brain: { id: 'brain-new', name: 'Frontend', kind: 'domain' } } }]);
    const api = createConsoleApi({ setupToken: 'local-setup-token', fetch: fake.fetch });

    await expect(api.createBrain({ name: 'Frontend', kind: 'domain' })).resolves.toEqual({ id: 'brain-new', name: 'Frontend', kind: 'domain' });
    expect(fake.requests[0]).toMatchObject({ path: '/v1/setup/brains' });
    expect(fake.requests[0]?.headers.get('content-type')).toBe('application/json');
    expect(fake.requests[0]?.headers.get('x-memlume-setup-token')).toBe('local-setup-token');
  });

  test('creates and restores backup bundles through authenticated custom-header requests', async () => {
    const fake = createFetch([{ binary: new Uint8Array([1, 2, 3]) }, { body: { status: 'restored' } }]);
    const api = createConsoleApi({ setupToken: 'local-setup-token', fetch: fake.fetch });
    const bundle = await api.createBackup('backup-password');

    await expect(api.restoreBackup(bundle, 'backup-password')).resolves.toBeUndefined();
    expect(fake.requests.map(({ path }) => path)).toEqual(['/v1/setup/backups', '/v1/setup/backups/restore']);
    expect(fake.requests[0]?.headers.get('x-memlume-setup-token')).toBe('local-setup-token');
    expect(fake.requests[1]?.headers.get('content-type')).toBe('application/vnd.memlume');
  });

  test('governs candidates and Agent mounts through setup-token requests', async () => {
    const fake = createFetch([
      { body: { memory: { id: 'candidate-1', status: 'active' } } },
      { body: { memory: { id: 'candidate-2', status: 'rejected' } } },
      { status: 201, body: { installation: { id: 'agent-1', clientType: 'codex' }, token: 'issued-token' } },
      { status: 201, body: { mount: { brainId: 'brain-1', agentInstallationId: 'agent-1', access: 'read_write' } } },
      { body: { token: 'rotated-token' } },
    ]);
    const api = createConsoleApi({ setupToken: 'local-setup-token', fetch: fake.fetch });

    await expect(api.reviewCandidate('candidate-1', 'approve', '已確認內容。', 'memory-old')).resolves.toMatchObject({ id: 'candidate-1', status: 'active' });
    await expect(api.reviewCandidate('candidate-2', 'reject', '不應共享。')).resolves.toMatchObject({ id: 'candidate-2', status: 'rejected' });
    await expect(api.registerInstallation({ clientType: 'codex', installationId: 'desktop', profileId: 'default' })).resolves.toMatchObject({ token: 'issued-token' });
    await expect(api.mountBrain({ brainId: 'brain-1', agentInstallationId: 'agent-1', access: 'read_write' })).resolves.toMatchObject({ access: 'read_write' });
    await expect(api.rotateToken('agent-1')).resolves.toBe('rotated-token');

    expect(fake.requests.map(({ path }) => path)).toEqual([
      '/v1/setup/inbox/candidate-1/approve',
      '/v1/setup/inbox/candidate-2/reject',
      '/v1/setup/installations',
      '/v1/setup/mounts',
      '/v1/setup/installations/agent-1/token/rotate',
    ]);
    expect(fake.requests[0]?.body).toBe(JSON.stringify({ reason: '已確認內容。', supersedeMemoryId: 'memory-old' }));
    expect(fake.requests.every(({ headers }) => headers.get('x-memlume-setup-token') === 'local-setup-token')).toBe(true);
  });

  test('turns candidate conflict responses into a supersede instruction', async () => {
    const fake = createFetch([{ status: 400, body: { error: 'confirmation_required' } }]);
    const api = createConsoleApi({ setupToken: 'local-setup-token', fetch: fake.fetch });

    await expect(api.reviewCandidate('candidate-1', 'approve', '已確認內容。')).rejects.toThrow('請輸入要取代的 memory ID');
  });

  test('renders Inbox candidates and sends explicit approve and reject actions', async () => {
    const api = {
      loadPage: vi.fn().mockResolvedValue({ status: 'success', data: { memories: [{ id: 'candidate-1', canonicalText: 'Use pnpm.' }] } }),
      reviewCandidate: vi.fn().mockResolvedValue({ id: 'candidate-1' }),
    };
    const wrapper = mount(InboxView, { props: { api } });
    await flushPromises();

    expect(wrapper.text()).toContain('Use pnpm.');
    await wrapper.get('[aria-label="Review reason"]').setValue('已確認內容。');
    await wrapper.get('[aria-label="Supersede memory ID"]').setValue('memory-old');
    await wrapper.get('button.approve').trigger('click');
    await flushPromises();
    await wrapper.get('button.reject').trigger('click');
    await flushPromises();
    expect(api.reviewCandidate).toHaveBeenNthCalledWith(1, 'candidate-1', 'approve', '已確認內容。', 'memory-old');
    expect(api.reviewCandidate).toHaveBeenNthCalledWith(2, 'candidate-1', 'reject', '已確認內容。', undefined);
    expect(wrapper.get('[role="status"]').attributes('aria-live')).toBe('polite');
  });

  test('renders a candidate conflict instruction instead of a generic review failure', async () => {
    const api = {
      loadPage: vi.fn().mockResolvedValue({ status: 'success', data: { memories: [{ id: 'candidate-1', canonicalText: 'Use pnpm.' }] } }),
      reviewCandidate: vi.fn().mockRejectedValue(new Error('此候選與既有記憶衝突，請輸入要取代的 memory ID。')),
    };
    const wrapper = mount(InboxView, { props: { api } });
    await flushPromises();

    await wrapper.get('[aria-label="Review reason"]').setValue('已確認內容。');
    await wrapper.get('button.approve').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('請輸入要取代的 memory ID');
  });

  test('shows every memory UUID and copies it with a selectable fallback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const api = {
      loadPage: vi.fn().mockResolvedValue({ status: 'success', data: { memories: [{ id: 'memory-1', canonicalText: 'Use pnpm.' }] } }),
    };
    const wrapper = mount(MemoriesView, { props: { api } });
    await flushPromises();

    expect(wrapper.get('code.memory-id').text()).toBe('memory-1');
    expect(wrapper.get('code.memory-id').attributes('tabindex')).toBe('0');
    await wrapper.get('button.copy-memory-id').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('memory-1');
    expect(wrapper.text()).toContain('已複製 memory ID');
  });

  test('keeps a memory UUID selectable when clipboard access is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const api = {
      loadPage: vi.fn().mockResolvedValue({ status: 'success', data: { memories: [{ id: 'memory-1', canonicalText: 'Use pnpm.' }] } }),
    };
    const wrapper = mount(MemoriesView, { props: { api } });
    await flushPromises();

    await wrapper.get('button.copy-memory-id').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('請選取並複製 memory ID');
    expect(readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')).toContain('user-select: all');
  });

  test('registers and rotates an Agent token without putting it in the inventory', async () => {
    const api = {
      loadPage: vi.fn().mockResolvedValue({ status: 'success', data: { installations: [{ id: 'agent-1', clientType: 'codex', installationId: 'desktop', profileId: 'default' }] } }),
      registerInstallation: vi.fn().mockResolvedValue({ installation: { id: 'agent-2' }, token: 'new-token' }),
      rotateToken: vi.fn().mockResolvedValue('rotated-token'),
    };
    const wrapper = mount(AgentsView, { props: { api } });
    await flushPromises();

    await wrapper.get('[aria-label="Client type"]').setValue('claude');
    await wrapper.get('[aria-label="Installation ID"]').setValue('desktop');
    await wrapper.get('[aria-label="Profile ID"]').setValue('default');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    await wrapper.get('button.rotate').trigger('click');
    await flushPromises();
    expect(api.registerInstallation).toHaveBeenCalledWith({ clientType: 'claude', installationId: 'desktop', profileId: 'default', displayName: undefined });
    expect(api.rotateToken).toHaveBeenCalledWith('agent-1');
    expect(wrapper.text()).toContain('rotated-token');
    expect(wrapper.get('[role="status"]').attributes('aria-live')).toBe('polite');
  });

  test('mounts a selected Brain for a selected Agent and keeps the mobile table scrollable at 390px', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    const api = {
      loadPage: vi.fn((page: ConsolePage) => Promise.resolve(page === 'brains'
        ? { status: 'success', data: { brains: [{ id: 'brain-1', name: 'Project', kind: 'project' }] } }
        : { status: 'success', data: { installations: [{ id: 'agent-1', clientType: 'codex', installationId: 'desktop', profileId: 'default' }] } })),
      createBrain: vi.fn(),
      mountBrain: vi.fn().mockResolvedValue({ access: 'read' }),
    };
    const wrapper = mount(BrainsView, { props: { api } });
    await flushPromises();

    await wrapper.get('[aria-label="Mount Brain"]').setValue('brain-1');
    await wrapper.get('[aria-label="Mount Agent"]').setValue('agent-1');
    await wrapper.get('[aria-label="Mount access"]').setValue('read');
    await wrapper.get('form.mount-form').trigger('submit');
    await flushPromises();
    expect(api.mountBrain).toHaveBeenCalledWith({ brainId: 'brain-1', agentInstallationId: 'agent-1', access: 'read' });
    expect(wrapper.get('[role="status"]').attributes('aria-live')).toBe('polite');
    expect(window.innerWidth).toBe(390);
    expect(wrapper.find('.table-wrap').exists()).toBe(true);
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
    expect(styles).toContain('@media (max-width: 700px)');
    expect(styles).toContain('overflow-x: auto');
  });

  test('announces Backup completion to assistive technology', async () => {
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn().mockReturnValue('blob:test'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const api = {
      loadPage: vi.fn().mockResolvedValue({ status: 'success', data: { brains: [{ id: 'brain-1' }] } }),
      createBackup: vi.fn().mockResolvedValue(new Uint8Array([1])),
    };
    const wrapper = mount(BackupView, { props: { api } });
    await flushPromises();

    await wrapper.get('input[type="password"]').setValue('backup-password');
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="status"]').attributes('aria-live')).toBe('polite');
    click.mockRestore();
  });
});
