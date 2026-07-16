import { join } from 'node:path';

export type HostType = 'codex' | 'claude-code' | 'hermes' | 'openclaw';

export interface HostAdapterProfile {
  readonly clientType: HostType;
  readonly corePath: string;
  readonly homePath: string;
}

export interface HostCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface HostRuntime {
  run(command: string, args: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
  pathExists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<boolean>;
  copyDirectory(source: string, destination: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
}

export interface HostInstallationResult {
  readonly clientType: HostType;
  readonly detected: boolean;
  readonly commands: readonly HostCommand[];
  readonly activation: string;
}

export const HOST_TYPES: readonly HostType[] = ['codex', 'claude-code', 'hermes', 'openclaw'];

export function hostCommands(profile: HostAdapterProfile): readonly HostCommand[] {
  const adapterRoot = join(profile.corePath, 'adapters', profile.clientType);
  switch (profile.clientType) {
    case 'codex':
      return [
        { command: 'codex', args: ['plugin', 'marketplace', 'add', profile.corePath] },
        { command: 'codex', args: ['plugin', 'add', 'memlume-codex@memlume'] },
        { command: 'codex', args: ['plugin', 'list', '--json'] },
      ];
    case 'claude-code':
      return [
        { command: 'claude', args: ['plugin', 'marketplace', 'add', profile.corePath] },
        { command: 'claude', args: ['plugin', 'install', 'memlume-claude-code@memlume'] },
        { command: 'claude', args: ['plugin', 'list'] },
      ];
    case 'hermes':
      return [
        { command: 'hermes', args: ['plugins', 'enable', 'memlume'] },
        { command: 'hermes', args: ['plugins', 'list'] },
      ];
    case 'openclaw':
      return [
        { command: 'openclaw', args: ['plugins', 'install', adapterRoot] },
        { command: 'openclaw', args: ['plugins', 'enable', 'memlume-openclaw'] },
        { command: 'openclaw', args: ['gateway', 'restart'] },
        { command: 'openclaw', args: ['plugins', 'inspect', 'memlume-openclaw', '--runtime', '--json'] },
      ];
  }
}

export function activationMessage(clientType: HostType): string {
  switch (clientType) {
    case 'codex':
      return 'Codex：安裝後請在 /hooks 檢查並信任 Memlume hooks。';
    case 'claude-code':
      return 'Claude Code：/hooks 僅供檢視；請重啟 Claude 或執行 /reload-plugins。';
    case 'hermes':
      return 'Hermes：重新啟動 Hermes，確認 memlume plugin 已啟用。';
    case 'openclaw':
      return 'OpenClaw：等待 gateway restart 後以 runtime inspect 確認啟用。';
  }
}

export async function detectHost(clientType: HostType, runtime: Pick<HostRuntime, 'run'>): Promise<boolean> {
  const command = clientType === 'claude-code' ? 'claude' : clientType;
  try {
    return (await runtime.run(command, ['--version'])).code === 0;
  } catch {
    return false;
  }
}

export async function installHost(profile: HostAdapterProfile, runtime: HostRuntime): Promise<HostInstallationResult> {
  const detected = await detectHost(profile.clientType, runtime);
  if (!detected) {
    throw new Error(`${profile.clientType} host was not detected.`);
  }
  const commands = hostCommands(profile);
  if (profile.clientType === 'hermes') {
    const destination = join(profile.homePath, '.hermes', 'plugins', 'memlume');
    if (!(await runtime.pathExists(destination))) {
      await runtime.mkdir(join(profile.homePath, '.hermes', 'plugins'));
      await runtime.copyDirectory(join(profile.corePath, 'adapters', 'hermes'), destination);
    }
  }
  for (const command of commands) {
    const result = await runtime.run(command.command, command.args);
    if (result.code !== 0) {
      throw new Error(`${profile.clientType} host command failed: ${command.command}.`);
    }
  }
  return { clientType: profile.clientType, detected, commands, activation: activationMessage(profile.clientType) };
}
