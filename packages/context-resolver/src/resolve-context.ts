import {
  ContextPackSchema,
  DEFAULT_PERSONAL_BRAIN_ID,
  MemoryScopeSchema,
  NonEmptyTextSchema,
  PolicyDataSchema,
  PreferenceDataSchema,
  ProcedureDataSchema,
  ReadSetSchema,
  UuidV7Schema,
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
  type ReadSet,
} from '@memlume/contracts';
import { compareMemorySpecificity, isScopeApplicable, MemoryStore, OutcomeStore } from '@memlume/retrieval';

/** Each estimatedTextUnit represents up to this many source-text characters; it is not a tokenizer. */
export const ESTIMATED_TEXT_UNIT_CHARS = 4;

export interface ResolveContextInput {
  readonly intent: string;
  readonly scope: MemoryScope;
  readonly task: string | null;
  /** Maximum estimatedTextUnits, calculated as ceil(character count / ESTIMATED_TEXT_UNIT_CHARS). */
  readonly contextBudget: number;
  /** Server-trusted mounted brains in descending priority; omitted means Personal only. */
  readonly brainIds?: readonly string[];
  readonly entities?: readonly string[];
  readonly availableTools?: readonly string[];
  /** Optional daemon-planned grant. When present, Host-supplied brainIds are ignored. */
  readonly readSet?: ReadSet;
}

type Candidate = {
  readonly memoryId: string;
  readonly memoryRank: number;
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
  constructor(private readonly store: MemoryStore, private readonly outcomes?: OutcomeStore) {}

  resolve(input: ResolveContextInput): ContextPack {
    const intent = NonEmptyTextSchema.parse(input.intent);
    const scope = MemoryScopeSchema.parse(input.scope);
    const plannedReadSet = input.readSet === undefined ? undefined : ReadSetSchema.parse(input.readSet);
    const brainIds = [...new Set(
      (plannedReadSet === undefined
        ? (input.brainIds === undefined ? [DEFAULT_PERSONAL_BRAIN_ID] : input.brainIds)
        : plannedReadSet.entries.map(({ brainId }) => brainId))
        .map((brainId) => UuidV7Schema.parse(brainId)),
    )];
    if (!Number.isSafeInteger(input.contextBudget) || input.contextBudget < 0) {
      throw new Error('Context budget must be a non-negative integer.');
    }

    const triggerContext: TriggerContext = {
      intent,
      entities: identifierSet(input.entities),
      availableTools: identifierSet(input.availableTools),
    };
    const today = new Date().toISOString().slice(0, 10);

    const compareContextMemory = compareByBrainThenSpecificity(brainIds);
    const feedbackScores = plannedReadSet === undefined
      ? this.outcomes?.feedbackScores(
          this.store.list({ brainIds, status: 'active' }).map((memory) => memory.id),
          brainIds,
        ) ?? new Map<string, number>()
      : new Map<string, number>();
    const compareWithFeedback = (left: MemoryItem, right: MemoryItem): number =>
      (feedbackScores.get(right.id) ?? 0) - (feedbackScores.get(left.id) ?? 0) || compareContextMemory(left, right);
    const readSetProjectBrainIds = plannedReadSet === undefined
      ? undefined
      : new Set(
        plannedReadSet.entries
          .filter(({ role }) => role === 'primary' || role === 'linked')
          .map(({ brainId }) => brainId),
      );
    const applicable = this.store
      .list({ status: 'active', brainIds })
      .filter((memory) => isReadSetScopeApplicable(memory, scope, readSetProjectBrainIds))
      .filter((memory) => isCurrentlyValid(memory, today))
      .sort(compareWithFeedback);
    const policies = applicable
      .filter((memory) => memory.kind === 'policy')
      .map((memory) => ({ memory, data: PolicyDataSchema.parse(memory.structuredData) }))
      .filter((policy) => matchesTrigger(policy.data.trigger, triggerContext));
    const routePolicies = policies
      .filter((policy) => policy.data.action.type === 'route_tool')
      .sort((left, right) => compareWithFeedback(left.memory, right.memory));
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
    const facts = findFacts(this.store, input.task, scope, today, brainIds, compareWithFeedback, readSetProjectBrainIds);
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
            : `Route winner ${routeWinner.data.action.target} from memory ${routeWinner.memory.id} by brain_then_scope_then_priority.`,
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

    const memoryRanks = new Map(applicable.map((memory, index) => [memory.id, index]));
    const candidates: Candidate[] = [
      ...directives
        .filter((directive) => directive.mandatory)
        .map((directive) => candidate(directive, memoryRanks.get(directive.memoryId)!, directive.text, true, 'mandatory', () => pack.directives.push(directive))),
      ...directives
        .filter((directive) => !directive.mandatory)
        .map((directive) => candidate(directive, memoryRanks.get(directive.memoryId)!, directive.text, false, 'policy', () => pack.directives.push(directive))),
      ...procedures.map((procedure) => candidate(procedure, memoryRanks.get(procedure.memoryId)!, `${procedure.name}${procedure.steps.join('')}`, false, 'procedure', () => pack.procedures.push(procedure))),
      ...preferences.map((preference) => candidate(preference, memoryRanks.get(preference.memoryId)!, preference.text, false, 'preference', () => pack.preferences.push(preference))),
      ...facts.map((fact) => candidate(fact, memoryRanks.get(fact.memoryId)!, `${fact.title}${fact.summary}`, false, 'fact', () => pack.knowledge.push(fact))),
      ...decisions.map((decision) => candidate(decision, memoryRanks.get(decision.memoryId)!, decision.text, false, 'decision', () => pack.decisions.push(decision))),
    ].sort((left, right) => left.memoryRank - right.memoryRank);

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

function findFacts(
  store: MemoryStore,
  task: string | null,
  scope: MemoryScope,
  today: string,
  brainIds: readonly string[],
  compare: (left: MemoryItem, right: MemoryItem) => number,
  readSetProjectBrainIds?: ReadonlySet<string>,
): ContextKnowledge[] {
  if (task === null || !/[\p{L}\p{N}_]/u.test(task)) {
    return [];
  }

  return store
    .search(task, { status: 'active', kinds: ['fact'], brainIds })
    .filter((memory) => isReadSetScopeApplicable(memory, scope, readSetProjectBrainIds))
    .filter((memory) => isCurrentlyValid(memory, today))
    .sort(compare)
    .map(toKnowledge);
}

/**
 * A v0.3 ReadSet is the daemon's explicit grant for automatic workspace
 * reads.  Hosts commonly send `scope: global` because they do not know the
 * project UUID; a granted primary/linked project Brain must nevertheless be
 * allowed to contribute its own project-scoped memories.  Without this
 * exception the ReadSet grants the Brain but the scope filter silently drops
 * every project record.  Legacy requests (without a ReadSet) retain the
 * original strict scope semantics.
 */
function isReadSetScopeApplicable(
  memory: MemoryItem,
  requestedScope: MemoryScope,
  readSetProjectBrainIds: ReadonlySet<string> | undefined,
): boolean {
  if (isScopeApplicable(memory.scope, requestedScope)) {
    return true;
  }
  return (
    readSetProjectBrainIds !== undefined &&
    requestedScope.level === 'global' &&
    memory.scope.level === 'project' &&
    memory.scope.projectId === memory.brainId &&
    readSetProjectBrainIds.has(memory.brainId)
  );
}

function toDirective(policy: ApplicablePolicy, forceMandatory = false): ContextDirective {
  const { memory, data } = policy;
  return {
    memoryId: memory.id,
    brainId: memory.brainId,
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
    brainId: memory.brainId,
    name: memory.title ?? memory.canonicalText,
    steps: [...data.data.steps].sort((left, right) => left.order - right.order).map((step) => step.action),
  };
}

function toPreference(memory: MemoryItem): ContextPreference {
  return { memoryId: memory.id, brainId: memory.brainId, text: memory.canonicalText };
}

function toKnowledge(memory: MemoryItem): ContextKnowledge {
  return { memoryId: memory.id, brainId: memory.brainId, title: memory.title ?? memory.canonicalText, summary: memory.canonicalText };
}

function toDecision(memory: MemoryItem): ContextDecision {
  return { memoryId: memory.id, brainId: memory.brainId, text: memory.canonicalText };
}

function compareByBrainThenSpecificity(brainIds: readonly string[]): (left: MemoryItem, right: MemoryItem) => number {
  const priority = new Map(brainIds.map((brainId, index) => [brainId, index]));
  return (left, right) =>
    priority.get(left.brainId)! - priority.get(right.brainId)! || compareMemorySpecificity(left, right);
}

function candidate(
  item: { readonly memoryId: string },
  memoryRank: number,
  text: string,
  mandatory: boolean,
  reason: string,
  apply: () => void,
): Candidate {
  return {
    memoryId: item.memoryId,
    memoryRank,
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
