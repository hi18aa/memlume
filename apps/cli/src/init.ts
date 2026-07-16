export const INIT_STEPS = [
  'daemon ensure',
  'setup token',
  'personal Brain',
  'project binding',
  'host detection',
  'installation and mount',
  'host activation',
  'Core read/write smoke test',
] as const;

export type InitStep = typeof INIT_STEPS[number];

export interface InitOperations {
  run(step: InitStep): Promise<void>;
  readonly completed?: ReadonlySet<InitStep>;
}

export interface InitResult {
  readonly completed: readonly InitStep[];
  readonly skipped: readonly InitStep[];
  readonly failed?: { readonly step: InitStep; readonly error: Error };
}

/** Execute init in a fixed, resumable order; external Host changes are never rolled back. */
export async function runInit(operations: InitOperations): Promise<InitResult> {
  const completed = [...(operations.completed ?? [])];
  const skipped: InitStep[] = [];
  const already = new Set(completed);
  for (const step of INIT_STEPS) {
    if (already.has(step)) {
      skipped.push(step);
      continue;
    }
    try {
      await operations.run(step);
      completed.push(step);
      already.add(step);
    } catch (cause) {
      return {
        completed,
        skipped,
        failed: { step, error: cause instanceof Error ? cause : new Error(String(cause)) },
      };
    }
  }
  return { completed, skipped };
}
