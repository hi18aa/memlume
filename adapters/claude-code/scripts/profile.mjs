import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Use `userConfig` when supplied; otherwise load the private profile created by Memlume CLI. */
export async function hydrateClaudeProfileEnvironment() {
  if (text(process.env.CLAUDE_PLUGIN_OPTION_MEMLUME_HOME) !== undefined) return;
  const corePath = await corePathFromLocalProfile();
  if (corePath === undefined) return;
  const module = await loadAdapterSdkFromRoot(corePath);
  if (typeof module.loadLocalAdapterProfile !== 'function') return;
  const profile = module.loadLocalAdapterProfile('claude-code', { environment: profileEnvironment() });
  if (!isRecord(profile)) return;
  const fields = {
    CLAUDE_PLUGIN_OPTION_MEMLUME_HOME: 'corePath',
    CLAUDE_PLUGIN_OPTION_DAEMON_URL: 'daemonUrl',
    CLAUDE_PLUGIN_OPTION_ADAPTER_TOKEN: 'token',
    CLAUDE_PLUGIN_OPTION_INSTALLATION_ID: 'installationId',
    CLAUDE_PLUGIN_OPTION_PROFILE_ID: 'profileId',
    CLAUDE_PLUGIN_OPTION_PROJECT_ID: 'projectId',
    CLAUDE_PLUGIN_OPTION_BRAIN_ID: 'brainId',
    CLAUDE_PLUGIN_OPTION_WORKSPACE_PATH: 'workspacePath',
    MEMLUME_HOME: 'corePath',
    MEMLUME_DAEMON_URL: 'daemonUrl',
    MEMLUME_TOKEN: 'token',
  };
  for (const [destination, source] of Object.entries(fields)) {
    if (text(process.env[destination]) !== undefined) continue;
    const value = text(profile[source]);
    if (value !== undefined) process.env[destination] = value;
  }
}

async function corePathFromLocalProfile() {
  const configPath = text(process.env.MEMLUME_CONFIG_PATH) ?? join(homedir(), '.config', 'memlume', 'config.json');
  let config;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(config) || !Array.isArray(config.adapters)) return undefined;
  const installationId = text(process.env.CLAUDE_PLUGIN_OPTION_INSTALLATION_ID);
  const profileId = text(process.env.CLAUDE_PLUGIN_OPTION_PROFILE_ID);
  const profile = config.adapters.find((candidate) => (
    isRecord(candidate)
    && candidate.clientType === 'claude-code'
    && (installationId === undefined || candidate.installationId === installationId)
    && (profileId === undefined || candidate.profileId === profileId)
  ));
  return isRecord(profile) ? text(profile.corePath) : undefined;
}

function profileEnvironment() {
  return {
    ...process.env,
    MEMLUME_HOME: text(process.env.CLAUDE_PLUGIN_OPTION_MEMLUME_HOME) ?? process.env.MEMLUME_HOME,
    MEMLUME_DAEMON_URL: text(process.env.CLAUDE_PLUGIN_OPTION_DAEMON_URL) ?? process.env.MEMLUME_DAEMON_URL,
    MEMLUME_TOKEN: text(process.env.CLAUDE_PLUGIN_OPTION_ADAPTER_TOKEN) ?? process.env.MEMLUME_TOKEN,
    MEMLUME_INSTALLATION_ID: text(process.env.CLAUDE_PLUGIN_OPTION_INSTALLATION_ID) ?? process.env.MEMLUME_INSTALLATION_ID,
    MEMLUME_PROFILE_ID: text(process.env.CLAUDE_PLUGIN_OPTION_PROFILE_ID) ?? process.env.MEMLUME_PROFILE_ID,
    MEMLUME_PROJECT_ID: text(process.env.CLAUDE_PLUGIN_OPTION_PROJECT_ID) ?? process.env.MEMLUME_PROJECT_ID,
    MEMLUME_BRAIN_ID: text(process.env.CLAUDE_PLUGIN_OPTION_BRAIN_ID) ?? process.env.MEMLUME_BRAIN_ID,
  };
}

async function loadAdapterSdkFromRoot(root) {
  const safeRoot = await realpath(root);
  const entry = await realpath(resolve(safeRoot, 'packages', 'adapter-sdk', 'dist', 'index.js'));
  if (!isInside(safeRoot, entry)) throw new Error('Memlume Core is unavailable.');
  return import(pathToFileURL(entry).href);
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInside(root, file) {
  const path = relative(root, file);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
