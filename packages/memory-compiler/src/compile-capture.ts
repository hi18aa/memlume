import { createHash } from 'node:crypto';

import { redactSensitiveText } from '@memlume/contracts';

import { StructuredProviderResponseSchema, type StructuredCaptureProvider } from './provider.js';

export type CaptureScope = 'personal' | 'project';
export type CaptureAtomKind = 'fact' | 'preference' | 'decision' | 'event' | 'capability';

export interface CaptureAtom {
  readonly atomKey: string;
  readonly text: string;
  readonly canonicalText: string;
  readonly scope: CaptureScope;
  readonly targetRef?: string;
  readonly kind: CaptureAtomKind;
  readonly confidence: number;
  readonly explicitness: number;
  readonly evidence: string;
  readonly actor: 'user' | 'assistant' | 'tool';
}

export type CaptureCompilationStatus = 'accepted' | 'ignored' | 'rejected' | 'routing_required' | 'failed';

export interface CompileCaptureInput {
  readonly rawContent: string;
  readonly captureId?: string;
  readonly sourceReference?: string;
  readonly source?: { readonly reference?: string; readonly agent?: string; readonly type?: string };
  readonly eventType?: string;
  readonly actor?: 'user' | 'assistant' | 'tool';
  readonly provider?: StructuredCaptureProvider;
}

export interface CompileCaptureResult {
  readonly status: CaptureCompilationStatus;
  readonly sourceReference: string;
  readonly atoms: readonly CaptureAtom[];
  readonly reason?: 'empty' | 'greeting' | 'secret_detected' | 'provider_failed' | 'provider_invalid' | 'ambiguous';
}

const explicitPattern = /^\s*(?:(?:請|請你)\s*)?(?:記住|記下|記錄|remember|memorize|save(?:\s+this)?)\s*[,，:：]?\s*/iu;
const greetingPattern = /^(?:hi|hello|hey|嗨|哈囉|你好|早安|晚安)[!！。、,.\s]*$/iu;
const splitPattern = /(?:[。.!！?？;；\n]+|(?:\s+and\s+)|(?:\s+並且\s+)|(?:\s+以及\s+))/iu;

/** Secret filtering and deterministic admission/atomization for one user capture. */
export async function compileCapture(input: CompileCaptureInput): Promise<CompileCaptureResult> {
  const rawContent = typeof input.rawContent === 'string' ? input.rawContent : '';
  const redacted = redactSensitiveText(rawContent);
  const sourceReference = stableSourceReference(input);
  if (redacted.detected) return { status: 'rejected', sourceReference, atoms: [], reason: 'secret_detected' };
  const normalized = normalizeText(redacted.redacted.replace(explicitPattern, ''));
  if (normalized === '') return { status: 'ignored', sourceReference, atoms: [], reason: 'empty' };
  if (greetingPattern.test(normalized)) return { status: 'ignored', sourceReference, atoms: [], reason: 'greeting' };
  const actor = input.actor ?? (input.eventType === 'agent_inference' ? 'assistant' : 'user');
  const explicit = actor === 'user' && explicitPattern.test(rawContent);
  const chunks = normalized.split(splitPattern).map(normalizeText).filter(Boolean);
  const atoms = chunks.map((text, occurrence) => deterministicAtom(text, {
    sourceReference,
    occurrence,
    actor,
    explicit,
  }));
  if (atoms.length > 0) {
    return { status: 'accepted', sourceReference, atoms: dedupeAtoms(atoms) };
  }
  if (input.provider === undefined) return { status: 'routing_required', sourceReference, atoms: [], reason: 'ambiguous' };
  try {
    const output = StructuredProviderResponseSchema.parse(await input.provider.extract({ sourceReference, content: redacted.redacted, actor }));
    const providerAtoms = output.atoms.map((atom: (typeof output.atoms)[number], occurrence: number) => providerAtom(atom, { sourceReference, occurrence, actor, explicit }));
    return providerAtoms.length === 0
      ? { status: 'routing_required', sourceReference, atoms: [], reason: 'ambiguous' }
      : { status: 'accepted', sourceReference, atoms: dedupeAtoms(providerAtoms) };
  } catch (error) {
    return { status: 'failed', sourceReference, atoms: [], reason: error instanceof Error && error.message === 'secret_detected' ? 'secret_detected' : 'provider_failed' };
  }
}

export function atomKeyFor(sourceReference: string, evidence: string, occurrence = 0): string {
  const normalized = normalizeText(evidence).toLocaleLowerCase();
  return `atom-${createHash('sha256').update(`${sourceReference}\n${normalized}\n${occurrence}`).digest('hex').slice(0, 32)}`;
}

function deterministicAtom(text: string, input: { sourceReference: string; occurrence: number; actor: CaptureAtom['actor']; explicit: boolean }): CaptureAtom {
  const lower = text.toLocaleLowerCase();
  const project = /(?:這個|該|目前的)?\s*(?:專案|project\b|repo(?:sitory)?\b|公司|company\b)/iu.test(text);
  const timeline = /(?:出生|加入|成立|創立|任職|工作於|時間軸|timeline|in \d{4}|\d{4}年)/iu.test(text);
  const preference = /(?:偏好|喜歡|prefer(?:s|red)?|preference|不喜歡)/iu.test(text);
  const decision = /(?:決定|採用|decision|選擇|choose|use)\b/iu.test(text);
  const scope: CaptureScope = project ? 'project' : 'personal';
  const kind: CaptureAtomKind = timeline ? 'event' : preference ? 'preference' : decision ? 'decision' : 'fact';
  const targetRef = project ? projectReference(text) : undefined;
  return {
    atomKey: atomKeyFor(input.sourceReference, text, input.occurrence),
    text,
    canonicalText: text.replace(/\s+/gu, ' ').trim(),
    scope,
    ...(targetRef === undefined ? {} : { targetRef }),
    kind,
    confidence: input.actor === 'assistant' ? 0.25 : input.explicit ? 1 : 0.5,
    explicitness: input.explicit ? 1 : 0,
    evidence: text,
    actor: input.actor,
  };
}

function providerAtom(atom: { text: string; scope: CaptureScope; targetRef?: string; kind: CaptureAtomKind; confidence: number; evidence?: string }, input: { sourceReference: string; occurrence: number; actor: CaptureAtom['actor']; explicit: boolean }): CaptureAtom {
  const evidence = normalizeText(atom.evidence ?? atom.text);
  return {
    atomKey: atomKeyFor(input.sourceReference, evidence, input.occurrence),
    text: normalizeText(atom.text),
    canonicalText: normalizeText(atom.text),
    scope: atom.scope,
    ...(atom.targetRef === undefined ? {} : { targetRef: normalizeText(atom.targetRef) }),
    kind: atom.kind,
    confidence: input.actor === 'assistant' ? Math.min(atom.confidence, 0.25) : atom.confidence,
    explicitness: input.explicit ? 1 : 0,
    evidence,
    actor: input.actor,
  };
}

function dedupeAtoms(atoms: readonly CaptureAtom[]): CaptureAtom[] {
  const seen = new Set<string>();
  return atoms.filter((atom) => !seen.has(atom.atomKey) && seen.add(atom.atomKey));
}

function projectReference(value: string): string | undefined {
  const match = /(?:專案|project|repo(?:sitory)?|公司|company)\s*(?:是|為|叫做|名為|:)?\s*([\p{L}\p{N}][\p{L}\p{N}_.-]*)/iu.exec(value);
  const candidate = match?.[1];
  return candidate !== undefined && !/^(?:使用|採用|選擇|是|為|叫做|名為)$/u.test(candidate) ? candidate : undefined;
}

function stableSourceReference(input: CompileCaptureInput): string {
  const explicit = input.captureId ?? input.sourceReference ?? input.source?.reference;
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();
  return `capture-${createHash('sha256').update(input.rawContent).digest('hex').slice(0, 32)}`;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').replace(/[。.!！?？]+$/u, '').trim();
}
