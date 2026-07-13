import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Fill missing Codex Plugin settings from the private profile created by `memlume setup adapter`. */
export async function hydrateProfileEnvironment(clientType) {
  if (text(process.env.MEMLUME_HOME) !== undefined) return;
  const corePath = await corePathFromLocalProfile(clientType);
  if (corePath === undefined) return;
  const module = await loadAdapterSdkFromRoot(corePath);
  if (typeof module.loadLocalAdapterProfile !== 'function') return;
  const profile = module.loadLocalAdapterProfile(clientType);
  if (!isRecord(profile)) return;
  const fields = {
    MEMLUME_INSTALLATION_ID: 'installationId',
    MEMLUME_PROFILE_ID: 'profileId',
    MEMLUME_PROJECT_ID: 'projectId',
    MEMLUME_BRAIN_ID: 'brainId',
    MEMLUME_TOKEN: 'token',
    MEMLUME_HOME: 'corePath',
    MEMLUME_DAEMON_URL: 'daemonUrl',
    MEMLUME_WORKSPACE_PATH: 'workspacePath',
    MEMLUME_OUTBOX_DIRECTORY: 'outboxDirectory',
  };
  for (const [destination, source] of Object.entries(fields)) {
    if (text(process.env[destination]) !== undefined) continue;
    const value = text(profile[source]);
    if (value !== undefined) process.env[destination] = value;
  }
}

async function corePathFromLocalProfile(clientType) {
  const configPath = text(process.env.MEMLUME_CONFIG_PATH) ?? join(homedir(), '.config', 'memlume', 'config.json');
  let config;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(config) || !Array.isArray(config.adapters)) return undefined;
  const installationId = text(process.env.MEMLUME_INSTALLATION_ID);
  const profileId = text(process.env.MEMLUME_PROFILE_ID);
  const profile = config.adapters.find((candidate) => (
    isRecord(candidate)
    && candidate.clientType === clientType
    && (installationId === undefined || candidate.installationId === installationId)
    && (profileId === undefined || candidate.profileId === profileId)
  ));
  return isRecord(profile) ? text(profile.corePath) : undefined;
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
