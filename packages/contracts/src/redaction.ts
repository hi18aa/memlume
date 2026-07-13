import type { JsonValue } from './memory.js';

export interface SensitiveTextRedaction {
  readonly detected: boolean;
  readonly redacted: string;
}

export interface SensitiveJsonRedaction {
  readonly detected: boolean;
  readonly redacted: JsonValue;
}

const privateKeyPattern = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/giu;
const environmentSecretPattern = /\b((?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|AUTH_TOKEN))(\s*=\s*)[^\r\n,，。]+/gu;
const assignedSecretPattern = /(?:(\bapi[ _-]?key|\bpassword|\bpasswd|\bsecret|\baccess[ _-]?token|\btoken)(\s*(?:[:=]|\bis\b)\s*)|((?:密碼|私鑰|金鑰))(\s*(?:是|為|[:=])\s*))[^\r\n,，。]+/giu;
const authorizationBearerPattern = /(\bauthorization\s*:\s*bearer\s+)[^\s,，。]+/giu;
const standaloneTokenPattern = /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/giu;
const sensitiveKeyPattern = /^(?:(?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|AUTH_TOKEN)|api[ _-]?key|(?:access|auth|refresh|id|bearer|session)?[ _-]?token|password|passwd|authorization|(?:client|app|webhook)?[ _-]?secret|private[ _-]?key)$/iu;

export function redactSensitiveText(content: string): SensitiveTextRedaction {
  let detected = false;
  const privateKeys = content.replace(privateKeyPattern, () => {
    detected = true;
    return '[redacted private key]';
  });
  const environmentSecrets = privateKeys.replace(environmentSecretPattern, (_match, name: string, separator: string) => {
    detected = true;
    return `${name}${separator}[redacted]`;
  });
  const assignments = environmentSecrets.replace(
    assignedSecretPattern,
    (_match, englishName: string | undefined, englishSeparator: string | undefined, chineseName: string | undefined, chineseSeparator: string | undefined) => {
      detected = true;
      return englishName === undefined ? `${chineseName}${chineseSeparator}[redacted]` : `${englishName}${englishSeparator}[redacted]`;
    },
  );
  const authorization = assignments.replace(authorizationBearerPattern, (_match, prefix: string) => {
    detected = true;
    return `${prefix}[redacted]`;
  });
  const redacted = authorization.replace(standaloneTokenPattern, () => {
    detected = true;
    return '[redacted token]';
  });
  return { detected, redacted };
}

export function redactSensitiveJson(value: JsonValue): SensitiveJsonRedaction {
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }
  if (value === null || typeof value !== 'object') {
    return { detected: false, redacted: value };
  }
  if (Array.isArray(value)) {
    let detected = false;
    const redacted = value.map((item) => {
      const result = redactSensitiveJson(item);
      detected ||= result.detected;
      return result.redacted;
    });
    return { detected, redacted };
  }

  let detected = false;
  const redacted: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKeyPattern.test(key)) {
      detected = true;
      redacted[key] = '[redacted]';
      continue;
    }
    const result = redactSensitiveJson(item);
    detected ||= result.detected;
    redacted[key] = result.redacted;
  }
  return { detected, redacted };
}
