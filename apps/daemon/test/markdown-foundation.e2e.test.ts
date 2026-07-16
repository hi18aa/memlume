import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PERSONAL_BRAIN_ID, createUuidV7 } from '@memlume/contracts';
import { openDatabase } from '@memlume/database/internal';
import { EventJournal } from '@memlume/event-journal';
import { MemoryStore } from '@memlume/retrieval';
import { SemanticMemoryService } from '../src/semantic-memory-service.js';

const fixtures: Array<{ readonly root: string; readonly database: ReturnType<typeof openDatabase> }> = [];

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop()!;
    fixture.database.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createFixture(): { readonly root: string; readonly database: ReturnType<typeof openDatabase>; readonly service: SemanticMemoryService } {
  const root = mkdtempSync(join(tmpdir(), 'memlume-markdown-foundation-'));
  const database = openDatabase(join(root, 'memlume.sqlite'));
  const service = new SemanticMemoryService({
    journal: new EventJournal(database),
    store: new MemoryStore(database, { markdownRoot: root }),
  });
  const fixture = { root, database, service };
  fixtures.push(fixture);
  return fixture;
}

describe('Markdown authority daemon foundation', () => {
  test('requires an explicit Brain and persists a capture through Markdown first', () => {
    const { service, database, root } = createFixture();
    expect(() => service.appendEvent({
      rawContent: 'unrouted',
      eventType: 'user_message',
      source: { agent: 'codex', reference: 'missing-brain' },
    })).toThrow(/brainId/i);
    expect(database.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 0 });

    const event = service.appendEvent({
      brainId: DEFAULT_PERSONAL_BRAIN_ID,
      rawContent: 'I use Vue for frontend.',
      eventType: 'user_message',
      source: { agent: 'codex', reference: 'capture:1' },
    });
    const memory = service.saveMemory({
      brainId: DEFAULT_PERSONAL_BRAIN_ID,
      kind: 'fact',
      canonicalText: 'The frontend uses Vue.',
      structuredData: { subject: 'frontend', predicate: 'framework', object: 'Vue', confidence: 1 },
      scope: { level: 'global' },
      sourceEventId: event.id,
    });
    expect(memory.brainId).toBe(DEFAULT_PERSONAL_BRAIN_ID);
    expect(database.prepare('SELECT COUNT(*) AS count FROM record_projections WHERE memory_id = ?').get(memory.id)).toEqual({ count: 1 });
    expect(root).toContain('memlume-markdown-foundation-');
  });

  test('capture binds its memory to the event Brain and never accepts a caller Brain mismatch', () => {
    const { service } = createFixture();
    const otherBrainId = createUuidV7();
    expect(() => service.capture({
      event: {
        brainId: DEFAULT_PERSONAL_BRAIN_ID,
        rawContent: 'shared event',
        eventType: 'user_message',
        source: { agent: 'codex', reference: 'capture:2' },
      },
      memory: {
        brainId: otherBrainId,
        kind: 'fact',
        canonicalText: 'A mismatched brain must be rejected.',
        structuredData: { subject: 'test', predicate: 'state', object: 'invalid', confidence: 1 },
        scope: { level: 'global' },
      },
    })).toThrow(/brain_missing|brain|foreign/i);
  });
});
