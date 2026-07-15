import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { TextDecoder } from 'node:util';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import {
  BrainRecordSchema,
  UuidV7Schema,
  type BrainRecord,
  type SemanticRecord,
} from '@memlume/contracts';

type DirectoryEntry = Dirent<string>;

export type MarkdownRecordStoreOptions = {
  readonly rootDir: string;
  readonly brainId?: string;
};

/**
 * Markdown is the append-only authority for a Brain. SQLite projection is a
 * separate concern and must never overwrite these files.
 */
export class MarkdownRecordStore {
  private readonly rootDir: string;
  private readonly brainsDir: string;
  private readonly brainId?: string;

  constructor(options: MarkdownRecordStoreOptions) {
    if (typeof options.rootDir !== 'string' || options.rootDir.trim().length === 0) {
      throw new Error('rootDir is required.');
    }
    if (isAbsolute(options.rootDir) === false) {
      throw new Error('Storage rootDir must be absolute.');
    }
    this.rootDir = resolve(options.rootDir);
    this.brainsDir = join(this.rootDir, 'brains');
    this.brainId = options.brainId === undefined ? undefined : parseBrainId(options.brainId);
    ensureDirectory(this.rootDir);
  }

  append(input: BrainRecord): BrainRecord {
    const record = parseRecord(input);
    if (!('brainId' in record)) {
      throw new Error('record_conflict: a Brain record must have a brainId.');
    }
    const brainId = parseBrainId(record.brainId);
    if (this.brainId !== undefined && brainId !== this.brainId) {
      throw new Error('Brain mismatch: record does not belong to this store.');
    }

    const existingPath = this.findRecordPath(record.recordId);
    const targetPath = this.recordPath(record);
    const canonical = canonicalJson(record);
    const checksum = checksumFor(canonical);

    if (existingPath !== undefined) {
      const existing = readStoredRecord(existingPath);
      if (existing.checksum === checksum && existing.record.recordId === record.recordId) {
        return existing.record;
      }
      throw new Error(`record_conflict: record ${record.recordId} already exists with different content.`);
    }

    ensureDirectory(dirname(targetPath));
    const file = renderRecord(canonical, checksum);
    atomicWrite(targetPath, file);
    return record;
  }

  read(recordId: string): BrainRecord | undefined {
    const id = parseRecordId(recordId);
    const path = this.findRecordPath(id);
    if (path === undefined) {
      return undefined;
    }
    const record = readStoredRecord(path).record;
    if (record.recordId !== id) {
      throw new Error(`Record integrity failure: file name does not match ${id}.`);
    }
    if ('brainId' in record && this.brainId !== undefined && record.brainId !== this.brainId) {
      throw new Error('Brain mismatch: record does not belong to this store.');
    }
    return record;
  }

  list(brainId?: string): BrainRecord[] {
    const selectedBrainId = brainId === undefined ? undefined : parseBrainId(brainId);
    if (this.brainId !== undefined && selectedBrainId !== undefined && selectedBrainId !== this.brainId) {
      throw new Error('Brain mismatch: requested Brain is not bound to this store.');
    }

    const records: BrainRecord[] = [];
    if (!existsSync(this.brainsDir)) {
      return records;
    }
    const brains = this.brainId === undefined ? listDirectories(this.brainsDir) : [this.brainId];
    for (const brain of brains) {
      const brainDir = join(this.brainsDir, brain);
      if (!existsSync(brainDir)) {
        continue;
      }
      assertRegularDirectory(brainDir);
      if (selectedBrainId !== undefined && brain !== selectedBrainId) {
        continue;
      }
      const recordsDir = join(brainDir, 'records');
      if (!existsSync(recordsDir)) {
        continue;
      }
      walk(recordsDir, (path) => {
        if (!path.endsWith('.md')) {
          return;
        }
        const stored = readStoredRecord(path);
        assertRecordPathBinding(path, stored.record, this.brainsDir);
        records.push(stored.record);
      });
    }
    records.sort((left, right) => {
      const leftCreated = 'createdAt' in left ? left.createdAt : '';
      const rightCreated = 'createdAt' in right ? right.createdAt : '';
      return leftCreated.localeCompare(rightCreated) || left.recordId.localeCompare(right.recordId);
    });
    return records;
  }

  ensureBrainDocument(brainId: string, metadata: { readonly name?: string } = {}): string {
    const id = parseBrainId(brainId);
    if (this.brainId !== undefined && id !== this.brainId) {
      throw new Error('Brain mismatch: document does not belong to this store.');
    }
    const brainDir = join(this.brainsDir, id);
    ensureDirectory(brainDir);
    const path = join(brainDir, 'brain.md');
    if (!existsSync(path)) {
      const name = typeof metadata.name === 'string' && metadata.name.trim().length > 0 ? metadata.name.trim() : id;
      atomicWrite(
        path,
        `# Memlume Brain\n\n- Brain ID: ${id}\n- Name: ${name}\n- Authority: records under \`records/\`.\n`,
      );
    } else {
      assertRegularFile(path);
    }
    return path;
  }

  private recordPath(record: SemanticRecord | Exclude<BrainRecord, SemanticRecord | { brainId: never }>): string {
    const createdAt = 'createdAt' in record ? record.createdAt : new Date().toISOString();
    const brainId = 'brainId' in record ? parseBrainId(record.brainId) : undefined;
    if (brainId === undefined) {
      throw new Error('record_conflict: a Brain record must have a brainId.');
    }
    const year = createdAt.slice(0, 4);
    const month = createdAt.slice(5, 7);
    return join(this.brainsDir, brainId, 'records', year, month, `${parseRecordId(record.recordId)}.md`);
  }

  private findRecordPath(recordId: string): string | undefined {
    const target = parseRecordId(recordId);
    if (!existsSync(this.brainsDir)) {
      return undefined;
    }
    const brains = this.brainId === undefined ? listDirectories(this.brainsDir) : [this.brainId];
    for (const brain of brains) {
      const brainDir = join(this.brainsDir, brain);
      if (!existsSync(brainDir)) {
        continue;
      }
      assertRegularDirectory(brainDir);
      const recordsDir = join(brainDir, 'records');
      if (!existsSync(recordsDir)) {
        continue;
      }
      let found: string | undefined;
      walk(recordsDir, (path) => {
        if (found !== undefined || basename(path) !== `${target}.md`) {
          return;
        }
        const stored = readStoredRecord(path);
        assertRecordPathBinding(path, stored.record, this.brainsDir);
        found = path;
      });
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
}

function parseBrainId(value: string): string {
  return UuidV7Schema.parse(value);
}

function parseRecordId(value: string): string {
  return UuidV7Schema.parse(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

function checksumFor(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function renderRecord(canonical: string, checksum: string): string {
  return `---\n${canonical}\n---\n<!-- memlume-sha256:${checksum} -->\n`;
}

function readStoredRecord(path: string): { readonly record: BrainRecord; readonly checksum: string } {
  assertRegularFile(path);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    throw new Error(`Invalid UTF-8 record: ${path}`, { cause: error });
  }
  const match = /^---\n([\s\S]*?)\n---\n<!-- memlume-sha256:([0-9a-f]{64}) -->\n?$/.exec(text);
  if (match === null) {
    throw new Error(`Invalid Markdown record format: ${path}`);
  }
  const canonical = match[1];
  const checksum = match[2];
  if (checksumFor(canonical) !== checksum) {
    throw new Error(`Record checksum/integrity failure: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical);
  } catch (error) {
    throw new Error(`Invalid record JSON: ${path}`, { cause: error });
  }
  const record = parseRecord(parsed);
  return { record, checksum };
}

function assertRecordPathBinding(path: string, record: BrainRecord, brainsDir: string): void {
  if (!('brainId' in record) || typeof record.brainId !== 'string') {
    throw new Error(`Record integrity failure: ${path} has no Brain binding.`);
  }
  const brainId = parseBrainId(record.brainId);
  const recordId = parseRecordId(record.recordId);
  const createdAt = 'createdAt' in record ? record.createdAt : undefined;
  if (createdAt === undefined) {
    throw new Error(`Record integrity failure: ${path} has no creation timestamp.`);
  }
  const expected = join(
    brainsDir,
    brainId,
    'records',
    createdAt.slice(0, 4),
    createdAt.slice(5, 7),
    `${recordId}.md`,
  );
  if (samePath(path, expected) === false || basename(path) !== `${recordId}.md`) {
    throw new Error(`Record integrity failure: path is not bound to Brain ${brainId} and record ${recordId}.`);
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function parseRecord(input: unknown): BrainRecord {
  try {
    return BrainRecordSchema.parse(input);
  } catch (error) {
    throw new Error(`Invalid record: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function atomicWrite(path: string, content: string): void {
  const parent = dirname(path);
  ensureDirectory(parent);
  const tempPath = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tempPath, 'wx', 0o600);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tempPath, path);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
  }
}

function ensureDirectory(path: string): void {
  const absolute = resolve(path);
  if (isAbsolute(path) === false) {
    throw new Error('Storage path must be absolute.');
  }
  let current = absolute;
  while (current !== dirname(current)) {
    if (existsSync(current)) {
      assertRegularDirectory(current);
    }
    current = dirname(current);
  }
  mkdirSync(absolute, { recursive: true });
  assertRegularDirectory(absolute);
}

function assertRegularDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Storage path escapes root through symlink: ${path}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Expected storage directory: ${path}`);
  }
}

function assertRegularFile(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Storage record escapes root through symlink: ${path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Expected storage file: ${path}`);
  }
}

function listDirectories(path: string): string[] {
  assertRegularDirectory(path);
  return (readdirSync(path, { withFileTypes: true }) as DirectoryEntry[])
    .filter((entry) => {
      if (entry.isSymbolicLink()) {
        throw new Error(`Storage path escapes root through symlink: ${join(path, entry.name)}`);
      }
      return entry.isDirectory();
    })
    .map((entry) => entry.name)
    .sort();
}

function walk(path: string, visitor: (path: string) => void): void {
  assertRegularDirectory(path);
  for (const entry of readdirSync(path, { withFileTypes: true }) as DirectoryEntry[]) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Storage path escapes root through symlink: ${child}`);
    }
    if (entry.isDirectory()) {
      walk(child, visitor);
    } else if (entry.isFile()) {
      visitor(child);
    }
  }
}
