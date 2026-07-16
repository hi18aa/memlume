import { NonEmptyTextSchema, UuidV7Schema } from '@memlume/contracts';

export type BrainCatalogRole = 'primary' | 'linked' | 'personal';

export interface BrainCatalogEntry {
  readonly brainId: string;
  readonly kind: 'personal' | 'project';
  readonly role?: BrainCatalogRole;
  readonly access?: 'read' | 'read_write';
  readonly writable?: boolean;
  readonly name?: string;
  readonly aliases?: readonly string[];
  readonly keys?: readonly string[];
}

export interface RoutableAtom {
  readonly scope: 'personal' | 'project';
  readonly targetRef?: string;
}

export interface BrainRouterInput {
  readonly atom: RoutableAtom;
  readonly catalog: readonly BrainCatalogEntry[];
  readonly workspaceKey?: string;
}

export type BrainRouteResult =
  | { readonly status: 'routed'; readonly brainId: string; readonly reason: 'personal' | 'primary_project' | 'linked_project_match' }
  | { readonly status: 'routing_required'; readonly reason: 'unknown_project' | 'ambiguous_project' | 'no_personal' | 'ambiguous_personal' | 'no_writable_brain' | 'invalid_provider_target'; readonly candidates: readonly string[] };

/** Resolve semantic scope against a daemon-owned, already validated catalog. */
export function routeAtom(input: BrainRouterInput): BrainRouteResult {
  const atom = input.atom as RoutableAtom & { readonly brainId?: unknown };
  if (Object.hasOwn(atom, 'brainId')) {
    return { status: 'routing_required', reason: 'invalid_provider_target', candidates: [] };
  }
  const catalog = input.catalog.filter((entry) => validEntry(entry));
  if (input.atom.scope === 'personal') {
    const personal = catalog.filter((entry) => entry.kind === 'personal' && writable(entry));
    if (personal.length === 0) return { status: 'routing_required', reason: 'no_personal', candidates: [] };
    if (personal.length > 1) return { status: 'routing_required', reason: 'ambiguous_personal', candidates: personal.map((entry) => entry.brainId) };
    return { status: 'routed', brainId: personal[0].brainId, reason: 'personal' };
  }

  const projects = catalog.filter((entry) => entry.kind === 'project' && writable(entry));
  const target = normalize(input.atom.targetRef);
  if (target !== undefined) {
    const matches = projects.filter((entry) => matchesReference(entry, target));
    if (matches.length === 1) {
      const role = matches[0].role === 'linked' ? 'linked_project_match' : 'primary_project';
      return { status: 'routed', brainId: matches[0].brainId, reason: role };
    }
    return matches.length === 0
      ? { status: 'routing_required', reason: 'unknown_project', candidates: [] }
      : { status: 'routing_required', reason: 'ambiguous_project', candidates: matches.map((entry) => entry.brainId) };
  }
  const primary = projects.filter((entry) => entry.role === 'primary');
  if (primary.length === 1) return { status: 'routed', brainId: primary[0].brainId, reason: 'primary_project' };
  return primary.length === 0
    ? { status: 'routing_required', reason: 'unknown_project', candidates: [] }
    : { status: 'routing_required', reason: 'ambiguous_project', candidates: primary.map((entry) => entry.brainId) };
}

export class BrainRouter {
  route(input: BrainRouterInput): BrainRouteResult {
    return routeAtom(input);
  }
}

function validEntry(entry: BrainCatalogEntry): boolean {
  return UuidV7Schema.safeParse(entry.brainId).success && (entry.kind === 'personal' || entry.kind === 'project');
}

function writable(entry: BrainCatalogEntry): boolean {
  return entry.writable === true || entry.access === 'read_write' || entry.access === undefined;
}

function matchesReference(entry: BrainCatalogEntry, target: string): boolean {
  return [entry.name, ...(entry.aliases ?? []), ...(entry.keys ?? [])]
    .map(normalize)
    .some((value) => value !== undefined && value === target);
}

function normalize(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = NonEmptyTextSchema.safeParse(value);
  return parsed.success ? parsed.data.toLocaleLowerCase().replace(/[\\/]+/gu, '/').replace(/\s+/gu, ' ') : undefined;
}
