import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { hydrateClaudeProfileEnvironment } from './profile.mjs';

void start();

async function start() {
  try {
    await hydrateClaudeProfileEnvironment();
    const root = text(process.env.MEMLUME_HOME);
    if (root === undefined) throw new Error('Memlume Core is unavailable.');
    const safeRoot = await realpath(root);
    const entry = await realpath(resolve(safeRoot, 'apps', 'mcp-server', 'dist', 'index.js'));
    if (!isInside(safeRoot, entry)) throw new Error('Memlume Core is unavailable.');
    const module = await import(pathToFileURL(entry).href);
    if (typeof module.main !== 'function') throw new Error('Memlume Core is unavailable.');
    await module.main();
  } catch {
    process.stderr.write('Memlume MCP is unavailable.\n');
    process.exitCode = 1;
  }
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function isInside(root, file) {
  const path = relative(root, file);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
