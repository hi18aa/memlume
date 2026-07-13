import { describe, expect, test } from 'vitest';

import { redactSensitiveJson, redactSensitiveText } from '../src/index.js';

describe('sensitive value redaction', () => {
  test('redacts credential-shaped text without treating ordinary token discussion as a secret', () => {
    expect(redactSensitiveText('Authorization: Bearer bearer-secret-value')).toEqual({
      detected: true,
      redacted: 'Authorization: Bearer [redacted]',
    });
    expect(redactSensitiveText('Keep the token budget under 500 units.')).toEqual({
      detected: false,
      redacted: 'Keep the token budget under 500 units.',
    });
  });

  test('redacts sensitive keys and nested credential-shaped values in any JSON payload', () => {
    const secret = 'sk-live-never-persist-this';

    expect(
      redactSensitiveJson({
        apiKey: secret,
        nested: [{ authorization: 'Bearer bearer-secret-value' }, { note: `OPENAI_API_KEY=${secret}` }],
        normal: 'Vue frontend',
      }),
    ).toEqual({
      detected: true,
      redacted: {
        apiKey: '[redacted]',
        nested: [{ authorization: '[redacted]' }, { note: 'OPENAI_API_KEY=[redacted]' }],
        normal: 'Vue frontend',
      },
    });
  });

  test('keeps ordinary token-named JSON fields while redacting credential keys', () => {
    expect(
      redactSensitiveJson({
        tokenBudget: 500,
        tokenCount: 42,
        accessToken: 'adapter-secret',
      }),
    ).toEqual({
      detected: true,
      redacted: {
        tokenBudget: 500,
        tokenCount: 42,
        accessToken: '[redacted]',
      },
    });
  });

  test('redacts arbitrary environment-style credential keys even when their opaque values are short', () => {
    expect(
      redactSensitiveJson({
        OPENAI_API_KEY: 'abc',
        MY_AUTH_TOKEN: 'xyz',
        tokenBudget: 500,
        tokenCount: 42,
      }),
    ).toEqual({
      detected: true,
      redacted: {
        OPENAI_API_KEY: '[redacted]',
        MY_AUTH_TOKEN: '[redacted]',
        tokenBudget: 500,
        tokenCount: 42,
      },
    });
  });
});
