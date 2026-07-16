import {
  ReadSetSchema,
  UuidV7Schema,
  type ReadSet,
  type ReadSetEntry,
} from '@memlume/contracts';

export type ReadSetBrain = {
  readonly brainId: string;
  readonly kind: 'personal' | 'project';
  readonly name?: string;
  readonly aliases?: readonly string[];
  readonly access?: 'read' | 'read_write';
};

export type ReadSetPlannerInput = {
  readonly workspaceKey?: string;
  readonly task?: string | null;
  readonly entities?: readonly string[];
  readonly projectHints?: readonly string[];
  readonly brains: readonly ReadSetBrain[];
  /** Workspace binding selected by the daemon, never by an LLM. */
  readonly primaryProjectId?: string;
  readonly linkedProjectIds?: readonly string[];
  readonly personalBrainId?: string;
  /** Personal facts/preferences are added only after a relevant probe hit. */
  readonly personalRelevant?: boolean;
  /** A child task can only intersect its parent grant. */
  readonly parentGrant?: ReadSet;
  /** Codex/Claude subagents without a child goal are Primary-only. */
  readonly primaryOnly?: boolean;
};

/**
 * Produce the smallest server-controlled Brain set for one task.  Matching is
 * deliberately lexical and deterministic: it is an evidence gate, not a
 * semantic model, and therefore cannot invent a Brain UUID.
 */
export function planReadSet(input: ReadSetPlannerInput): ReadSet {
  const task = normalize(input.task ?? '');
  const hints = new Set([
    ...tokens(input.task ?? ''),
    ...(input.entities ?? []).flatMap(tokens),
    ...(input.projectHints ?? []).flatMap(tokens),
  ]);
  const primaryId = input.primaryProjectId === undefined ? undefined : UuidV7Schema.parse(input.primaryProjectId);
  const linked = new Set((input.linkedProjectIds ?? []).map((id) => UuidV7Schema.parse(id)));
  const personalId = input.personalBrainId === undefined ? undefined : UuidV7Schema.parse(input.personalBrainId);
  const entries: ReadSetEntry[] = [];
  const exclusions: ReadSet['exclusions'] = [];

  const catalog = input.brains.map((brain) => ({
    ...brain,
    brainId: UuidV7Schema.parse(brain.brainId),
    access: brain.access ?? 'read',
  }));
  const byId = new Map(catalog.map((brain) => [brain.brainId, brain]));
  const add = (brain: ReadSetBrain & { readonly brainId: string }, role: ReadSetEntry['role'], reason: string) => {
    if (entries.some((entry) => entry.brainId === brain.brainId)) return;
    entries.push({ brainId: UuidV7Schema.parse(brain.brainId), role, access: brain.access ?? 'read', reason });
  };

  if (primaryId !== undefined) {
    const primary = byId.get(primaryId);
    if (primary?.kind === 'project') {
      add(primary, 'primary', 'workspace primary project');
    } else {
      exclusions.push({ brainId: primaryId, reason: 'primary project is not mounted' });
    }
  }

  if (!input.primaryOnly) {
    for (const brain of catalog) {
      if (brain.kind !== 'project' || !linked.has(brain.brainId) || brain.brainId === primaryId) continue;
      const labels = [brain.name ?? '', ...(brain.aliases ?? [])].flatMap(tokens);
      const matched = labels.some((label) => hints.has(label)) || (labels.length > 0 && labels.some((label) => task.includes(label)));
      if (matched) add(brain, 'linked', 'linked project matched task/entity evidence');
      else exclusions.push({ brainId: brain.brainId, reason: 'linked project had no task/entity/name match' });
    }
  } else {
    for (const brain of catalog) {
      if (brain.kind === 'project' && linked.has(brain.brainId) && brain.brainId !== primaryId) {
        exclusions.push({ brainId: brain.brainId, reason: 'subagent has no child goal; primary-only grant' });
      }
    }
  }

  if (!input.primaryOnly && personalId !== undefined) {
    const personal = byId.get(personalId);
    if (personal?.kind === 'personal' && input.personalRelevant === true) {
      add(personal, 'personal', 'relevant personal probe matched');
    } else if (personal !== undefined) {
      exclusions.push({ brainId: personal.brainId, reason: 'personal Brain requires a relevant probe' });
    }
  }

  let result = ReadSetSchema.parse({
    ...(input.workspaceKey === undefined ? {} : { workspaceKey: input.workspaceKey }),
    entries,
    exclusions,
  });
  if (input.parentGrant !== undefined) {
    const allowed = new Set(input.parentGrant.entries.map((entry) => entry.brainId));
    const kept = result.entries.filter((entry) => allowed.has(entry.brainId));
    const removed = result.entries
      .filter((entry) => !allowed.has(entry.brainId))
      .map((entry) => ({ brainId: entry.brainId, reason: 'outside parent ReadSet grant' }));
    result = ReadSetSchema.parse({
      ...result,
      entries: kept,
      exclusions: [...result.exclusions, ...removed],
      ...(input.parentGrant.parentTraceId === undefined ? {} : { parentTraceId: input.parentGrant.parentTraceId }),
    });
  }
  return result;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function tokens(value: string): string[] {
  return (normalize(value).match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((token) => token.length > 1);
}

