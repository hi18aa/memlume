import { describe, expect, test } from 'vitest';

import {
  ContextPackSchema,
  EventSchema,
  MemoryItemSchema,
  MemoryKindSchema,
  MemoryScopeSchema,
  PolicyDataSchema,
} from '../src/index.js';

const ids = {
  event: '018f9d4e-7c2a-7b91-8dc0-61749dbcc01e',
  memory: '018f9d4e-7c2b-7b91-8dc0-61749dbcc01e',
  preference: '018f9d4e-7c2c-7b91-8dc0-61749dbcc01e',
  fact: '018f9d4e-7c2d-7b91-8dc0-61749dbcc01e',
  decision: '018f9d4e-7c2e-7b91-8dc0-61749dbcc01e',
  trace: '018f9d4e-7c2f-7b91-8dc0-61749dbcc01e',
} as const;

const policy = {
  trigger: { intents: ['image_generation'] },
  action: { type: 'route_tool', target: 'codex_img_gen_skill' },
  constraints: { exclusive: true },
};

describe('shared memory contracts', () => {
  test('accepts every supported memory kind and scoped identifiers', () => {
    expect(MemoryKindSchema.options).toEqual([
      'policy',
      'procedure',
      'preference',
      'fact',
      'decision',
      'capability',
    ]);

    expect(
      MemoryScopeSchema.parse({
        level: 'task',
        domain: 'development',
        agentId: 'codex',
        workspace: 'C:/work/memlume',
        projectId: 'memlume',
        taskId: 'task-3',
      }),
    ).toMatchObject({ level: 'task', taskId: 'task-3' });

    expect(MemoryScopeSchema.safeParse({ level: 'organization' }).success).toBe(false);
  });

  test('requires a matching scope identifier and rejects more-specific identifiers', () => {
    expect(MemoryScopeSchema.safeParse({ level: 'global' }).success).toBe(true);
    expect(MemoryScopeSchema.safeParse({ level: 'domain', domain: 'development' }).success).toBe(true);
    expect(MemoryScopeSchema.safeParse({ level: 'agent', domain: 'development', agentId: 'codex' }).success).toBe(
      true,
    );
    expect(MemoryScopeSchema.safeParse({ level: 'global', domain: 'development' }).success).toBe(false);
    expect(MemoryScopeSchema.safeParse({ level: 'domain' }).success).toBe(false);
    expect(MemoryScopeSchema.safeParse({ level: 'agent' }).success).toBe(false);
    expect(MemoryScopeSchema.safeParse({ level: 'workspace' }).success).toBe(false);
    expect(MemoryScopeSchema.safeParse({ level: 'project' }).success).toBe(false);
    expect(MemoryScopeSchema.safeParse({ level: 'task' }).success).toBe(false);
    expect(
      MemoryScopeSchema.safeParse({ level: 'project', projectId: 'memlume', taskId: 'task-3' }).success,
    ).toBe(false);
  });

  test('requires a policy intent and valid non-empty action target', () => {
    expect(PolicyDataSchema.safeParse(policy).success).toBe(true);
    expect(
      PolicyDataSchema.safeParse({
        ...policy,
        trigger: { intents: [] },
      }).success,
    ).toBe(false);
    expect(
      PolicyDataSchema.safeParse({
        ...policy,
        action: { type: 'unknown', target: 'codex_img_gen_skill' },
      }).success,
    ).toBe(false);
    expect(
      PolicyDataSchema.safeParse({
        ...policy,
        action: { type: 'route_tool', target: '' },
      }).success,
    ).toBe(false);
  });

  test('rejects malformed memory identifiers, dates, canonical text, confidence, and priority', () => {
    const memory = {
      id: ids.memory,
      kind: 'policy',
      canonicalText: 'Use the image generation skill.',
      structuredData: policy,
      scope: { level: 'global' },
      status: 'active',
      priority: 1000,
      confidence: 1,
      explicitness: 1,
      sourceEventId: ids.event,
      createdAt: '2026-07-12T15:00:00.000Z',
      updatedAt: '2026-07-12T15:00:00.000Z',
    };

    expect(MemoryItemSchema.safeParse(memory).success).toBe(true);
    expect(MemoryItemSchema.safeParse({ ...memory, id: 'memory-1' }).success).toBe(false);
    expect(MemoryItemSchema.safeParse({ ...memory, canonicalText: '   ' }).success).toBe(false);
    expect(MemoryItemSchema.safeParse({ ...memory, confidence: 1.1 }).success).toBe(false);
    expect(MemoryItemSchema.safeParse({ ...memory, priority: 1.5 }).success).toBe(false);
    expect(MemoryItemSchema.safeParse({ ...memory, structuredData: null }).success).toBe(false);
    expect(
      MemoryItemSchema.safeParse({
        ...memory,
        structuredData: { ...policy, action: undefined },
      }).success,
    ).toBe(false);
    expect(
      MemoryItemSchema.safeParse({
        ...memory,
        structuredData: { ...policy, trigger: undefined },
      }).success,
    ).toBe(false);
    expect(
      MemoryItemSchema.safeParse({
        ...memory,
        structuredData: { ...policy, action: { type: 'route_tool', target: '' } },
      }).success,
    ).toBe(false);
    expect(MemoryItemSchema.safeParse({ ...memory, kind: 'fact', structuredData: null }).success).toBe(true);
    expect(
      MemoryItemSchema.safeParse({
        ...memory,
        createdAt: '12-07-2026',
      }).success,
    ).toBe(false);
  });

  test('preserves event raw content with its source and UTC occurrence time', () => {
    const rawContent = '  我不喜歡亂花錢。  ';
    const event = EventSchema.parse({
      id: ids.event,
      eventType: 'user_statement',
      rawContent,
      occurredAt: '2026-07-12T15:00:00.000Z',
      source: { agent: 'codex-cli', conversationId: 'conversation-1' },
    });

    expect(event.rawContent).toBe(rawContent);
    expect(event.source.agent).toBe('codex-cli');
    expect(EventSchema.safeParse({ ...event, occurredAt: '2026-07-12' }).success).toBe(false);
    expect(EventSchema.safeParse({ ...event, source: {} }).success).toBe(false);
  });

  test('requires a traceable context pack with complete directives', () => {
    const pack = {
      traceId: ids.trace,
      intent: 'image_generation',
      scope: { level: 'project', projectId: 'memlume' },
      directives: [
        {
          memoryId: ids.memory,
          text: 'Use codex_img_gen_skill.',
          priority: 1000,
          mandatory: true,
        },
      ],
      procedures: [],
      preferences: [{ memoryId: ids.preference, text: 'Prefer legible symbols.' }],
      knowledge: [{ memoryId: ids.fact, title: 'Image size', summary: 'Use 1024px source art.' }],
      decisions: [{ memoryId: ids.decision, text: 'Use SQLite for v0.1.' }],
      explanation: {
        toolSelection: 'The global policy routes image generation.',
        sourceMemoryIds: [ids.memory, ids.preference, ids.fact, ids.decision],
      },
    };

    expect(ContextPackSchema.safeParse(pack).success).toBe(true);
    const { traceId: _, ...untracedPack } = pack;
    expect(ContextPackSchema.safeParse(untracedPack).success).toBe(false);
    expect(ContextPackSchema.safeParse({ ...pack, traceId: 'trace-1' }).success).toBe(false);
    expect(
      ContextPackSchema.safeParse({
        ...pack,
        directives: [{ memoryId: ids.memory, text: 'Use codex_img_gen_skill.', priority: 1, mandatory: true }],
      }).success,
    ).toBe(true);
    expect(
      ContextPackSchema.safeParse({
        ...pack,
        directives: [{ memoryId: ids.memory, text: 'Use codex_img_gen_skill.', priority: 1.5, mandatory: true }],
      }).success,
    ).toBe(false);
    expect(
      ContextPackSchema.safeParse({
        ...pack,
        directives: [{ memoryId: ids.memory, text: 'Use codex_img_gen_skill.', priority: 1 }],
      }).success,
    ).toBe(false);
  });
});
