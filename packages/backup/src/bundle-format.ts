import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { redactSensitiveText } from '@memlume/contracts';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const AUTHORITY_PREFIXES = ['brains/', 'inbox/'];
const ALLOWED_TOP_LEVEL = new Set(['manifest.json', 'checksums.json', 'bindings.json', 'memlume.sqlite']);

export type MarkdownBundleManifest = {
  readonly format: 'memlume';
  readonly formatVersion: 3;
  readonly createdAt: string;
  readonly files: readonly string[];
  readonly projectionDigest?: string;
  readonly encrypted?: boolean;
};

export type CreateMarkdownBundleOptions = {
  readonly dataRoot: string;
  readonly snapshot?: Uint8Array;
  readonly bindings?: unknown;
};

export type VerifiedMarkdownBundle = {
  readonly manifest: MarkdownBundleManifest;
  readonly files: Readonly<Record<string, Uint8Array>>;
};

/** Build a v3 bundle from Markdown authority files and optional SQLite projection. */
export async function createMarkdownBundle(options: CreateMarkdownBundleOptions): Promise<Uint8Array> {
  const root = await realpath(options.dataRoot);
  const entries: Record<string, Uint8Array> = {};
  for (const directory of ['brains', 'inbox']) {
    await collectAuthorityFiles(root, resolve(root, directory), directory, entries);
  }
  if (options.bindings !== undefined) {
    const bindings = canonicalJson(options.bindings);
    if (containsCredentialKey(bindings) || redactSensitiveText(bindings).detected) {
      throw new Error('Backup bindings contain sensitive material.');
    }
    entries['bindings.json'] = strToU8(bindings);
  }
  if (options.snapshot !== undefined) {
    entries['memlume.sqlite'] = Uint8Array.from(options.snapshot);
  }
  const checksums = Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)).map(([name, bytes]) => [name, sha256(bytes)]));
  const manifest: MarkdownBundleManifest = {
    format: 'memlume',
    formatVersion: 3,
    createdAt: new Date().toISOString(),
    files: Object.keys(checksums),
    ...(options.snapshot === undefined ? {} : { projectionDigest: sha256(options.snapshot) }),
  };
  return zipSync({
    'manifest.json': strToU8(canonicalJson(manifest)),
    'checksums.json': strToU8(canonicalJson(checksums)),
    ...entries,
  });
}

/** Verify and return a v3 bundle without writing anything to the live data root. */
export function verifyMarkdownBundle(bundle: Uint8Array): VerifiedMarkdownBundle {
  if (bundle.byteLength > MAX_TOTAL_BYTES) throw new Error('Backup compressed size exceeds the safety limit.');
  const unzipped = unzipSync(bundle, {
    filter(file) {
      if (file.name !== 'manifest.json' && file.name !== 'checksums.json' && file.name !== 'bindings.json' && file.name !== 'memlume.sqlite' && !isAuthorityPath(file.name)) {
        throw new Error('Unexpected backup entry.');
      }
      if (!Number.isSafeInteger(file.originalSize) || file.originalSize > MAX_FILE_BYTES) {
        throw new Error('Backup entry exceeds the safety limit.');
      }
      return true;
    },
  });
  const manifest = parseManifest(unzipped['manifest.json']);
  const checksums = parseChecksums(unzipped['checksums.json']);
  const listed = new Set(manifest.files);
  for (const name of Object.keys(checksums)) {
    if (!listed.has(name) || unzipped[name] === undefined) throw new Error('Backup checksum listing mismatch.');
    if (sha256(unzipped[name]!) !== checksums[name]) throw new Error('Backup checksum verification failed.');
  }
  if (listed.size !== Object.keys(checksums).length) throw new Error('Backup checksum listing mismatch.');
  if (unzipped['memlume.sqlite'] !== undefined && manifest.projectionDigest !== sha256(unzipped['memlume.sqlite'])) {
    throw new Error('Backup projection digest verification failed.');
  }
  for (const name of Object.keys(unzipped)) {
    if (name !== 'manifest.json' && name !== 'checksums.json' && !listed.has(name)) {
      throw new Error('Backup contains an unlisted entry.');
    }
  }
  return { manifest, files: unzipped };
}

async function collectAuthorityFiles(root: string, directory: string, prefix: string, output: Record<string, Uint8Array>): Promise<void> {
  let entries;
  try {
    entries = await (await import('node:fs/promises')).readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    const relativePath = `${prefix}/${entry.name}`.replaceAll('\\', '/');
    if (entry.isSymbolicLink()) throw new Error('Backup does not allow symlink entries.');
    if (entry.isDirectory()) {
      await collectAuthorityFiles(root, absolute, relativePath, output);
      continue;
    }
    if (!entry.isFile() || !isAuthorityPath(relativePath)) continue;
    const canonical = await realpath(absolute);
    if (!isInside(root, canonical)) throw new Error('Backup path escapes data root.');
    const bytes = await readFile(canonical);
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('Backup entry exceeds the safety limit.');
    if (redactSensitiveText(bytes.toString('utf8')).detected) throw new Error('Backup authority record contains sensitive material.');
    output[relativePath] = bytes;
  }
}

function containsCredentialKey(value: string): boolean {
  return /["'](?:token|password|secret|api[_-]?key|authorization)["']\s*:/iu.test(value);
}

function isAuthorityPath(value: string): boolean {
  if (value.includes('\\') || value.includes('\0') || isAbsolute(value) || value.split('/').includes('..')) return false;
  return AUTHORITY_PREFIXES.some((prefix) => value.startsWith(prefix)) && value.endsWith('.md');
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function parseManifest(value: Uint8Array | undefined): MarkdownBundleManifest {
  if (value === undefined) throw new Error('Invalid Memlume backup bundle.');
  let parsed: unknown;
  try { parsed = JSON.parse(strFromU8(value)); } catch { throw new Error('Invalid Memlume backup manifest.'); }
  if (parsed === null || typeof parsed !== 'object') throw new Error('Invalid Memlume backup manifest.');
  const manifest = parsed as Partial<MarkdownBundleManifest>;
  if (manifest.format !== 'memlume' || manifest.formatVersion !== 3 || !Array.isArray(manifest.files) || !manifest.files.every((name) => typeof name === 'string' && isAuthorityPath(name) || name === 'bindings.json' || name === 'memlume.sqlite')) {
    throw new Error('Invalid Memlume backup manifest.');
  }
  return manifest as MarkdownBundleManifest;
}

function parseChecksums(value: Uint8Array | undefined): Record<string, string> {
  if (value === undefined) throw new Error('Invalid Memlume backup checksum manifest.');
  let parsed: unknown;
  try { parsed = JSON.parse(strFromU8(value)); } catch { throw new Error('Invalid Memlume backup checksum manifest.'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid Memlume backup checksum manifest.');
  const result: Record<string, string> = {};
  for (const [name, digest] of Object.entries(parsed)) {
    if ((isAuthorityPath(name) || name === 'bindings.json' || name === 'memlume.sqlite') && typeof digest === 'string' && /^[0-9a-f]{64}$/u.test(digest)) result[name] = digest;
    else throw new Error('Invalid Memlume backup checksum manifest.');
  }
  return result;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
