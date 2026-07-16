import { UuidV7Schema, type EventSource, type JsonValue, type MemoryItem } from '@memlume/contracts';
import { EventBrainRequiredError, EventJournal, type StoredEvent } from '@memlume/event-journal';
import { MemoryStore, type SaveMemoryInput } from '@memlume/retrieval';

export type SemanticEventInput = {
  readonly brainId?: string;
  readonly rawContent: string;
  readonly eventType: string;
  readonly source: EventSource;
  readonly structuredData?: JsonValue;
  readonly occurredAt?: string;
};

export type SemanticMemoryInput = Omit<SaveMemoryInput, 'brainId'> & {
  readonly brainId?: string;
};

export type SemanticMemoryServices = {
  readonly journal: EventJournal;
  readonly store: MemoryStore;
};

/**
 * Daemon write boundary for semantic state. Host routes can validate and
 * redact payloads, but Brain presence is checked again here so a future
 * route or adapter cannot silently reintroduce a Personal fallback.
 */
export class SemanticMemoryService {
  constructor(private readonly services: SemanticMemoryServices) {}

  appendEvent(input: SemanticEventInput): StoredEvent {
    const brainId = requireBrain(input.brainId);
    return this.services.journal.append({ ...input, brainId });
  }

  saveMemory(input: SemanticMemoryInput, status: 'active' | 'candidate' = 'active'): MemoryItem {
    const brainId = requireBrain(input.brainId);
    const normalized = { ...input, brainId } as SaveMemoryInput;
    return status === 'candidate'
      ? this.services.store.saveCandidate(normalized)
      : this.services.store.save(normalized);
  }

  capture(input: {
    readonly event: SemanticEventInput;
    readonly memory?: SemanticMemoryInput;
    readonly status?: 'active' | 'candidate';
  }): { readonly event: StoredEvent; readonly memory?: MemoryItem } {
    const event = this.appendEvent(input.event);
    if (input.memory === undefined) {
      return { event };
    }
    if (input.memory.brainId !== undefined && requireBrain(input.memory.brainId) !== event.brainId) {
      throw new Error('brain_mismatch: capture memory Brain differs from event Brain.');
    }
    const memory = this.saveMemory({ ...input.memory, brainId: event.brainId, sourceEventId: event.id }, input.status);
    return { event, memory };
  }
}

export function requireBrain(brainId: string | undefined): string {
  if (brainId === undefined) {
    throw new EventBrainRequiredError();
  }
  return UuidV7Schema.parse(brainId);
}
