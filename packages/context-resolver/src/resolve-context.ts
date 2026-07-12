import {
  ContextPackSchema,
  MemoryScopeSchema,
  NonEmptyTextSchema,
  PolicyDataSchema,
  PreferenceDataSchema,
  ProcedureDataSchema,
  createUuidV7,
  type ContextPack,
  type ContextDecision,
  type ContextDirective,
  type ContextKnowledge,
  type ContextPreference,
  type ContextProcedure,
  type MemoryItem,
  type MemoryScope,
} from '@memlume/contracts';
import { compareMemorySpecificity, isScopeApplicable, MemoryStore } from '@memlume/retrieval';

export interface ResolveContextInput {
  readonly intent: string;
  readonly scope: MemoryScope;
  readonly task: string | null;
  readonly contextBudget: number;
}

type Candidate = {
  readonly memoryId: string;
  readonly units: number;
  readonly mandatory: boolean;
  readonly reason: string;
  apply(): void;
};

export class ContextResolver {
  constructor(private readonly store: MemoryStore) {}

  resolve(input: ResolveContextInput): ContextPack {
    const intent = NonEmptyTextSchema.parse(input.intent);
    const scope = MemoryScopeSchema.parse(input.scope);
    if (!Number.isSafeInteger(input.contextBudget) || input.contextBudget < 0) {
      throw new Error('Context budget must be a non-negative integer.');
    }

    const applicable = this.store.findApplicable(scope, { status: 'active' });
    const directives = applicable
      .filter((memory) => memory.kind === 'policy')
      .filter((memory) => PolicyDataSchema.parse(memory.structuredData).trigger.intents.includes(intent))
      .map(toDirective);
    const procedures = applicable
      .filter((memory) => memory.kind === 'procedure')
      .map((memory) => toProcedure(memory, intent))
      .filter((procedure): procedure is ContextProcedure => procedure !== undefined);
    const preferences = applicable
      .filter((memory) => memory.kind === 'preference')
      .filter((memory) => {
        const data = PreferenceDataSchema.safeParse(memory.structuredData);
        return data.success && (data.data.contexts === undefined || data.data.contexts.includes(intent));
      })
      .map(toPreference);
    const facts = findFacts(this.store, input.task, scope);
    const decisions = applicable.filter((memory) => memory.kind === 'decision').map(toDecision);

    const pack = {
      traceId: createUuidV7(),
      intent,
      scope,
      directives: [] as ContextDirective[],
      procedures: [] as ContextProcedure[],
      preferences: [] as ContextPreference[],
      knowledge: [] as ContextKnowledge[],
      decisions: [] as ContextDecision[],
      explanation: {
        sourceMemoryIds: [] as string[],
        budget: {
          limit: input.contextBudget,
          used: 0,
          included: [] as { memoryId: string; reason: string; units: number }[],
          omitted: [] as { memoryId: string; reason: 'budget' }[],
          truncated: false,
        },
      },
    };

    const candidates: Candidate[] = [
      ...directives
        .filter((directive) => directive.mandatory)
        .map((directive) => candidate(directive, directive.text, true, 'mandatory', () => pack.directives.push(directive))),
      ...directives
        .filter((directive) => !directive.mandatory)
        .map((directive) => candidate(directive, directive.text, false, 'policy', () => pack.directives.push(directive))),
      ...procedures.map((procedure) => candidate(procedure, `${procedure.name}${procedure.steps.join('')}`, false, 'procedure', () => pack.procedures.push(procedure))),
      ...preferences.map((preference) => candidate(preference, preference.text, false, 'preference', () => pack.preferences.push(preference))),
      ...facts.map((fact) => candidate(fact, `${fact.title}${fact.summary}`, false, 'fact', () => pack.knowledge.push(fact))),
      ...decisions.map((decision) => candidate(decision, decision.text, false, 'decision', () => pack.decisions.push(decision))),
    ];

    for (const item of candidates) {
      if (item.mandatory || pack.explanation.budget.used + item.units <= input.contextBudget) {
        item.apply();
        pack.explanation.sourceMemoryIds.push(item.memoryId);
        pack.explanation.budget.included.push({ memoryId: item.memoryId, reason: item.reason, units: item.units });
        pack.explanation.budget.used += item.units;
      } else {
        pack.explanation.budget.omitted.push({ memoryId: item.memoryId, reason: 'budget' });
        pack.explanation.budget.truncated = true;
      }
    }

    return ContextPackSchema.parse(pack);
  }
}

function findFacts(store: MemoryStore, task: string | null, scope: MemoryScope): ContextKnowledge[] {
  if (task === null || !/[\p{L}\p{N}_]/u.test(task)) {
    return [];
  }

  return store
    .search(task, { status: 'active', kinds: ['fact'] })
    .filter((memory) => isScopeApplicable(memory.scope, scope))
    .sort(compareMemorySpecificity)
    .map(toKnowledge);
}

function toDirective(memory: MemoryItem): ContextDirective {
  const data = PolicyDataSchema.parse(memory.structuredData);
  return {
    memoryId: memory.id,
    sourceEventId: memory.sourceEventId,
    text: memory.canonicalText,
    priority: memory.priority,
    mandatory: data.constraints.required === true || data.constraints.exclusive === true,
  };
}

function toProcedure(memory: MemoryItem, intent: string): ContextProcedure | undefined {
  const data = ProcedureDataSchema.safeParse(memory.structuredData);
  if (!data.success || !data.data.trigger.intents.includes(intent)) {
    return undefined;
  }
  return {
    memoryId: memory.id,
    name: memory.title ?? memory.canonicalText,
    steps: [...data.data.steps].sort((left, right) => left.order - right.order).map((step) => step.action),
  };
}

function toPreference(memory: MemoryItem): ContextPreference {
  return { memoryId: memory.id, text: memory.canonicalText };
}

function toKnowledge(memory: MemoryItem): ContextKnowledge {
  return { memoryId: memory.id, title: memory.title ?? memory.canonicalText, summary: memory.canonicalText };
}

function toDecision(memory: MemoryItem): ContextDecision {
  return { memoryId: memory.id, text: memory.canonicalText };
}

function candidate(
  item: { readonly memoryId: string },
  text: string,
  mandatory: boolean,
  reason: string,
  apply: () => void,
): Candidate {
  return { memoryId: item.memoryId, units: Math.ceil(text.length / 4), mandatory, reason, apply };
}
