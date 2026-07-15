import { z } from 'zod';

import {
  IsoUtcDateTimeSchema,
  JsonValueSchema,
  MemoryKindSchema,
  MemoryStatusSchema,
  NonEmptyTextSchema,
  UuidV7Schema,
} from './memory.js';

export const BrainRecordTypeSchema = z.enum(['semantic', 'tombstone', 'routing_inbox', 'import_quarantine']);
const SchemaVersionSchema = NonEmptyTextSchema;

const CanonicalRecordMetadataSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    recordId: UuidV7Schema,
    memoryId: UuidV7Schema,
    brainId: UuidV7Schema,
    status: MemoryStatusSchema,
    kind: MemoryKindSchema,
    createdAt: IsoUtcDateTimeSchema,
    updatedAt: IsoUtcDateTimeSchema,
    captureId: NonEmptyTextSchema,
    atomKey: NonEmptyTextSchema,
  })
  .strict();

export const SemanticRecordSchema = CanonicalRecordMetadataSchema.extend({
  recordType: z.literal('semantic'),
  sourceAtom: NonEmptyTextSchema,
  canonicalText: NonEmptyTextSchema,
  structuredData: JsonValueSchema.optional(),
  supersedesRecordId: UuidV7Schema.optional(),
}).strict();
export type SemanticRecord = z.infer<typeof SemanticRecordSchema>;

export const TombstoneRecordSchema = CanonicalRecordMetadataSchema.extend({
  recordType: z.literal('tombstone'),
  status: z.literal('superseded'),
  supersedesRecordId: UuidV7Schema,
  reason: NonEmptyTextSchema,
}).strict();
export type TombstoneRecord = z.infer<typeof TombstoneRecordSchema>;

export const RoutingInboxRecordSchema = z
  .object({
    recordType: z.literal('routing_inbox'),
    schemaVersion: SchemaVersionSchema,
    recordId: UuidV7Schema,
    captureId: NonEmptyTextSchema,
    atomKey: NonEmptyTextSchema,
    status: z.literal('routing_required'),
    statement: NonEmptyTextSchema,
    evidenceRef: NonEmptyTextSchema,
    createdAt: IsoUtcDateTimeSchema,
    updatedAt: IsoUtcDateTimeSchema,
    targetRef: NonEmptyTextSchema.optional(),
  })
  .strict();
export type RoutingInboxRecord = z.infer<typeof RoutingInboxRecordSchema>;

export const ImportQuarantineRecordSchema = z
  .object({
    recordType: z.literal('import_quarantine'),
    schemaVersion: SchemaVersionSchema,
    recordId: UuidV7Schema,
    reason: z.enum(['record_conflict', 'schema_invalid', 'duplicate_id', 'binding_conflict']),
    sourcePath: NonEmptyTextSchema,
    conflictWithRecordId: UuidV7Schema.optional(),
    targetBrainId: UuidV7Schema.optional(),
    existingChecksum: NonEmptyTextSchema.optional(),
    incomingChecksum: NonEmptyTextSchema.optional(),
    createdAt: IsoUtcDateTimeSchema,
    updatedAt: IsoUtcDateTimeSchema,
  })
  .strict();
export type ImportQuarantineRecord = z.infer<typeof ImportQuarantineRecordSchema>;

export const BrainRecordSchema = z.discriminatedUnion('recordType', [
  SemanticRecordSchema,
  TombstoneRecordSchema,
  RoutingInboxRecordSchema,
  ImportQuarantineRecordSchema,
]);
export type BrainRecord = z.infer<typeof BrainRecordSchema>;

export type BrainRecordType = z.infer<typeof BrainRecordTypeSchema>;
