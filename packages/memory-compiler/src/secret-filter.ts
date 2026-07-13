export interface SecretRedaction {
  readonly detected: boolean;
  readonly redacted: string;
}

const privateKeyPattern = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/giu;
const environmentSecretPattern = /\b((?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|AUTH_TOKEN))(\s*=\s*)[^\r\n,，。]+/gu;
const assignedSecretPattern = /(?:(\bapi[ _-]?key|\bpassword|\bpasswd|\bsecret|\baccess[ _-]?token|\btoken)(\s*(?:[:=]|\bis\b)\s*)|((?:密碼|私鑰|金鑰))(\s*(?:是|為|[:=])\s*))[^\r\n,，。]+/giu;
const authorizationBearerPattern = /(\bauthorization\s*:\s*bearer\s+)[^\s,，。]+/giu;
const standaloneTokenPattern = /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/giu;

export function redactSecrets(content: string): SecretRedaction {
  let detected = false;
  const redactedPrivateKeys = content.replace(privateKeyPattern, () => {
    detected = true;
    return '[redacted private key]';
  });
  const redactedEnvironmentSecrets = redactedPrivateKeys.replace(environmentSecretPattern, (_match, name: string, separator: string) => {
    detected = true;
    return `${name}${separator}[redacted]`;
  });
  const redactedAssignments = redactedEnvironmentSecrets.replace(assignedSecretPattern, (_match, englishName: string | undefined, englishSeparator: string | undefined, chineseName: string | undefined, chineseSeparator: string | undefined) => {
    detected = true;
    return englishName === undefined
      ? `${chineseName}${chineseSeparator}[redacted]`
      : `${englishName}${englishSeparator}[redacted]`;
  });
  const redactedAuthorization = redactedAssignments.replace(authorizationBearerPattern, (_match, prefix: string) => {
    detected = true;
    return `${prefix}[redacted]`;
  });
  const redacted = redactedAuthorization.replace(standaloneTokenPattern, () => {
    detected = true;
    return '[redacted token]';
  });
  return { detected, redacted };
}
