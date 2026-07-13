import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PERSONAL_BRAIN_ID } from '@memlume/contracts';
import { openDatabase, type SqliteDatabase } from '@memlume/database/internal';
import { afterEach, describe, expect, test } from 'vitest';

import { MemoryStore, OutcomeMemoryAccessError, OutcomeReceiptError, OutcomeStore } from '../src/index.js';

const databases: SqliteDatabase[] = [];
const directories: string[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('outcome store', () => {
  test('keeps usage history, enforces brain access, and exposes deterministic feedback scores', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memlume-outcomes-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'memlume.sqlite'));
    databases.push(database);
    const store = new MemoryStore(database);
    const outcomes = new OutcomeStore(database);
    const memory = store.save({
      kind: 'fact',
      canonicalText: 'The project uses pnpm.',
      structuredData: { subject: 'project', predicate: 'package_manager', object: 'pnpm', confidence: 1 },
      scope: { level: 'project', projectId: 'memlume' },
      title: 'Package manager',
    });

    const usage = outcomes.recordUsage({
      memoryId: memory.id,
      taskId: 'task-1',
      agentId: 'hermes-installation',
      retrievalRank: 1,
      wasIncluded: true,
      usedAt: '2026-07-13T00:00:00.000Z',
    }, [DEFAULT_PERSONAL_BRAIN_ID]);
    expect(usage.outcome).toBeNull();
    const adopted = outcomes.setUsageOutcome(usage.id, 'adopted', [DEFAULT_PERSONAL_BRAIN_ID]);
    expect(adopted.outcome).toBe('adopted');
    const outcome = outcomes.recordOutcome({
      taskId: 'task-1',
      agentId: 'codex-installation',
      result: 'success',
      usedMemoryIds: [memory.id],
      usedToolIds: ['terminal'],
    }, [DEFAULT_PERSONAL_BRAIN_ID]);
    expect(outcome.result).toBe('success');
    expect(outcomes.listUsage(memory.id, [DEFAULT_PERSONAL_BRAIN_ID])).toHaveLength(2);
    expect(outcomes.listOutcomes('task-1', [DEFAULT_PERSONAL_BRAIN_ID])).toHaveLength(1);
    expect(outcomes.feedbackScores([memory.id], [DEFAULT_PERSONAL_BRAIN_ID]).get(memory.id)).toBe(3);
    expect(store.get(memory.id, [DEFAULT_PERSONAL_BRAIN_ID])?.canonicalText).toBe('The project uses pnpm.');

    expect(() => outcomes.recordUsage({
      memoryId: memory.id,
      taskId: 'unauthorized',
      agentId: 'openclaw-installation',
      wasIncluded: true,
    }, ['018f9d4e-7c25-7b91-8dc0-61749dbcc015'])).toThrow(OutcomeMemoryAccessError);
  });

  test('issues a short-lived receipt and consumes it after one task outcome', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memlume-outcome-receipt-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'memlume.sqlite'));
    databases.push(database);
    const store = new MemoryStore(database);
    const outcomes = new OutcomeStore(database);
    const memory = store.save({
      kind: 'fact',
      canonicalText: 'Receipt-backed memory.',
      structuredData: { subject: 'project', predicate: 'has', object: 'receipt', confidence: 1 },
      scope: { level: 'global' },
    });
    const traceId = '018f9d4e-7c2f-7b91-8dc0-61749dbcc01e';
    const receipt = outcomes.issueReceipt({ traceId, agentId: 'hermes-installation', brainIds: [DEFAULT_PERSONAL_BRAIN_ID], sourceMemoryIds: [memory.id] });
    expect(receipt.traceId).toBe(traceId);
    const usage = outcomes.recordUsageWithReceipt({
      memoryId: memory.id,
      taskId: 'receipt-task',
      agentId: 'hermes-installation',
      wasIncluded: true,
      outcome: 'adopted',
    }, [DEFAULT_PERSONAL_BRAIN_ID], traceId, 'hermes-installation');
    expect(usage.outcome).toBe('adopted');
    const outcome = outcomes.recordOutcomeWithReceipt({
      taskId: 'receipt-task',
      agentId: 'hermes-installation',
      result: 'success',
      usedMemoryIds: [memory.id],
      usedToolIds: ['terminal'],
    }, [DEFAULT_PERSONAL_BRAIN_ID], traceId, 'hermes-installation');
    expect(outcome.result).toBe('success');
    expect(() => outcomes.recordOutcomeWithReceipt({
      taskId: 'receipt-task-again',
      agentId: 'hermes-installation',
      result: 'failure',
      usedMemoryIds: [memory.id],
      usedToolIds: [],
    }, [DEFAULT_PERSONAL_BRAIN_ID], traceId, 'hermes-installation')).toThrow(OutcomeReceiptError);
  });

  test('binds receipt feedback to included memories and rejects duplicate signals', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memlume-outcome-receipt-binding-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'memlume.sqlite'));
    databases.push(database);
    const store = new MemoryStore(database);
    const outcomes = new OutcomeStore(database);
    const included = store.save({
      kind: 'fact',
      canonicalText: 'Included receipt memory.',
      structuredData: { subject: 'project', predicate: 'has', object: 'included', confidence: 1 },
      scope: { level: 'global' },
    });
    const omitted = store.save({
      kind: 'fact',
      canonicalText: 'Omitted receipt memory.',
      structuredData: { subject: 'project', predicate: 'has', object: 'omitted', confidence: 1 },
      scope: { level: 'global' },
    });
    const traceId = '018f9d4e-7c2f-7b91-8dc0-61749dbcc01f';
    const receipt = outcomes.issueReceipt({
      traceId,
      agentId: 'hermes-installation',
      brainIds: [DEFAULT_PERSONAL_BRAIN_ID],
      sourceMemoryIds: [included.id],
    });
    expect(receipt.sourceMemoryIds).toEqual([included.id]);
    expect(() => outcomes.recordUsageWithReceipt({
      memoryId: omitted.id,
      taskId: 'binding-task',
      agentId: 'hermes-installation',
      wasIncluded: true,
      outcome: 'adopted',
    }, [DEFAULT_PERSONAL_BRAIN_ID], traceId, 'hermes-installation')).toThrow(OutcomeReceiptError);

    const usage = outcomes.recordUsageWithReceipt({
      memoryId: included.id,
      taskId: 'binding-task',
      agentId: 'hermes-installation',
      wasIncluded: true,
      outcome: 'adopted',
    }, [DEFAULT_PERSONAL_BRAIN_ID], traceId, 'hermes-installation');
    expect(() => outcomes.recordUsageWithReceipt({
      memoryId: included.id,
      taskId: 'binding-task',
      agentId: 'hermes-installation',
      wasIncluded: true,
      outcome: 'adopted',
    }, [DEFAULT_PERSONAL_BRAIN_ID], traceId, 'hermes-installation')).toThrow(OutcomeReceiptError);
    expect(() => outcomes.setUsageOutcomeWithReceipt(usage.id, 'adopted', [DEFAULT_PERSONAL_BRAIN_ID], traceId, 'hermes-installation')).toThrow(OutcomeReceiptError);

    outcomes.recordOutcomeWithReceipt({
      taskId: 'binding-task',
      agentId: 'hermes-installation',
      result: 'success',
      usedMemoryIds: [included.id],
      usedToolIds: ['terminal'],
    }, [DEFAULT_PERSONAL_BRAIN_ID], traceId, 'hermes-installation');
    const nextTraceId = '018f9d4e-7c2f-7b91-8dc0-61749dbcc031';
    outcomes.issueReceipt({
      traceId: nextTraceId,
      agentId: 'hermes-installation',
      brainIds: [DEFAULT_PERSONAL_BRAIN_ID],
      sourceMemoryIds: [included.id],
    });
    expect(() => outcomes.recordUsageWithReceipt({
      memoryId: included.id,
      taskId: 'another-binding-task',
      agentId: 'hermes-installation',
      wasIncluded: true,
      outcome: 'adopted',
    }, [DEFAULT_PERSONAL_BRAIN_ID], nextTraceId, 'hermes-installation')).toThrow(OutcomeReceiptError);
  });

  test('rate limits active receipt issuance per installation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memlume-outcome-receipt-rate-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'memlume.sqlite'));
    databases.push(database);
    const store = new MemoryStore(database);
    const outcomes = new OutcomeStore(database);
    const memory = store.save({
      kind: 'fact',
      canonicalText: 'Rate limited receipt memory.',
      structuredData: { subject: 'project', predicate: 'has', object: 'rate-limit', confidence: 1 },
      scope: { level: 'global' },
    });
    for (let index = 0; index < 10; index += 1) {
      outcomes.issueReceipt({
        traceId: `018f9d4e-7c2f-7b91-8dc0-61749dbcc0${20 + index}`,
        agentId: 'hermes-installation',
        brainIds: [DEFAULT_PERSONAL_BRAIN_ID],
        sourceMemoryIds: [memory.id],
      });
    }
    expect(() => outcomes.issueReceipt({
      traceId: '018f9d4e-7c2f-7b91-8dc0-61749dbcc030',
      agentId: 'hermes-installation',
      brainIds: [DEFAULT_PERSONAL_BRAIN_ID],
      sourceMemoryIds: [memory.id],
    })).toThrow(OutcomeReceiptError);
  });
});
