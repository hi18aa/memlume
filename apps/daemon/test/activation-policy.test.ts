import { describe, expect, test } from 'vitest';

import { activationPolicy } from '../src/activation-policy.js';

describe('activationPolicy', () => {
  test('activates only clear user assertions', () => {
    expect(activationPolicy({ atom: { actor: 'user', confidence: 1, explicitness: 1 }, route: 'routed' })).toBe('active');
    expect(activationPolicy({ atom: { actor: 'assistant', confidence: 1, explicitness: 1 }, route: 'routed' })).toBe('candidate');
    expect(activationPolicy({ atom: { actor: 'user', confidence: 0.5, explicitness: 0 }, route: 'routed', authorized: true })).toBe('active');
  });

  test('keeps events and unknown routes out of active memory', () => {
    expect(activationPolicy({ atom: { actor: 'user', kind: 'event', confidence: 1, explicitness: 1 }, route: 'routed' })).toBe('event_only');
    expect(activationPolicy({ atom: { actor: 'user', confidence: 1, explicitness: 1 }, route: 'routing_required' })).toBe('routing_required');
  });
});
