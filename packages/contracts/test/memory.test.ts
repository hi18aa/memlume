import { describe, expect, test } from 'vitest';

import {
  ContextPackSchema,
  ContextReceiptSchema,
  DEFAULT_PERSONAL_BRAIN_ID,
  EventSchema,
  MemoryItemSchema,
  MemoryKindSchema,
  MemoryScopeSchema,
  MemoryOutcomeSchema,
  MemoryUsageSchema,
  MemoryUsageOutcomeSchema,
  OutcomeResultSchema,
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
  test('validates explainable memory usage and task outcomes', () => {
    expect(ContextReceiptSchema.safeParse({
      traceId: ids.trace,
      agentId: 'hermes-installation',
      brainIds: [DEFAULT_PERSONAL_BRAIN_ID],
      issuedAt: '2026-07-13T00:00:00.000Z',
      expiresAt: '2026-07-13T00:15:00.000Z',
      consumedAt: null,
    }).success).toBe(true);
    expect(MemoryUsageOutcomeSchema.parse('adopted')).toBe('adopted');
    expect(OutcomeResultSchema.parse('corrected')).toBe('corrected');
    expect(MemoryUsageSchema.safeParse({
      id: ids.memory,
      memoryId: ids.memory,
      taskId: 'task-1',
      agentId: 'hermes-installation',
      retrievalRank: 1,
      wasIncluded: true,
      outcome: 'adopted',
      usedAt: '2026-07-13T00:00:00.000Z',
    }).success).toBe(true);
    expect(MemoryOutcomeSchema.safeParse({
      id: ids.memory,
      taskId: 'task-1',
      agentId: 'hermes-installation',
      result: 'corrected',
      correctionType: 'user_correction',
      correctionData: { note: 'Use pnpm.' },
      usedMemoryIds: [ids.memory],
      usedToolIds: ['terminal'],
      createdAt: '2026-07-13T00:00:00.000Z',
    }).success).toBe(true);
    expect(MemoryOutcomeSchema.safeParse({
      id: ids.memory,
      taskId: 'task-1',
      agentId: 'hermes-installation',
      result: 'success',
      correctionType: null,
      correctionData: null,
      usedMemoryIds: [],
      usedToolIds: [],
      createdAt: '2026-07-13T00:00:00.000Z',
    }).success).toBe(false);
  });

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
    expect(MemoryItemSchema.safeParse({ ...memory, kind: 'fact', structuredData: null }).success).toBe(false);
    expect(
      MemoryItemSchema.safeParse({
        ...memory,
        createdAt: '12-07-2026',
      }).success,
    ).toBe(false);
  });

  test('requires structured preference, fact, and decision payloads', () => {
    const memory = {
      id: ids.memory,
      canonicalText: 'A structured memory.',
      scope: { level: 'global' },
      status: 'active',
      priority: 0,
      confidence: 1,
      explicitness: 1,
      createdAt: '2026-07-12T15:00:00.000Z',
      updatedAt: '2026-07-12T15:00:00.000Z',
    };

    const preference = {
      ...memory,
      kind: 'preference',
      structuredData: {
        domain: 'design',
        subject: 'logo',
        dimension: 'style',
        value: 'legible',
        strength: 1,
        confidence: 1,
        contexts: ['image_generation'],
      },
    };
    const fact = {
      ...memory,
      kind: 'fact',
      structuredData: {
        subject: 'logo',
        predicate: 'source_size',
        object: '1024px',
        validFrom: '2026-07-12',
        validUntil: null,
        confidence: 1,
      },
    };
    const decision = {
      ...memory,
      kind: 'decision',
      structuredData: {
        title: 'Use SVG.',
        status: 'active',
        rationale: ['It remains sharp at every size.'],
      },
    };

    expect(MemoryItemSchema.safeParse(preference).success).toBe(true);
    expect(MemoryItemSchema.safeParse(fact).success).toBe(true);
    expect(MemoryItemSchema.safeParse(decision).success).toBe(true);
    expect(MemoryItemSchema.safeParse({ ...preference, structuredData: null }).success).toBe(false);
    expect(
      MemoryItemSchema.safeParse({ ...preference, structuredData: { ...preference.structuredData, value: '' } }).success,
    ).toBe(false);
    expect(MemoryItemSchema.safeParse({ ...fact, structuredData: { ...fact.structuredData, object: null } }).success).toBe(
      false,
    );
    expect(
      MemoryItemSchema.safeParse({ ...fact, structuredData: { ...fact.structuredData, validFrom: '2026-99-99' } }).success,
    ).toBe(false);
    expect(MemoryItemSchema.safeParse({ ...decision, structuredData: null }).success).toBe(false);
    expect(
      MemoryItemSchema.safeParse({ ...decision, structuredData: { rationale: [] } }).success,
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
    expect(event.brainId).toBe(DEFAULT_PERSONAL_BRAIN_ID);
    expect(event.source.agent).toBe('codex-cli');
    expect(EventSchema.safeParse({ ...event, occurredAt: '2026-07-12' }).success).toBe(false);
    expect(EventSchema.safeParse({ ...event, source: {} }).success).toBe(false);
  });

  test('assigns the personal brain to legacy-compatible event and memory input', () => {
    const memory = MemoryItemSchema.parse({
      id: ids.memory,
      kind: 'fact',
      canonicalText: 'Memlume stores shared memories locally.',
      structuredData: {
        subject: 'Memlume',
        predicate: 'storage',
        object: 'local',
        confidence: 1,
      },
      scope: { level: 'global' },
      status: 'active',
      priority: 0,
      confidence: 1,
      explicitness: 1,
      createdAt: '2026-07-12T15:00:00.000Z',
      updatedAt: '2026-07-12T15:00:00.000Z',
    });

    expect(memory.brainId).toBe(DEFAULT_PERSONAL_BRAIN_ID);
  });

  test('requires a traceable context pack with complete directives', () => {
    const pack = {
      traceId: ids.trace,
      intent: 'image_generation',
      scope: { level: 'project', projectId: 'memlume' },
      directives: [
        {
          memoryId: ids.memory,
          brainId: DEFAULT_PERSONAL_BRAIN_ID,
          text: 'Use codex_img_gen_skill.',
          actionTarget: 'codex_img_gen_skill',
          priority: 1000,
          mandatory: true,
        },
      ],
      procedures: [
        {
          memoryId: ids.memory,
          brainId: DEFAULT_PERSONAL_BRAIN_ID,
          name: 'Image workflow',
          steps: ['Prepare the image.'],
        },
      ],
      preferences: [{ memoryId: ids.preference, brainId: DEFAULT_PERSONAL_BRAIN_ID, text: 'Prefer legible symbols.' }],
      knowledge: [{ memoryId: ids.fact, brainId: DEFAULT_PERSONAL_BRAIN_ID, title: 'Image size', summary: 'Use 1024px source art.' }],
      decisions: [{ memoryId: ids.decision, brainId: DEFAULT_PERSONAL_BRAIN_ID, text: 'Use SQLite for v0.1.' }],
      explanation: {
        toolSelection: 'The global policy routes image generation.',
        sourceMemoryIds: [ids.memory, ids.preference, ids.fact, ids.decision],
        budget: {
          limitUnits: 100,
          usedUnits: 20,
          included: [{ memoryId: ids.memory, reason: 'mandatory', estimatedTextUnits: 5 }],
          omitted: [],
          truncated: false,
        },
        exclusions: [],
      },
    };

    expect(ContextPackSchema.safeParse(pack).success).toBe(true);
    expect(ContextPackSchema.parse(pack).directives[0]?.actionTarget).toBe('codex_img_gen_skill');
    const { traceId: _, ...untracedPack } = pack;
    expect(ContextPackSchema.safeParse(untracedPack).success).toBe(false);
    expect(ContextPackSchema.safeParse({ ...pack, traceId: 'trace-1' }).success).toBe(false);
    const legacyPack = ContextPackSchema.parse({
      ...pack,
      directives: pack.directives.map(({ brainId: _, ...directive }) => directive),
      procedures: pack.procedures.map(({ brainId: _, ...procedure }) => procedure),
      preferences: pack.preferences.map(({ brainId: _, ...preference }) => preference),
      knowledge: pack.knowledge.map(({ brainId: _, ...knowledge }) => knowledge),
      decisions: pack.decisions.map(({ brainId: _, ...decision }) => decision),
    });
    expect(legacyPack.directives[0]?.brainId).toBe(DEFAULT_PERSONAL_BRAIN_ID);
    expect(legacyPack.procedures[0]?.brainId).toBe(DEFAULT_PERSONAL_BRAIN_ID);
    expect(legacyPack.preferences[0]?.brainId).toBe(DEFAULT_PERSONAL_BRAIN_ID);
    expect(legacyPack.knowledge[0]?.brainId).toBe(DEFAULT_PERSONAL_BRAIN_ID);
    expect(legacyPack.decisions[0]?.brainId).toBe(DEFAULT_PERSONAL_BRAIN_ID);
    expect(
      ContextPackSchema.safeParse({
        ...pack,
        directives: [{ memoryId: ids.memory, brainId: DEFAULT_PERSONAL_BRAIN_ID, text: 'Use codex_img_gen_skill.', priority: 1, mandatory: true }],
      }).success,
    ).toBe(true);
    expect(
      ContextPackSchema.safeParse({
        ...pack,
        directives: [{ memoryId: ids.memory, brainId: DEFAULT_PERSONAL_BRAIN_ID, text: 'Use codex_img_gen_skill.', priority: 1.5, mandatory: true }],
      }).success,
    ).toBe(false);
    expect(
      ContextPackSchema.safeParse({
        ...pack,
        directives: [{ memoryId: ids.memory, brainId: DEFAULT_PERSONAL_BRAIN_ID, text: 'Use codex_img_gen_skill.', priority: 1 }],
      }).success,
    ).toBe(false);
  });
});
