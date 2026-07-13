import {
  EventSchema,
  MemoryScopeSchema,
  PolicyDataSchema,
  type Event,
  type MemoryKind,
  type PolicyData,
  type MemoryScope,
} from '@memlume/contracts';

import { redactSecrets } from './secret-filter.js';

export interface CompileMemoryInput {
  readonly event: Event;
  readonly scope: MemoryScope;
}

export interface MemoryProposal {
  readonly status: 'candidate' | 'active';
  readonly kind: Extract<MemoryKind, 'policy' | 'preference' | 'fact'>;
  readonly brainId: string;
  readonly scope: MemoryScope;
  readonly sourceEventId: string;
  readonly canonicalText: string;
  readonly reason: 'explicit_user_memory_request' | 'inferred_from_user_statement' | 'agent_inference_requires_review';
  readonly confidence: number;
  readonly policyData?: PolicyData;
}

export interface IgnoredMemory {
  readonly status: 'ignore';
  readonly reason: 'transcript_not_captured' | 'unsupported_event_type' | 'empty_memory_request';
  readonly confidence: 0;
}

export interface RejectedMemory {
  readonly status: 'rejected';
  readonly reason: 'secret_detected';
  readonly confidence: 0;
  readonly redactedContent: string;
}

export type CompiledMemory = MemoryProposal | IgnoredMemory | RejectedMemory;

const explicitRequest = /^\s*(?:(?:請|請你)\s*)?(?:記住|記下|記錄|remember|memorize|save(?:\s+this)?)\s*[,，:：]?\s*/iu;
const userEventTypes = new Set(['user_message', 'user_statement']);
const agentInferenceEventType = 'agent_inference';
const preferenceWords = /\b(?:prefer|preference)\b|喜歡|偏好/iu;

export function compileMemory(input: CompileMemoryInput): CompiledMemory {
  const event = EventSchema.parse(input.event);
  const scope = MemoryScopeSchema.parse(input.scope);
  const secret = redactSecrets(event.rawContent);
  if (secret.detected) {
    return { status: 'rejected', reason: 'secret_detected', confidence: 0, redactedContent: secret.redacted };
  }
  if (event.eventType.includes('transcript')) {
    return { status: 'ignore', reason: 'transcript_not_captured', confidence: 0 };
  }
  const agentInference = event.eventType === agentInferenceEventType;
  if (!userEventTypes.has(event.eventType) && !agentInference) {
    return { status: 'ignore', reason: 'unsupported_event_type', confidence: 0 };
  }

  const explicit = !agentInference && explicitRequest.test(event.rawContent);
  const canonicalText = normalizeText(explicit ? event.rawContent.replace(explicitRequest, '') : event.rawContent);
  if (canonicalText === '') {
    return { status: 'ignore', reason: 'empty_memory_request', confidence: 0 };
  }

  const policyData = compilePolicy(canonicalText);
  return {
    status: explicit ? 'active' : 'candidate',
    kind: policyData === undefined ? (preferenceWords.test(canonicalText) ? 'preference' : 'fact') : 'policy',
    brainId: event.brainId,
    scope,
    sourceEventId: event.id,
    canonicalText,
    reason: explicit
      ? 'explicit_user_memory_request'
      : agentInference
        ? 'agent_inference_requires_review'
        : 'inferred_from_user_statement',
    confidence: explicit ? 1 : agentInference ? 0.25 : 0.5,
    ...(policyData === undefined ? {} : { policyData }),
  };
}

function normalizeText(value: string): string {
  return value.trim().replace(/[。.!！]+$/u, '').trim();
}

/**
 * Compile only an unambiguous, positive routing rule. Everything else stays
 * a fact/preference candidate so an agent cannot invent a high-priority rule.
 */
function compilePolicy(value: string): PolicyData | undefined {
  const english = /^(?:always\s+)?(?:use|prefer)\s+([^\s.]+)\s+for\s+([a-z][a-z0-9_-]*)$/iu.exec(value);
  const chinese = /^(?:當|若)\s*([^，,。]+?)\s*時[，,]?\s*(?:請)?(?:使用|用)\s*([^，,。\s]+)$/u.exec(value);
  const match = english === null ? chinese : english;
  if (match === null) return undefined;
  const target = normalizeText(english === null ? match[2] : match[1]);
  const intent = normalizeText(english === null ? match[1] : match[2]).replace(/\s+/gu, '_');
  if (target === '' || intent === '') return undefined;
  return PolicyDataSchema.parse({
    trigger: { intents: [intent] },
    action: { type: 'prefer_strategy', target },
    constraints: {},
  });
}
