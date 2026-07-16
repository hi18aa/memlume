import { describe, expect, test } from 'vitest';

import { INIT_STEPS, runInit, type InitStep } from '../src/init.js';

describe('reentrant init sequence', () => {
  test('runs the fixed order and resumes after a failed external host step', async () => {
    const calls: InitStep[] = [];
    const first = await runInit({
      async run(step) {
        calls.push(step);
        if (step === 'host activation') throw new Error('trust required');
      },
    });
    expect(calls).toEqual(INIT_STEPS.slice(0, 7));
    expect(first.failed?.step).toBe('host activation');
    const second = await runInit({
      completed: new Set(first.completed),
      async run(step) { calls.push(step); },
    });
    expect(second.failed).toBeUndefined();
    expect(second.skipped).toEqual(INIT_STEPS.slice(0, 6));
    expect(calls.at(-1)).toBe('Core read/write smoke test');
  });
});
