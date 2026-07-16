import { redactSensitiveText } from '@memlume/contracts';
import { z } from 'zod';

/** The only model output accepted by the capture compiler.  A provider may
 * describe a target reference, but it can never choose a Brain UUID. */
export const StructuredProviderAtomSchema = z.object({
  text: z.string().trim().min(1),
  scope: z.enum(['personal', 'project']),
  targetRef: z.string().trim().min(1).optional(),
  kind: z.enum(['fact', 'preference', 'decision', 'event', 'capability']).default('fact'),
  confidence: z.number().min(0).max(1).default(0.5),
  evidence: z.string().trim().min(1).optional(),
}).strict();
export type StructuredProviderAtom = z.infer<typeof StructuredProviderAtomSchema>;

export const StructuredProviderResponseSchema = z.object({
  atoms: z.array(StructuredProviderAtomSchema).max(32),
}).strict();
export type StructuredProviderResponse = z.infer<typeof StructuredProviderResponseSchema>;

export interface StructuredCaptureProviderInput {
  readonly sourceReference: string;
  readonly content: string;
  readonly actor: 'user' | 'assistant' | 'tool';
}

export interface StructuredCaptureProvider {
  extract(input: StructuredCaptureProviderInput): Promise<unknown>;
}

export interface OpenAICompatibleProviderOptions {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey?: string;
  /** Cloud transfer is opt-in. Local Ollama/llama.cpp endpoints may omit it. */
  readonly allowExternalTransfer?: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/** Minimal native-fetch provider for OpenAI-compatible local or remote APIs. */
export class OpenAICompatibleProvider implements StructuredCaptureProvider {
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenAICompatibleProviderOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0 ? options.timeoutMs! : 10_000;
    if (!options.endpoint.startsWith('http://') && !options.endpoint.startsWith('https://')) {
      throw new Error('Provider endpoint must be an HTTP(S) URL.');
    }
    if (!options.model.trim()) {
      throw new Error('Provider model is required.');
    }
  }

  async extract(input: StructuredCaptureProviderInput): Promise<StructuredProviderResponse> {
    const redacted = redactSensitiveText(input.content);
    if (redacted.detected) {
      throw new Error('secret_detected');
    }
    const endpoint = new URL(this.options.endpoint);
    const isLocal = endpoint.hostname === '127.0.0.1' || endpoint.hostname === 'localhost' || endpoint.hostname === '::1';
    if (!isLocal && this.options.allowExternalTransfer !== true) {
      throw new Error('external_transfer_not_allowed');
    }
    const response = await this.fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        ...(this.options.apiKey === undefined ? {} : { authorization: `Bearer ${this.options.apiKey}` }),
      },
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: `Return strict JSON {"atoms":[{"text":string,"scope":"personal"|"project","targetRef"?:string,"kind"?:string,"confidence"?:number,"evidence"?:string]}. No brainId. Source: ${input.sourceReference}\n${redacted.redacted}`,
        }],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`provider_http_${response.status}`);
    }
    const payload = await response.json() as unknown;
    const message = extractMessage(payload);
    let parsed: unknown = message;
    if (typeof message === 'string') {
      try { parsed = JSON.parse(message); } catch { throw new Error('provider_invalid_json'); }
    }
    return StructuredProviderResponseSchema.parse(parsed);
  }
}

function extractMessage(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload;
  const value = payload as Record<string, unknown>;
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0) return payload;
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return payload;
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null) return payload;
  return (message as Record<string, unknown>).content;
}
