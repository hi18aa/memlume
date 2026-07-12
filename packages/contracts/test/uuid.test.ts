import { describe, expect, test } from 'vitest';

import * as contracts from '../src/index.js';

type CreateUuidV7 = () => string;
const { createUuidV7 } = contracts as { createUuidV7?: CreateUuidV7 };

describe('createUuidV7', () => {
  test('creates a UUIDv7 accepted by the shared contract', () => {
    expect(createUuidV7).toBeTypeOf('function');
    expect(createUuidV7!()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});
