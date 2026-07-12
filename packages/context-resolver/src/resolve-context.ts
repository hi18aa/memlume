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
  type PolicyData,
  type PolicyTrigger,
} from '@memlume/contracts';
import { compareMemorySpecificity, isScopeApplicable, MemoryStore } from '@memlume/retrieval';

/** Each estimatedTextUnit represents up to this many source-text characters; it is not a tokenizer. */
export const ESTIMATED_TEXT_UNIT_CHARS = 4;

export interface ResolveContextInput {
  readonly intent: string;
  readonly scope: MemoryScope;
  readonly task: string | null;
  /** Maximum estimatedTextUnits, calculated as ceil(character count / ESTIMATED_TEXT_UNIT_CHARS). */
  readonly contextBudget: number;
  readonly entities?: readonly string[];
  readonly availableTools?: readonly string[];
}

type Candidate = {
  readonly memoryId: string;
  readonly estimatedTextUnits: number;
  readonly mandatory: boolean;
  readonly reason: string;
  apply(): void;
};

type TriggerContext = {
  readonly intent: string;
  readonly entities: ReadonlySet<string>;
  readonly availableTools: ReadonlySet<string>;
};

type ApplicablePolicy = {
  readonly memory: MemoryItem;
  readonly data: PolicyData;
};

export class ContextResolver {
  constructor(private readonly store: MemoryStore) {}

  resolve(input: ResolveContextInput): ContextPack {
    const intent = NonEmptyTextSchema.parse(input.intent);
    const scope = MemoryScopeSchema.parse(input.scope);
    if (!Number.isSafeInteger(input.contextBudget) || input.contextBudget < 0) {
      throw new Error('Context budget must be a non-negative integer.');
    }

    const triggerContext: TriggerContext = {
      intent,
      entities: identifierSet(input.entities),
      availableTools: identifierSet(input.availableTools),
    };
    const today = new Date().toISOString().slice(0, 10);

    const applicable = this.store.findApplicable(scope, { status: 'active' }).filter((memory) => isCurrentlyValid(memory, today));
    const policies = applicable
      .filter((memory) => memory.kind === 'policy')
      .map((memory) => ({ memory, data: PolicyDataSchema.parse(memory.structuredData) }))
      .filter((policy) => matchesTrigger(policy.data.trigger, triggerContext));
    const routePolicies = policies
      .filter((policy) => policy.data.action.type === 'route_tool')
      .sort((left, right) => compareMemorySpecificity(left.memory, right.memory));
    const routeWinner = routePolicies[0];
    const requiresSingleRoute = routePolicies.some((policy) => policy.data.constraints.exclusive === true);
    const exclusions = !requiresSingleRoute || routeWinner === undefined
      ? []
      : routePolicies.filter((policy) =>
          policy.memory.id !== routeWinner.memory.id && policy.data.action.target !== routeWinner.data.action.target,
        );
    const excludedPolicyIds = new Set(exclusions.map((policy) => policy.memory.id));
    const directives = policies
      .filter((policy) => !excludedPolicyIds.has(policy.memory.id))
      .map((policy) => toDirective(policy, requiresSingleRoute && policy.memory.id === routeWinner?.memory.id));
    const procedures = applicable
      .filter((memory) => memory.kind === 'procedure')
      .map((memory) => toProcedure(memory, triggerContext))
      .filter((procedure): procedure is ContextProcedure => procedure !== undefined);
    const preferences = applicable
      .filter((memory) => memory.kind === 'preference')
      .filter((memory) => {
        const data = PreferenceDataSchema.safeParse(memory.structuredData);
        return data.success && (data.data.contexts === undefined || data.data.contexts.includes(intent));
      })
      .map(toPreference);
    const facts = findFacts(this.store, input.task, scope, today);
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
        toolSelection:
          routeWinner === undefined
            ? undefined
            : `Route winner ${routeWinner.data.action.target} from memory ${routeWinner.memory.id} by scope_then_priority.`,
        sourceMemoryIds: [] as string[],
        exclusions: exclusions.map((policy) => ({ memoryId: policy.memory.id, reason: 'exclusive_conflict' as const })),
        budget: {
          limitUnits: input.contextBudget,
          usedUnits: 0,
          included: [] as { memoryId: string; reason: string; estimatedTextUnits: number }[],
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
      if (item.mandatory || pack.explanation.budget.usedUnits + item.estimatedTextUnits <= input.contextBudget) {
        item.apply();
        pack.explanation.sourceMemoryIds.push(item.memoryId);
        pack.explanation.budget.included.push({
          memoryId: item.memoryId,
          reason: item.reason,
          estimatedTextUnits: item.estimatedTextUnits,
        });
        pack.explanation.budget.usedUnits += item.estimatedTextUnits;
      } else {
        pack.explanation.budget.omitted.push({ memoryId: item.memoryId, reason: 'budget' });
        pack.explanation.budget.truncated = true;
      }
    }

    return ContextPackSchema.parse(pack);
  }
}

function findFacts(store: MemoryStore, task: string | null, scope: MemoryScope, today: string): ContextKnowledge[] {
  if (task === null || !/[\p{L}\p{N}_]/u.test(task)) {
    return [];
  }

  return store
    .search(task, { status: 'active', kinds: ['fact'] })
    .filter((memory) => isScopeApplicable(memory.scope, scope))
    .filter((memory) => isCurrentlyValid(memory, today))
    .sort(compareMemorySpecificity)
    .map(toKnowledge);
}

function toDirective(policy: ApplicablePolicy, forceMandatory = false): ContextDirective {
  const { memory, data } = policy;
  return {
    memoryId: memory.id,
    sourceEventId: memory.sourceEventId,
    text: memory.canonicalText,
    actionTarget: data.action.target,
    priority: memory.priority,
    mandatory: forceMandatory || data.constraints.required === true || data.constraints.exclusive === true,
  };
}

function toProcedure(memory: MemoryItem, triggerContext: TriggerContext): ContextProcedure | undefined {
  const data = ProcedureDataSchema.safeParse(memory.structuredData);
  if (!data.success || !matchesTrigger(data.data.trigger, triggerContext)) {
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
  return {
    memoryId: item.memoryId,
    estimatedTextUnits: Math.ceil(text.length / ESTIMATED_TEXT_UNIT_CHARS),
    mandatory,
    reason,
    apply,
  };
}

function identifierSet(values: readonly string[] | undefined): ReadonlySet<string> {
  return new Set((values ?? []).map((value) => NonEmptyTextSchema.parse(value)));
}

function matchesTrigger(trigger: PolicyTrigger, context: TriggerContext): boolean {
  return (
    trigger.intents.includes(context.intent) &&
    (trigger.entities ?? []).every((entity) => context.entities.has(entity)) &&
    (trigger.requiredToolAvailability ?? []).every((tool) => context.availableTools.has(tool))
  );
}

function isCurrentlyValid(memory: MemoryItem, today: string): boolean {
  return (
    isDateRangeCurrent(memory.validFrom, memory.validUntil, today) &&
    (memory.kind !== 'fact' || isDateRangeCurrent(memory.structuredData.validFrom, memory.structuredData.validUntil, today))
  );
}

function isDateRangeCurrent(validFrom: string | undefined, validUntil: string | null | undefined, today: string): boolean {
  return (validFrom === undefined || validFrom <= today) && (validUntil === null || validUntil === undefined || validUntil >= today);
}
