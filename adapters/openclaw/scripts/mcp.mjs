import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

try {
  const root = process.env.MEMLUME_HOME;
  if (typeof root !== 'string' || root.trim() === '') throw new Error('Memlume Core is unavailable.');
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

function isInside(root, file) {
  const path = relative(root, file);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
