import { CaptureReceiptSchema, type CaptureReceipt } from '@memlume/contracts';
import { compileCapture, type CompileCaptureInput } from '@memlume/memory-compiler';
import { activationPolicy } from './activation-policy.js';
import { routeAtom, type BrainCatalogEntry } from '@memlume/shared-brains';

export interface CapturePipelineInput extends Omit<CompileCaptureInput, 'captureId'> {
  readonly captureId: string;
  readonly catalog: readonly BrainCatalogEntry[];
  readonly now?: string;
}

export interface CapturePipelineResult {
  readonly receipt: CaptureReceipt;
  readonly atoms: readonly AtomPlan[];
}

export type AtomPlan = {
  readonly atomKey: string;
  readonly route: ReturnType<typeof routeAtom>;
  readonly status: ReturnType<typeof activationPolicy>;
  readonly text: string;
  readonly canonicalText: string;
  readonly scope: 'personal' | 'project';
  readonly kind: 'fact' | 'preference' | 'decision' | 'event' | 'capability';
  readonly confidence: number;
  readonly explicitness: number;
  readonly evidence: string;
};

/** Pure admission → routing → activation plan used by every daemon entrypoint. */
export async function planCapture(input: CapturePipelineInput): Promise<CapturePipelineResult> {
  const compilation = await compileCapture({ ...input, captureId: input.captureId });
  const now = input.now ?? new Date().toISOString();
  const atomPlans: AtomPlan[] = [];
  if (compilation.atoms.length > 0) {
    for (const atom of compilation.atoms) {
      const route = routeAtom({ atom, catalog: input.catalog });
      const status = activationPolicy({ atom, route: route.status });
      atomPlans.push({
        route,
        atomKey: atom.atomKey,
        status,
        text: atom.text,
        canonicalText: atom.canonicalText,
        scope: atom.scope,
        kind: atom.kind,
        confidence: atom.confidence,
        explicitness: atom.explicitness,
        evidence: atom.evidence,
      });
    }
  }
  const atoms = atomPlans.map((plan) => ({
    atomKey: plan.atomKey,
    status: plan.status as CaptureReceipt['status'],
    ...(plan.route.status === 'routed' ? { brainId: plan.route.brainId } : {}),
    ...(plan.status === 'routing_required' ? { reason: 'routing_required' } : {}),
  }));
  const status = aggregateStatus(compilation.status, atoms.map((atom) => atom.status));
  const receipt = CaptureReceiptSchema.parse({
    captureId: input.captureId,
    sourceReference: compilation.sourceReference,
    status,
    atoms,
    createdAt: now,
    updatedAt: now,
  });
  return { receipt, atoms: atomPlans };
}

function aggregateStatus(compilation: string, atomStatuses: readonly string[]): CaptureReceipt['status'] {
  if (atomStatuses.length === 0) return (compilation === 'accepted' ? 'ignored' : compilation) as CaptureReceipt['status'];
  const order: readonly CaptureReceipt['status'][] = ['failed', 'rejected', 'routing_required', 'candidate', 'event_only', 'active', 'queued', 'ignored'];
  return order.find((candidate) => atomStatuses.includes(candidate)) ?? 'failed';
}
