import { describe, expect, test } from 'vitest';

import {
  AdapterEnvelopeSchema,
  AgentInstallationSchema,
  BrainKindSchema,
  BrainMountSchema,
  BrainSchema,
  DEFAULT_PERSONAL_BRAIN_ID,
  UuidV7Schema,
} from '../src/index.js';

const ids = {
  brain: '018f9d4e-7c2a-7b91-8dc0-61749dbcc01e',
  installation: '018f9d4e-7c2b-7b91-8dc0-61749dbcc01e',
} as const;

describe('shared brain contracts', () => {
  test('accepts only the supported brain kinds', () => {
    expect(BrainKindSchema.options).toEqual(['personal', 'project']);
    expect(BrainKindSchema.safeParse('team').success).toBe(false);
  });

  test('requires a UUIDv7 brain with a non-empty name and UTC timestamps', () => {
    const brain = {
      id: ids.brain,
      kind: 'project',
      name: '  Memlume  ',
      createdAt: '2026-07-13T10:00:00.000Z',
      updatedAt: '2026-07-13T10:00:00.000Z',
    };

    expect(BrainSchema.parse(brain).name).toBe('Memlume');
    expect(BrainSchema.safeParse({ ...brain, id: 'brain-1' }).success).toBe(false);
    expect(BrainSchema.safeParse({ ...brain, name: '   ' }).success).toBe(false);
    expect(BrainSchema.safeParse({ ...brain, createdAt: '2026-07-13' }).success).toBe(false);
  });

  test('requires non-empty installation identifiers and allows an optional display name', () => {
    const installation = {
      id: ids.installation,
      clientType: 'codex',
      installationId: 'desktop-default',
      profileId: 'primary',
    };

    expect(AgentInstallationSchema.safeParse(installation).success).toBe(true);
    expect(AgentInstallationSchema.parse({ ...installation, displayName: '  Local Codex  ' }).displayName).toBe('Local Codex');
    expect(AgentInstallationSchema.safeParse({ ...installation, clientType: '' }).success).toBe(false);
    expect(AgentInstallationSchema.safeParse({ ...installation, profileId: '  ' }).success).toBe(false);
  });

  test('accepts read or read_write brain mounts only', () => {
    const mount = { brainId: ids.brain, agentInstallationId: ids.installation, access: 'read_write' };

    expect(BrainMountSchema.safeParse(mount).success).toBe(true);
    expect(BrainMountSchema.safeParse({ ...mount, access: 'admin' }).success).toBe(false);
    expect(BrainMountSchema.safeParse({ ...mount, agentInstallationId: 'installation-1' }).success).toBe(false);
  });

  test('requires adapter identity and session context while allowing an omitted workspace path', () => {
    const envelope = {
      clientType: 'codex',
      installationId: 'desktop-default',
      profileId: 'primary',
      sessionId: 'session-1',
      projectId: 'memlume',
    };

    expect(AdapterEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(AdapterEnvelopeSchema.parse({ ...envelope, workspacePath: '  C:/work/memlume  ' }).workspacePath).toBe(
      'C:/work/memlume',
    );
    expect(AdapterEnvelopeSchema.safeParse({ ...envelope, sessionId: '' }).success).toBe(false);
    expect(AdapterEnvelopeSchema.safeParse({ ...envelope, workspacePath: '  ' }).success).toBe(false);
  });

  test('exports the UUIDv7-validated default personal brain identifier', () => {
    expect(DEFAULT_PERSONAL_BRAIN_ID).toBe('00000000-0000-7000-8000-000000000001');
    expect(UuidV7Schema.safeParse(DEFAULT_PERSONAL_BRAIN_ID).success).toBe(true);
  });
});
