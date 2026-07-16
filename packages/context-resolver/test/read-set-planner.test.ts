import { createUuidV7, ReadSetSchema } from '@memlume/contracts';
import { describe, expect, test } from 'vitest';
import { planReadSet } from '../src/read-set-planner.js';

const personal = createUuidV7();
const primary = createUuidV7();
const linked = createUuidV7();
const unrelated = createUuidV7();

const brains = [
  { brainId: personal, kind: 'personal' as const, name: 'Personal', access: 'read_write' as const },
  { brainId: primary, kind: 'project' as const, name: 'Memlume', aliases: ['memlume-core'], access: 'read_write' as const },
  { brainId: linked, kind: 'project' as const, name: 'Website', aliases: ['marketing'], access: 'read' as const },
  { brainId: unrelated, kind: 'project' as const, name: 'Finance', access: 'read' as const },
];

describe('planReadSet', () => {
  test('always includes Primary, matches Linked, and requires a personal probe', () => {
    const readSet = planReadSet({
      workspaceKey: 'workspace:/repo',
      task: 'update marketing website',
      brains,
      primaryProjectId: primary,
      linkedProjectIds: [linked, unrelated],
      personalBrainId: personal,
      personalRelevant: true,
    });
    expect(ReadSetSchema.parse(readSet)).toEqual(readSet);
    expect(readSet.entries.map((entry) => entry.brainId)).toEqual([primary, linked, personal]);
    expect(readSet.exclusions.map(({ brainId }) => brainId)).toContain(unrelated);
  });

  test('unknown workspace never invents a project and child grants cannot expand', () => {
    const parent = planReadSet({
      task: 'work on Memlume',
      brains,
      primaryProjectId: primary,
      linkedProjectIds: [linked],
      personalBrainId: personal,
      personalRelevant: true,
    });
    const child = planReadSet({
      task: 'work on Website',
      brains,
      linkedProjectIds: [linked],
      personalBrainId: personal,
      personalRelevant: true,
      parentGrant: parent,
    });
    expect(child.entries.map((entry) => entry.brainId)).toEqual([personal]);
    expect(child.exclusions.some(({ brainId, reason }) => brainId === linked && reason.includes('parent'))).toBe(true);
  });

  test('primary-only subagent does not read Personal or Linked brains', () => {
    const readSet = planReadSet({
      task: 'anything',
      brains,
      primaryProjectId: primary,
      linkedProjectIds: [linked],
      personalBrainId: personal,
      personalRelevant: true,
      primaryOnly: true,
    });
    expect(readSet.entries.map((entry) => entry.brainId)).toEqual([primary]);
  });
});
