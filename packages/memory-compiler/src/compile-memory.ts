import {
  EventSchema,
  MemoryScopeSchema,
  type Event,
  type MemoryKind,
  type MemoryScope,
} from '@memlume/contracts';

import { redactSecrets } from './secret-filter.js';

export interface CompileMemoryInput {
  readonly event: Event;
  readonly scope: MemoryScope;
}

export interface MemoryProposal {
  readonly status: 'candidate' | 'active';
  readonly kind: MemoryKind;
  readonly brainId: string;
  readonly scope: MemoryScope;
  readonly sourceEventId: string;
  readonly canonicalText: string;
  readonly reason: 'explicit_user_memory_request' | 'inferred_from_user_statement' | 'agent_inference_requires_review';
  readonly confidence: number;
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

  return {
    status: explicit ? 'active' : 'candidate',
    kind: preferenceWords.test(canonicalText) ? 'preference' : 'fact',
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
  };
}

function normalizeText(value: string): string {
  return value.trim().replace(/[。.!！]+$/u, '').trim();
}
