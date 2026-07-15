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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  BrainRecordSchema,
  IsoUtcDateTimeSchema,
  NonEmptyTextSchema,
  RoutingInboxRecordSchema,
  UuidV7Schema,
  type BrainRecord,
  type RoutingInboxRecord,
} from '@memlume/contracts';

type DirectoryEntry = Dirent<string>;

export type RoutingInboxStoreOptions = {
  readonly rootDir: string;
};

export type RoutingInboxResolvedRecord = {
  readonly recordType: 'routing_resolution';
  readonly schemaVersion: string;
  readonly recordId: string;
  readonly resolvedRecordId: string;
  readonly targetRecordType: string;
  readonly targetBrainId: string;
  readonly captureId: string;
  readonly atomKey: string;
  readonly statement: string;
  readonly evidenceRef: string;
  readonly resolvedAt: string;
  readonly targetRef?: string;
};

export type RoutingInboxQuarantineMetadata = {
  readonly intendedTargetRef?: string;
  readonly conflictWithRecordId?: string;
};

export type RoutingInboxQuarantineRecord = {
  readonly recordType: 'routing_quarantine';
  readonly schemaVersion: string;
  readonly recordId: string;
  readonly captureId: string;
  readonly atomKey: string;
  readonly statement: string;
  readonly evidenceRef: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly targetRef?: string;
  readonly intendedTargetRef?: string;
  readonly conflictWithRecordId?: string;
};

const STATUS_DIRECTORIES = ['pending', 'resolved', 'quarantine'] as const;
type StatusDirectory = (typeof STATUS_DIRECTORIES)[number];

/**
 * Durable local queue for atoms whose Brain cannot be selected safely yet.
 * Inbox records intentionally have no brainId; only the explicit resolve call
 * may attach one through the injected append callback.
 */
export class RoutingInboxStore {
  private readonly rootDir: string;
  private readonly inboxDir: string;

  constructor(options: RoutingInboxStoreOptions) {
    if (typeof options.rootDir !== 'string' || options.rootDir.trim().length === 0) {
      throw new Error('rootDir is required.');
    }
    if (isAbsolute(options.rootDir) === false) {
      throw new Error('Storage rootDir must be absolute.');
    }
    this.rootDir = resolve(options.rootDir);
    ensureDirectory(this.rootDir);
    this.inboxDir = join(this.rootDir, 'inbox');
    ensureDirectory(this.inboxDir);
    for (const status of STATUS_DIRECTORIES) {
      ensureDirectory(this.statusDirectory(status));
    }
  }

  addPending(input: RoutingInboxRecord): RoutingInboxRecord {
    const item = parsePending(input);
    const path = this.recordPath('pending', item.recordId);
    const existing = this.readOptional(path, parsePending);
    if (existing !== undefined) {
      if (checksumFor(canonicalJson(existing)) === checksumFor(canonicalJson(item))) {
        return existing;
      }
      throw new Error(`record_conflict: pending record ${item.recordId} already exists with different content.`);
    }
    if (this.readOptional(this.recordPath('resolved', item.recordId), parseResolved) !== undefined) {
      throw new Error(`record_conflict: record ${item.recordId} is already resolved.`);
    }
    if (this.readOptional(this.recordPath('quarantine', item.recordId), parseQuarantine) !== undefined) {
      throw new Error(`record_conflict: record ${item.recordId} is quarantined.`);
    }
    atomicWrite(path, renderRecord(canonicalJson(item)));
    return item;
  }

  readPending(recordId: string): RoutingInboxRecord | undefined {
    return this.readOptional(this.recordPath('pending', recordId), parsePending);
  }

  listPending(): RoutingInboxRecord[] {
    return this.list('pending', parsePending).sort(compareByCreatedAt);
  }

  listResolved(): RoutingInboxResolvedRecord[] {
    return this.list('resolved', parseResolved).sort(
      (left, right) => left.resolvedAt.localeCompare(right.resolvedAt) || left.recordId.localeCompare(right.recordId),
    );
  }

  listQuarantine(): RoutingInboxQuarantineRecord[] {
    return this.list('quarantine', parseQuarantine).sort(compareByCreatedAt);
  }

  resolve(
    recordId: string,
    targetRecord: BrainRecord,
    appendBrainRecord: (record: BrainRecord) => void,
  ): RoutingInboxResolvedRecord {
    const id = parseRecordId(recordId);
    const resolvedPath = this.recordPath('resolved', id);
    const alreadyResolved = this.readOptional(resolvedPath, parseResolved);
    if (alreadyResolved !== undefined) {
      return alreadyResolved;
    }

    const pendingPath = this.recordPath('pending', id);
    const pending = this.readOptional(pendingPath, parsePending);
    if (pending === undefined) {
      throw new Error(`Routing Inbox record ${id} was not found in pending.`);
    }

    const target = parseBrainRecord(targetRecord);
    if (!('brainId' in target) || typeof target.brainId !== 'string') {
      throw new Error('resolve requires a Brain-bound target record; Inbox does not infer a target Brain.');
    }

    // The callback is deliberately before any resolved marker is written.
    // A thrown append leaves the pending item available for a safe retry.
    appendBrainRecord(target);

    const resolved: RoutingInboxResolvedRecord = {
      recordType: 'routing_resolution',
      schemaVersion: pending.schemaVersion,
      recordId: pending.recordId,
      resolvedRecordId: target.recordId,
      targetRecordType: target.recordType,
      targetBrainId: target.brainId,
      captureId: pending.captureId,
      atomKey: pending.atomKey,
      statement: pending.statement,
      evidenceRef: pending.evidenceRef,
      resolvedAt: new Date().toISOString(),
      ...(pending.targetRef === undefined ? {} : { targetRef: pending.targetRef }),
    };

    // Move the durable pending file first, then atomically replace its content
    // with the strict resolution envelope. The callback has already succeeded.
    const staged = writeTempFile(resolvedPath, renderRecord(canonicalJson(resolved)));
    try {
      assertRegularFileOrMissing(resolvedPath);
      renameSync(pendingPath, resolvedPath);
      replaceFromTemp(resolvedPath, staged);
    } catch (error) {
      if (existsSync(staged)) {
        unlinkSync(staged);
      }
      throw error;
    }
    return resolved;
  }

  quarantine(
    input: RoutingInboxRecord,
    reason: string,
    metadata: RoutingInboxQuarantineMetadata = {},
  ): RoutingInboxQuarantineRecord {
    const item = parsePending(input);
    const parsedReason = NonEmptyTextSchema.parse(reason);
    const intendedTargetRef = metadata.intendedTargetRef === undefined
      ? item.targetRef
      : NonEmptyTextSchema.parse(metadata.intendedTargetRef);
    const conflictWithRecordId = metadata.conflictWithRecordId === undefined
      ? undefined
      : parseRecordId(metadata.conflictWithRecordId);
    const path = this.recordPath('quarantine', item.recordId);
    const existing = this.readOptional(path, parseQuarantine);
    if (existing !== undefined) {
      const candidate = makeQuarantine(item, parsedReason, { intendedTargetRef, conflictWithRecordId }, existing.updatedAt);
      if (canonicalJson(existing) === canonicalJson(candidate)) {
        return existing;
      }
      throw new Error(`record_conflict: quarantine record ${item.recordId} already exists with different content.`);
    }

    const quarantined = makeQuarantine(item, parsedReason, { intendedTargetRef, conflictWithRecordId });
    atomicWrite(path, renderRecord(canonicalJson(quarantined)));
    const pendingPath = this.recordPath('pending', item.recordId);
    if (pathExists(pendingPath)) {
      assertRegularFile(pendingPath);
      unlinkSync(pendingPath);
    }
    return quarantined;
  }

  private statusDirectory(status: StatusDirectory): string {
    const directory = join(this.inboxDir, status);
    assertContained(this.inboxDir, directory);
    assertNoSymlinkBetween(directory, this.rootDir);
    return directory;
  }

  private recordPath(status: StatusDirectory, recordId: string): string {
    const id = parseRecordId(recordId);
    const directory = this.statusDirectory(status);
    const path = join(directory, `${id}.md`);
    assertContained(this.inboxDir, path);
    assertNoSymlinkBetween(path, this.rootDir);
    return path;
  }

  private readOptional<T>(path: string, parser: (input: unknown) => T): T | undefined {
    if (!pathExists(path)) {
      return undefined;
    }
    const parsed = readStored(path, parser);
    assertRecordIdBinding(path, parsed);
    return parsed;
  }

  private list<T>(status: StatusDirectory, parser: (input: unknown) => T): T[] {
    const directory = this.statusDirectory(status);
    assertRegularDirectory(directory);
    const entries = readdirSync(directory, { withFileTypes: true }) as DirectoryEntry[];
    const results: T[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Storage path escapes root through symlink: ${path}`);
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        continue;
      }
      const id = parseRecordId(basename(entry.name, '.md'));
      if (this.recordPath(status, id) !== path) {
        throw new Error(`Storage path is not confined to the Inbox: ${path}`);
      }
      const parsed = readStored(path, parser);
      assertRecordIdBinding(path, parsed);
      results.push(parsed);
    }
    return results;
  }
}

function parseRecordId(value: unknown): string {
  return UuidV7Schema.parse(value);
}

function parsePending(input: unknown): RoutingInboxRecord {
  return RoutingInboxRecordSchema.parse(input);
}

function parseBrainRecord(input: unknown): BrainRecord {
  return BrainRecordSchema.parse(input);
}

function parseResolved(input: unknown): RoutingInboxResolvedRecord {
  const object = strictObject(input, [
    'recordType',
    'schemaVersion',
    'recordId',
    'resolvedRecordId',
    'targetRecordType',
    'targetBrainId',
    'captureId',
    'atomKey',
    'statement',
    'evidenceRef',
    'resolvedAt',
    'targetRef',
  ]);
  if (object.recordType !== 'routing_resolution') {
    throw new Error('Invalid routing resolution record type.');
  }
  const result: RoutingInboxResolvedRecord = {
    recordType: 'routing_resolution',
    schemaVersion: NonEmptyTextSchema.parse(object.schemaVersion),
    recordId: parseRecordId(object.recordId),
    resolvedRecordId: parseRecordId(object.resolvedRecordId),
    targetRecordType: NonEmptyTextSchema.parse(object.targetRecordType),
    targetBrainId: parseRecordId(object.targetBrainId),
    captureId: NonEmptyTextSchema.parse(object.captureId),
    atomKey: NonEmptyTextSchema.parse(object.atomKey),
    statement: NonEmptyTextSchema.parse(object.statement),
    evidenceRef: NonEmptyTextSchema.parse(object.evidenceRef),
    resolvedAt: IsoUtcDateTimeSchema.parse(object.resolvedAt),
    ...(object.targetRef === undefined ? {} : { targetRef: NonEmptyTextSchema.parse(object.targetRef) }),
  };
  return result;
}

function parseQuarantine(input: unknown): RoutingInboxQuarantineRecord {
  const object = strictObject(input, [
    'recordType',
    'schemaVersion',
    'recordId',
    'captureId',
    'atomKey',
    'statement',
    'evidenceRef',
    'reason',
    'createdAt',
    'updatedAt',
    'targetRef',
    'intendedTargetRef',
    'conflictWithRecordId',
  ]);
  if (object.recordType !== 'routing_quarantine') {
    throw new Error('Invalid routing quarantine record type.');
  }
  return {
    recordType: 'routing_quarantine',
    schemaVersion: NonEmptyTextSchema.parse(object.schemaVersion),
    recordId: parseRecordId(object.recordId),
    captureId: NonEmptyTextSchema.parse(object.captureId),
    atomKey: NonEmptyTextSchema.parse(object.atomKey),
    statement: NonEmptyTextSchema.parse(object.statement),
    evidenceRef: NonEmptyTextSchema.parse(object.evidenceRef),
    reason: NonEmptyTextSchema.parse(object.reason),
    createdAt: IsoUtcDateTimeSchema.parse(object.createdAt),
    updatedAt: IsoUtcDateTimeSchema.parse(object.updatedAt),
    ...(object.targetRef === undefined ? {} : { targetRef: NonEmptyTextSchema.parse(object.targetRef) }),
    ...(object.intendedTargetRef === undefined
      ? {}
      : { intendedTargetRef: NonEmptyTextSchema.parse(object.intendedTargetRef) }),
    ...(object.conflictWithRecordId === undefined
      ? {}
      : { conflictWithRecordId: parseRecordId(object.conflictWithRecordId) }),
  };
}

function makeQuarantine(
  item: RoutingInboxRecord,
  reason: string,
  metadata: RoutingInboxQuarantineMetadata,
  updatedAt = new Date().toISOString(),
): RoutingInboxQuarantineRecord {
  return {
    recordType: 'routing_quarantine',
    schemaVersion: item.schemaVersion,
    recordId: item.recordId,
    captureId: item.captureId,
    atomKey: item.atomKey,
    statement: item.statement,
    evidenceRef: item.evidenceRef,
    reason,
    createdAt: item.createdAt,
    updatedAt,
    ...(item.targetRef === undefined ? {} : { targetRef: item.targetRef }),
    ...(metadata.intendedTargetRef === undefined ? {} : { intendedTargetRef: metadata.intendedTargetRef }),
    ...(metadata.conflictWithRecordId === undefined ? {} : { conflictWithRecordId: metadata.conflictWithRecordId }),
  };
}

function strictObject(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Expected a record object.');
  }
  const object = input as Record<string, unknown>;
  const allowed = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown routing envelope field: ${key}`);
    }
  }
  return object;
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
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

function checksumFor(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function renderRecord(canonical: string): string {
  return `---\n${canonical}\n---\n<!-- memlume-sha256:${checksumFor(canonical)} -->\n`;
}

function readStored<T>(path: string, parser: (input: unknown) => T): T {
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
  if (checksumFor(canonical) !== match[2]) {
    throw new Error(`Record checksum/integrity failure: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical);
  } catch (error) {
    throw new Error(`Invalid record JSON: ${path}`, { cause: error });
  }
  return parser(parsed);
}

function assertRecordIdBinding(path: string, value: unknown): void {
  if (value === null || typeof value !== 'object' || !('recordId' in value)) {
    return;
  }
  const recordId = (value as { readonly recordId?: unknown }).recordId;
  const expected = basename(path, '.md');
  if (typeof recordId !== 'string' || recordId !== expected) {
    throw new Error(`Record integrity failure: file name does not match ${expected}.`);
  }
}

function atomicWrite(path: string, content: string): void {
  const tempPath = writeTempFile(path, content);
  try {
    renameSync(tempPath, path);
  } catch (error) {
    if (pathExists(path)) {
      assertRegularFile(path);
      unlinkSync(path);
      renameSync(tempPath, path);
    } else {
      throw error;
    }
  } finally {
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
  }
}

function writeTempFile(path: string, content: string): string {
  const parent = dirname(path);
  ensureDirectory(parent);
  const tempPath = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let descriptor: number | undefined;
  let completed = false;
  try {
    descriptor = openSync(tempPath, 'wx', 0o600);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    completed = true;
    return tempPath;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (!completed && existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
  }
}

function replaceFromTemp(path: string, tempPath: string): void {
  try {
    renameSync(tempPath, path);
  } catch (error) {
    if (!pathExists(path)) {
      throw error;
    }
    assertRegularFile(path);
    unlinkSync(path);
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
  }
}

function assertRegularFileOrMissing(path: string): void {
  if (pathExists(path)) {
    assertRegularFile(path);
  }
}

function ensureDirectory(path: string): void {
  if (isAbsolute(path) === false) {
    throw new Error('Storage path must be absolute.');
  }
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  while (!pathExists(current) && current !== dirname(current)) {
    missing.push(current);
    current = dirname(current);
  }
  if (pathExists(current)) {
    assertRegularDirectory(current);
  }
  for (const directory of missing.reverse()) {
    mkdirSync(directory);
    assertRegularDirectory(directory);
  }
  if (!pathExists(absolute)) {
    mkdirSync(absolute, { recursive: true });
  }
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

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function assertNoSymlinkBetween(path: string, root: string): void {
  const absolutePath = resolve(path);
  const absoluteRoot = resolve(root);
  let current = absolutePath;
  while (true) {
    if (pathExists(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Storage path escapes root through symlink: ${current}`);
      }
    }
    if (samePath(current, absoluteRoot)) {
      return;
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function assertContained(root: string, path: string): void {
  const relativePath = relative(resolve(root), resolve(path));
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Storage path escapes root: ${path}`);
  }
}

function compareByCreatedAt(left: { createdAt: string; recordId: string }, right: { createdAt: string; recordId: string }): number {
  return left.createdAt.localeCompare(right.createdAt) || left.recordId.localeCompare(right.recordId);
}
