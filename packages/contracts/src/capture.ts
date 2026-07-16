import { z } from 'zod';

import { IsoUtcDateTimeSchema, NonEmptyTextSchema, UuidV7Schema } from './memory.js';

export const CaptureStatusSchema = z.enum([
  'queued', 'active', 'candidate', 'event_only', 'routing_required', 'ignored', 'rejected', 'failed',
]);
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>;

export const CaptureAtomReceiptSchema = z.object({
  atomKey: NonEmptyTextSchema,
  status: CaptureStatusSchema,
  brainId: UuidV7Schema.optional(),
  memoryId: UuidV7Schema.optional(),
  recordId: UuidV7Schema.optional(),
  reason: NonEmptyTextSchema.optional(),
}).strict();
export type CaptureAtomReceipt = z.infer<typeof CaptureAtomReceiptSchema>;

export const CaptureReceiptSchema = z.object({
  captureId: NonEmptyTextSchema,
  sourceReference: NonEmptyTextSchema,
  status: CaptureStatusSchema,
  atoms: z.array(CaptureAtomReceiptSchema).max(256),
  createdAt: IsoUtcDateTimeSchema,
  updatedAt: IsoUtcDateTimeSchema,
}).strict();
export type CaptureReceipt = z.infer<typeof CaptureReceiptSchema>;

export const CaptureSourceSchema = z.object({
  captureId: NonEmptyTextSchema,
  sourceReference: NonEmptyTextSchema,
  actor: z.enum(['user', 'assistant', 'tool']),
  eventType: NonEmptyTextSchema,
  sanitizedContent: NonEmptyTextSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  createdAt: IsoUtcDateTimeSchema,
}).strict();
export type CaptureSource = z.infer<typeof CaptureSourceSchema>;
