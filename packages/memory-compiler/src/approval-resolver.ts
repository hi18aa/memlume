import { createHash } from 'node:crypto';

import { redactSensitiveText } from '@memlume/contracts';

import { compileCapture, type CaptureAtom } from './compile-capture.js';

export type ApprovalResolutionStatus = 'active' | 'ignored' | 'routing_required' | 'rejected';
export type ApprovalResolutionMode = 'approval' | 'correction';

export interface ApprovalResolverInput {
  readonly finalAnswer?: string;
  readonly approval: string;
  readonly finalCapturedAt?: string;
  readonly now?: string;
  readonly provider?: Parameters<typeof compileCapture>[0]['provider'];
}

export interface ApprovalResolution {
  readonly status: ApprovalResolutionStatus;
  readonly mode?: ApprovalResolutionMode;
  readonly approvalKey: string;
  /** Sanitized text that was authorized and may be routed as a new capture. */
  readonly content?: string;
  readonly sourceReference?: string;
  readonly atoms: readonly CaptureAtom[];
  readonly reason?: 'no_buffer' | 'expired' | 'not_approval' | 'secret_detected' | 'ambiguous' | 'provider_failed';
}

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const approvalPattern = /^(?:可以|可以的|同意|照做|好|好的|沒問題|没问题|yes|ok(?:ay)?|approve|approved|go ahead|do it)\s*[!！。.]?$/iu;
const correctionPattern = /^(?:修正|更正|改成|改為|改为|其實|其实|actually|correction)\s*[:：,，]?\s*(.+)$/iu;

/** Resolve a short user approval against one previously buffered assistant turn. */
export async function resolveApproval(input: ApprovalResolverInput): Promise<ApprovalResolution> {
  const approval = normalize(input.approval);
  const approvalKey = stableApprovalKey(input.finalAnswer ?? '', approval);
  if (redactSensitiveText(input.approval).detected || (input.finalAnswer !== undefined && redactSensitiveText(input.finalAnswer).detected)) {
    return { status: 'rejected', approvalKey, atoms: [], reason: 'secret_detected' };
  }
  const finalAnswer = normalize(input.finalAnswer ?? '');
  if (finalAnswer === '') return { status: 'ignored', approvalKey, atoms: [], reason: 'no_buffer' };
  if (input.finalCapturedAt !== undefined) {
    const capturedAt = Date.parse(input.finalCapturedAt);
    const now = Date.parse(input.now ?? new Date().toISOString());
    if (!Number.isFinite(capturedAt) || !Number.isFinite(now) || now - capturedAt > APPROVAL_TTL_MS || now < capturedAt) {
      return { status: 'ignored', approvalKey, atoms: [], reason: 'expired' };
    }
  }
  const correction = correctionPattern.exec(approval);
  const mode: ApprovalResolutionMode = correction === null ? 'approval' : 'correction';
  if (correction === null && !approvalPattern.test(approval)) {
    return { status: 'ignored', approvalKey, atoms: [], reason: 'not_approval' };
  }
  const content = correction?.[1] === undefined ? finalAnswer : normalize(correction[1]);
  if (content === '') return { status: 'ignored', approvalKey, atoms: [], reason: 'ambiguous' };
  const compiled = await compileCapture({
    rawContent: content,
    captureId: approvalKey,
    actor: 'user',
    provider: input.provider,
  });
  if (compiled.status === 'rejected') return { status: 'rejected', approvalKey, atoms: [], reason: compiled.reason === 'secret_detected' ? 'secret_detected' : 'ambiguous' };
  if (compiled.status === 'failed') return { status: 'routing_required', approvalKey, atoms: [], reason: 'provider_failed' };
  if (compiled.atoms.length === 0) return { status: 'ignored', approvalKey, atoms: [], reason: compiled.reason === 'ambiguous' ? 'ambiguous' : 'not_approval' };
  // The approval itself is the user authorization. Do not carry assistant
  // confidence into the active record, but preserve the atom's evidence.
  const atoms = compiled.atoms.map((atom) => ({ ...atom, actor: 'user' as const, confidence: 1, explicitness: 1 }));
  return { status: 'active', mode, approvalKey, content, sourceReference: compiled.sourceReference, atoms };
}

export function stableApprovalKey(finalAnswer: string, approval: string): string {
  return `approval-${createHash('sha256').update(`${normalize(finalAnswer)}\n${normalize(approval)}`).digest('hex').slice(0, 32)}`;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}
