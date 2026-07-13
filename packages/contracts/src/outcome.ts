import { z } from 'zod';

import { IsoUtcDateTimeSchema, JsonValueSchema, NonEmptyTextSchema, UuidV7Schema } from './memory.js';

export const MemoryUsageOutcomeSchema = z.enum(['adopted', 'ignored', 'corrected']);
export type MemoryUsageOutcome = z.infer<typeof MemoryUsageOutcomeSchema>;

export const OutcomeResultSchema = z.enum(['success', 'failure', 'corrected']);
export type OutcomeResult = z.infer<typeof OutcomeResultSchema>;

/**
 * A short-lived receipt issued when an adapter resolves context. Feedback
 * writes must present this receipt so an agent cannot fabricate arbitrary
 * outcome history outside a real context lifecycle.
 */
export const ContextReceiptSchema = z.object({
  traceId: UuidV7Schema,
  agentId: NonEmptyTextSchema,
  brainIds: z.array(UuidV7Schema).min(1),
  /** Only memories actually included in the resolved Context Pack may receive feedback. */
  sourceMemoryIds: z.array(UuidV7Schema).max(256),
  issuedAt: IsoUtcDateTimeSchema,
  expiresAt: IsoUtcDateTimeSchema,
  consumedAt: IsoUtcDateTimeSchema.nullable(),
}).strict();
export type ContextReceipt = z.infer<typeof ContextReceiptSchema>;

export const MemoryUsageSchema = z.object({
  id: UuidV7Schema,
  memoryId: UuidV7Schema,
  taskId: NonEmptyTextSchema,
  agentId: NonEmptyTextSchema,
  retrievalRank: z.number().int().nonnegative().nullable(),
  wasIncluded: z.boolean(),
  outcome: MemoryUsageOutcomeSchema.nullable(),
  usedAt: IsoUtcDateTimeSchema,
}).strict();
export type MemoryUsage = z.infer<typeof MemoryUsageSchema>;

export const MemoryOutcomeSchema = z.object({
  id: UuidV7Schema,
  taskId: NonEmptyTextSchema,
  agentId: NonEmptyTextSchema,
  result: OutcomeResultSchema,
  correctionType: NonEmptyTextSchema.nullable(),
  correctionData: JsonValueSchema.nullable(),
  usedMemoryIds: z.array(UuidV7Schema).min(1).max(256),
  usedToolIds: z.array(NonEmptyTextSchema).max(256),
  createdAt: IsoUtcDateTimeSchema,
}).strict();
export type MemoryOutcome = z.infer<typeof MemoryOutcomeSchema>;
