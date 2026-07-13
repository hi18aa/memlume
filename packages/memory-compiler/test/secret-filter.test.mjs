import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as compiler from '../dist/index.js';

describe('secret filter', () => {
  test('redacts assigned passwords, keys, tokens, and private keys conservatively', () => {
    assert.equal(typeof compiler.redactSecrets, 'function');

    const cases = [
      ['password: correct-horse-battery-staple', 'password: [redacted]'],
      ['token=abc123', 'token=[redacted]'],
      ['password is correct horse battery staple', 'password is [redacted]'],
      ['私鑰是 super-secret', '私鑰是 [redacted]'],
      ['remember sk-live-not-for-memory', 'remember [redacted token]'],
      ['-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----', '[redacted private key]'],
    ];

    for (const [input, redacted] of cases) {
      assert.deepEqual(compiler.redactSecrets(input), { detected: true, redacted });
    }
  });

  test('does not classify ordinary technical language as a secret', () => {
    assert.deepEqual(compiler.redactSecrets('Keep the token budget under 500 units.'), {
      detected: false,
      redacted: 'Keep the token budget under 500 units.',
    });
  });

  test('redacts common environment and authorization credentials', () => {
    const cases = [
      ['OPENAI_API_KEY=sk-live-environment-secret', 'sk-live-environment-secret'],
      ['AUTH_TOKEN=authentication-secret-value', 'authentication-secret-value'],
      ['Authorization: Bearer bearer-secret-value', 'bearer-secret-value'],
    ];

    for (const [input, secret] of cases) {
      const result = compiler.redactSecrets(input);
      assert.equal(result.detected, true);
      assert.equal(result.redacted.includes(secret), false);
    }
  });
});
