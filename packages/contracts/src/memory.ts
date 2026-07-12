import { z } from 'zod';

export const UuidV7Schema = z.uuidv7();
export const IsoUtcDateTimeSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => value.endsWith('Z'), 'Expected a UTC ISO 8601 timestamp.');
export const IsoDateSchema = z.iso.date();
export const NonEmptyTextSchema = z.string().trim().min(1);
const PreservedTextSchema = z.string().refine((value) => value.trim().length > 0, 'Expected non-empty text.');

export const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;

export const MemoryKindSchema = z.enum([
  'policy',
  'procedure',
  'preference',
  'fact',
  'decision',
  'capability',
]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MemoryStatusSchema = z.enum([
  'candidate',
  'active',
  'superseded',
  'expired',
  'rejected',
  'archived',
]);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const MemoryScopeSchema = z.discriminatedUnion('level', [
  z.object({ level: z.literal('global') }).strict(),
  z.object({ level: z.literal('domain'), domain: NonEmptyTextSchema }).strict(),
  z
    .object({
      level: z.literal('agent'),
      domain: NonEmptyTextSchema.optional(),
      agentId: NonEmptyTextSchema,
    })
    .strict(),
  z
    .object({
      level: z.literal('workspace'),
      domain: NonEmptyTextSchema.optional(),
      agentId: NonEmptyTextSchema.optional(),
      workspace: NonEmptyTextSchema,
    })
    .strict(),
  z
    .object({
      level: z.literal('project'),
      domain: NonEmptyTextSchema.optional(),
      agentId: NonEmptyTextSchema.optional(),
      workspace: NonEmptyTextSchema.optional(),
      projectId: NonEmptyTextSchema,
    })
    .strict(),
  z
    .object({
      level: z.literal('task'),
      domain: NonEmptyTextSchema.optional(),
      agentId: NonEmptyTextSchema.optional(),
      workspace: NonEmptyTextSchema.optional(),
      projectId: NonEmptyTextSchema.optional(),
      taskId: NonEmptyTextSchema,
    })
    .strict(),
]);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const PolicyTriggerSchema = z.object({
  intents: z.array(NonEmptyTextSchema).min(1),
  entities: z.array(NonEmptyTextSchema).optional(),
  requiredToolAvailability: z.array(NonEmptyTextSchema).optional(),
});
export type PolicyTrigger = z.infer<typeof PolicyTriggerSchema>;

export const PolicyActionSchema = z.object({
  type: z.enum(['route_tool', 'apply_process', 'prefer_strategy', 'require_validation']),
  target: NonEmptyTextSchema,
});
export type PolicyAction = z.infer<typeof PolicyActionSchema>;

export const PolicyDataSchema = z.object({
  trigger: PolicyTriggerSchema,
  action: PolicyActionSchema,
  constraints: z.object({
    exclusive: z.boolean().optional(),
    required: z.boolean().optional(),
  }),
});
export type PolicyData = z.infer<typeof PolicyDataSchema>;

export const ProcedureDataSchema = z.object({
  trigger: PolicyTriggerSchema,
  steps: z
    .array(
      z.object({
        order: z.number().int().positive(),
        action: NonEmptyTextSchema,
        toolId: NonEmptyTextSchema.optional(),
      }),
    )
    .min(1),
});
export type ProcedureData = z.infer<typeof ProcedureDataSchema>;

export const PreferenceDataSchema = z.object({
  domain: NonEmptyTextSchema,
  subject: NonEmptyTextSchema,
  dimension: NonEmptyTextSchema,
  value: JsonValueSchema,
  strength: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  contexts: z.array(NonEmptyTextSchema).optional(),
});
export type PreferenceData = z.infer<typeof PreferenceDataSchema>;

export const FactDataSchema = z.object({
  subject: NonEmptyTextSchema,
  predicate: NonEmptyTextSchema,
  object: JsonValueSchema,
  validFrom: IsoDateSchema.optional(),
  validUntil: IsoDateSchema.nullable().optional(),
  confidence: z.number().min(0).max(1),
});
export type FactData = z.infer<typeof FactDataSchema>;

export const DecisionDataSchema = z.object({
  rationale: z.array(NonEmptyTextSchema).min(1),
  supersedes: UuidV7Schema.nullable().optional(),
});
export type DecisionData = z.infer<typeof DecisionDataSchema>;

export const CapabilityDataSchema = z.object({
  toolId: NonEmptyTextSchema,
  intents: z.array(NonEmptyTextSchema).min(1),
  inputModalities: z.array(NonEmptyTextSchema).min(1),
  outputModalities: z.array(NonEmptyTextSchema).min(1),
  availability: NonEmptyTextSchema,
});
export type CapabilityData = z.infer<typeof CapabilityDataSchema>;

const MemoryItemMetadataSchema = z.object({
  id: UuidV7Schema,
  title: NonEmptyTextSchema.optional(),
  canonicalText: NonEmptyTextSchema,
  scope: MemoryScopeSchema,
  status: MemoryStatusSchema,
  priority: z.number().int(),
  confidence: z.number().min(0).max(1),
  explicitness: z.number().min(0).max(1),
  sourceEventId: UuidV7Schema.optional(),
  validFrom: IsoDateSchema.optional(),
  validUntil: IsoDateSchema.optional(),
  createdAt: IsoUtcDateTimeSchema,
  updatedAt: IsoUtcDateTimeSchema,
  supersededBy: UuidV7Schema.optional(),
});
export const PolicyMemoryItemSchema = MemoryItemMetadataSchema.extend({
  kind: z.literal('policy'),
  structuredData: PolicyDataSchema,
});
export type PolicyMemoryItem = z.infer<typeof PolicyMemoryItemSchema>;

export const OtherMemoryItemSchema = MemoryItemMetadataSchema.extend({
  kind: z.enum(['procedure', 'preference', 'fact', 'decision', 'capability']),
  structuredData: JsonValueSchema,
});
export type OtherMemoryItem = z.infer<typeof OtherMemoryItemSchema>;

export const MemoryItemSchema = z.discriminatedUnion('kind', [PolicyMemoryItemSchema, OtherMemoryItemSchema]);
export type MemoryItem = z.infer<typeof MemoryItemSchema>;

export const EventSourceSchema = z
  .object({
    type: NonEmptyTextSchema.optional(),
    agent: NonEmptyTextSchema.optional(),
    conversationId: NonEmptyTextSchema.optional(),
    messageId: NonEmptyTextSchema.optional(),
    reference: NonEmptyTextSchema.optional(),
  })
  .refine((source) => Object.values(source).some((value) => value !== undefined), 'Expected event source information.');
export type EventSource = z.infer<typeof EventSourceSchema>;

export const EventSchema = z.object({
  id: UuidV7Schema,
  eventType: NonEmptyTextSchema,
  rawContent: PreservedTextSchema,
  structuredData: JsonValueSchema.optional(),
  occurredAt: IsoUtcDateTimeSchema,
  source: EventSourceSchema,
});
export type Event = z.infer<typeof EventSchema>;

export const ContextDirectiveSchema = z.object({
  memoryId: UuidV7Schema,
  sourceEventId: UuidV7Schema.optional(),
  text: NonEmptyTextSchema,
  priority: z.number().int(),
  mandatory: z.boolean(),
});
export type ContextDirective = z.infer<typeof ContextDirectiveSchema>;

export const ContextProcedureSchema = z.object({
  memoryId: UuidV7Schema,
  name: NonEmptyTextSchema,
  steps: z.array(NonEmptyTextSchema).min(1),
});
export type ContextProcedure = z.infer<typeof ContextProcedureSchema>;

export const ContextPreferenceSchema = z.object({
  memoryId: UuidV7Schema,
  text: NonEmptyTextSchema,
});
export type ContextPreference = z.infer<typeof ContextPreferenceSchema>;

export const ContextKnowledgeSchema = z.object({
  memoryId: UuidV7Schema,
  title: NonEmptyTextSchema,
  summary: NonEmptyTextSchema,
});
export type ContextKnowledge = z.infer<typeof ContextKnowledgeSchema>;

export const ContextDecisionSchema = z.object({
  memoryId: UuidV7Schema,
  text: NonEmptyTextSchema,
});
export type ContextDecision = z.infer<typeof ContextDecisionSchema>;

export const ContextPackExplanationSchema = z.object({
  toolSelection: NonEmptyTextSchema.optional(),
  sourceMemoryIds: z.array(UuidV7Schema),
  budget: z
    .object({
      limit: z.number().int().nonnegative(),
      used: z.number().int().nonnegative(),
      included: z.array(z.object({ memoryId: UuidV7Schema, units: z.number().int().positive() })),
    })
    .optional(),
});
export type ContextPackExplanation = z.infer<typeof ContextPackExplanationSchema>;

export const ContextPackSchema = z.object({
  traceId: UuidV7Schema,
  intent: NonEmptyTextSchema,
  scope: MemoryScopeSchema,
  directives: z.array(ContextDirectiveSchema),
  procedures: z.array(ContextProcedureSchema),
  preferences: z.array(ContextPreferenceSchema),
  knowledge: z.array(ContextKnowledgeSchema),
  decisions: z.array(ContextDecisionSchema),
  explanation: ContextPackExplanationSchema,
});
export type ContextPack = z.infer<typeof ContextPackSchema>;
