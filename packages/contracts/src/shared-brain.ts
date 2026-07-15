import { z } from 'zod';

import { IsoUtcDateTimeSchema, NonEmptyTextSchema, UuidV7Schema } from './memory.js';

export const BrainKindSchema = z.enum(['personal', 'project']);
export type BrainKind = z.infer<typeof BrainKindSchema>;

export const BrainSchema = z.object({
  id: UuidV7Schema,
  kind: BrainKindSchema,
  name: NonEmptyTextSchema,
  createdAt: IsoUtcDateTimeSchema,
  updatedAt: IsoUtcDateTimeSchema,
});
export type Brain = z.infer<typeof BrainSchema>;

export const AgentInstallationSchema = z.object({
  id: UuidV7Schema,
  clientType: NonEmptyTextSchema,
  installationId: NonEmptyTextSchema,
  profileId: NonEmptyTextSchema,
  displayName: NonEmptyTextSchema.optional(),
});
export type AgentInstallation = z.infer<typeof AgentInstallationSchema>;

export const BrainMountSchema = z.object({
  brainId: UuidV7Schema,
  agentInstallationId: UuidV7Schema,
  access: z.enum(['read', 'read_write']),
});
export type BrainMount = z.infer<typeof BrainMountSchema>;

export const AdapterEnvelopeSchema = z.object({
  clientType: NonEmptyTextSchema,
  installationId: NonEmptyTextSchema,
  profileId: NonEmptyTextSchema,
  sessionId: NonEmptyTextSchema,
  projectId: NonEmptyTextSchema,
  workspacePath: NonEmptyTextSchema.optional(),
});
export type AdapterEnvelope = z.infer<typeof AdapterEnvelopeSchema>;

export const DEFAULT_PERSONAL_BRAIN_ID = UuidV7Schema.parse('00000000-0000-7000-8000-000000000001');
