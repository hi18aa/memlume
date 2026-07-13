import { redactSensitiveText, type SensitiveTextRedaction } from '@memlume/contracts';

export type SecretRedaction = SensitiveTextRedaction;
export const redactSecrets = redactSensitiveText;
