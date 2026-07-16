export type ActivationStatus = 'active' | 'candidate' | 'event_only' | 'routing_required' | 'ignored' | 'rejected' | 'failed';

export interface ActivationAtom {
  readonly actor?: 'user' | 'assistant' | 'tool';
  readonly kind?: 'fact' | 'preference' | 'decision' | 'event' | 'capability';
  readonly confidence?: number;
  readonly explicitness?: number;
  readonly text?: string;
  readonly conflict?: boolean;
  readonly stable?: boolean;
}

export interface ActivationInput {
  readonly atom: ActivationAtom;
  readonly route: 'routed' | 'routing_required';
  readonly admitted?: boolean;
  /** A buffered assistant final explicitly authorized by the user. */
  readonly authorized?: boolean;
}

/** A single policy shared by daemon, CLI and adapters. */
export function activationPolicy(input: ActivationInput): ActivationStatus {
  if (input.admitted === false) return 'rejected';
  const atom = input.atom;
  if (atom.kind === 'event') return 'event_only';
  if (input.route === 'routing_required') return 'routing_required';
  if (atom.actor !== 'user') return 'candidate';
  if (input.authorized === true) return 'active';
  if (atom.conflict === true || atom.stable === false) return 'candidate';
  if ((atom.explicitness ?? 0) < 1 || (atom.confidence ?? 0) < 0.8) return 'candidate';
  return 'active';
}

export const assessActivation = activationPolicy;
