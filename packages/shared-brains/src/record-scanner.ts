import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SemanticRecordSchema,
  TombstoneRecordSchema,
  type BrainRecord,
  type RoutingInboxRecord,
  type SemanticRecord,
  type TombstoneRecord,
} from '@memlume/contracts';

import { MarkdownRecordStore } from './markdown-record-store.js';
import { RoutingInboxStore, type RoutingInboxQuarantineRecord, type RoutingInboxResolvedRecord } from './routing-inbox-store.js';

export type ScannedRecord = {
  readonly record: SemanticRecord | TombstoneRecord;
  readonly relativePath: string;
  readonly checksum: string;
};

export type ScannedInbox = {
  readonly pending: readonly RoutingInboxRecord[];
  readonly resolved: readonly RoutingInboxResolvedRecord[];
  readonly quarantine: readonly RoutingInboxQuarantineRecord[];
};

export type ScannedMarkdownState = {
  readonly records: readonly ScannedRecord[];
  readonly inbox: ScannedInbox;
};

/**
 * Validate every authority record before a projector transaction starts.
 * `MarkdownRecordStore.list()` performs schema, checksum and path validation;
 * this pass only binds each validated record to its canonical file checksum.
 */
export function scanMarkdownRecords(input: string | { readonly dataRoot: string }): readonly ScannedRecord[] {
  const dataRoot = typeof input === 'string' ? input : input.dataRoot;
  const store = new MarkdownRecordStore({ rootDir: dataRoot });
  const scanned: ScannedRecord[] = [];
  for (const record of store.list()) {
    const parsed = parseProjectableRecord(record);
    const relativePath = recordRelativePath(parsed);
    const absolutePath = join(dataRoot, ...relativePath.split('/'));
    const checksum = readChecksum(absolutePath);
    scanned.push({ record: parsed, relativePath, checksum });
  }
  return scanned;
}

export function scanMarkdownState(input: string | { readonly dataRoot: string }): ScannedMarkdownState {
  const dataRoot = typeof input === 'string' ? input : input.dataRoot;
  // Keep the complete record scan first. A malformed record must fail before
  // the Inbox is even consulted or a SQLite transaction can begin.
  const records = scanMarkdownRecords(dataRoot);
  const inboxStore = new RoutingInboxStore({ rootDir: dataRoot });
  return {
    records,
    inbox: {
      pending: inboxStore.listPending(),
      resolved: inboxStore.listResolved(),
      quarantine: inboxStore.listQuarantine(),
    },
  };
}

function parseProjectableRecord(input: BrainRecord): SemanticRecord | TombstoneRecord {
  if (input.recordType === 'semantic') {
    return SemanticRecordSchema.parse(input);
  }
  if (input.recordType === 'tombstone') {
    return TombstoneRecordSchema.parse(input);
  }
  throw new Error(`Unsupported authority record for SQLite projection: ${input.recordType}`);
}

function recordRelativePath(record: SemanticRecord | TombstoneRecord): string {
  const relativePath = [
    'brains',
    record.brainId,
    'records',
    record.createdAt.slice(0, 4),
    record.createdAt.slice(5, 7),
    `${record.recordId}.md`,
  ].join('/');
  return relativePath;
}

function readChecksum(path: string): string {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read authority record: ${path}`, { cause: error });
  }
  const match = /^---\n([\s\S]*?)\n---\n<!-- memlume-sha256:([0-9a-f]{64}) -->\n?$/u.exec(content);
  if (match === null) {
    throw new Error(`Invalid Markdown record format: ${path}`);
  }
  const checksum = createHash('sha256').update(match[1], 'utf8').digest('hex');
  if (checksum !== match[2]) {
    throw new Error(`Record checksum/integrity failure: ${path}`);
  }
  return checksum;
}
