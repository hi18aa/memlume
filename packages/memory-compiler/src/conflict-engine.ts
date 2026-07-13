import type { JsonValue, MemoryKind, MemoryScope, MemoryStatus } from '@memlume/contracts';

export interface ConflictProposal {
  readonly brainId: string;
  readonly kind: MemoryKind;
  readonly canonicalText: string;
  readonly structuredData: JsonValue;
  readonly scope: MemoryScope;
  readonly status: 'candidate' | 'active';
}

export interface ConflictMemory extends Omit<ConflictProposal, 'status'> {
  readonly id: string;
  readonly status: MemoryStatus;
}

export type MemoryConflictResolution =
  | { readonly action: 'create'; readonly requiresConfirmation: false }
  | { readonly action: 'reuse'; readonly memoryId: string; readonly requiresConfirmation: false }
  | { readonly action: 'review'; readonly memoryId: string; readonly requiresConfirmation: true };

/**
 * Keeps automatic capture conservative: only an explicit active fact or preference
 * with the same structured subject can require a human correction decision.
 */
export function assessMemoryConflict(input: {
  readonly proposal: ConflictProposal;
  readonly existing: readonly ConflictMemory[];
}): MemoryConflictResolution {
  const comparable = input.existing.filter((memory) =>
    (memory.status === 'active' || memory.status === 'candidate') &&
    memory.brainId === input.proposal.brainId &&
    memory.kind === input.proposal.kind &&
    sameScope(memory.scope, input.proposal.scope),
  );
  const duplicate = comparable.find((memory) => normalizeText(memory.canonicalText) === normalizeText(input.proposal.canonicalText));
  if (duplicate !== undefined) {
    return { action: 'reuse', memoryId: duplicate.id, requiresConfirmation: false };
  }

  if (input.proposal.status === 'candidate') {
    return { action: 'create', requiresConfirmation: false };
  }

  const conflict = comparable.find((memory) =>
    memory.status === 'active' && semanticKey(memory) !== undefined && semanticKey(memory) === semanticKey(input.proposal),
  );
  return conflict === undefined
    ? { action: 'create', requiresConfirmation: false }
    : { action: 'review', memoryId: conflict.id, requiresConfirmation: true };
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').replace(/[。.!！?？]+$/gu, '').toLowerCase();
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  const leftScope = left as Record<string, unknown>;
  const rightScope = right as Record<string, unknown>;
  return left.level === right.level && ['domain', 'agentId', 'workspace', 'projectId', 'taskId'].every(
    (field) => Object.hasOwn(leftScope, field) === Object.hasOwn(rightScope, field) && leftScope[field] === rightScope[field],
  );
}

function semanticKey(memory: Pick<ConflictProposal, 'kind' | 'structuredData'>): string | undefined {
  if (!isRecord(memory.structuredData)) {
    return undefined;
  }
  if (memory.kind === 'fact' && typeof memory.structuredData.subject === 'string' && typeof memory.structuredData.predicate === 'string') {
    return `fact:${normalizeText(memory.structuredData.subject)}:${normalizeText(memory.structuredData.predicate)}`;
  }
  if (
    memory.kind === 'preference' &&
    typeof memory.structuredData.domain === 'string' &&
    typeof memory.structuredData.subject === 'string' &&
    typeof memory.structuredData.dimension === 'string'
  ) {
    return `preference:${normalizeText(memory.structuredData.domain)}:${normalizeText(memory.structuredData.subject)}:${normalizeText(memory.structuredData.dimension)}`;
  }
  return undefined;
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
