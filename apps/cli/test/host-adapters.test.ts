import { describe, expect, test } from 'vitest';

import { activationMessage, detectHost, hostCommands, installHost, type HostRuntime } from '../src/host-adapters.js';

function fakeRuntime(calls: string[] = [], detected = true): HostRuntime {
  return {
    async run(command, args) {
      calls.push([command, ...args].join(' '));
      return { code: detected ? 0 : 1, stdout: '', stderr: '' };
    },
    async pathExists() { return true; },
    async mkdir() { return true; },
    async copyDirectory() {},
    async removeDirectory() {},
  };
}

describe('host adapter abstraction', () => {
  test('keeps host-specific commands and activation guidance explicit', () => {
    expect(hostCommands({ clientType: 'codex', corePath: 'C:/memlume', homePath: 'C:/Users/me' })).toEqual([
      { command: 'codex', args: ['plugin', 'marketplace', 'add', 'C:/memlume'] },
      { command: 'codex', args: ['plugin', 'add', 'memlume-codex@memlume'] },
      { command: 'codex', args: ['plugin', 'list', '--json'] },
    ]);
    expect(activationMessage('claude-code')).toContain('/reload-plugins');
    expect(activationMessage('codex')).toContain('/hooks');
  });

  test('detects a host through an injected runner and installs idempotently', async () => {
    const calls: string[] = [];
    const result = await installHost({ clientType: 'openclaw', corePath: 'C:/memlume', homePath: 'C:/Users/me' }, fakeRuntime(calls));
    expect(result.detected).toBe(true);
    expect(calls[0]).toBe('openclaw --version');
    expect(calls).toContain('openclaw plugins inspect memlume-openclaw --runtime --json');
    await expect(detectHost('hermes', fakeRuntime([], false))).resolves.toBe(false);
  });
});
