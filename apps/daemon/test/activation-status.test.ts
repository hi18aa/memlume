import { describe, expect, test } from 'vitest';

import { activationReport, ActivationState } from '../src/activation-status.js';

const installationId = '00000000-0000-7000-8000-000000000010';
const heartbeat = (callback: 'beforeTask' | 'onUserMessage' | 'onSubagentStart', lastSeenAt: string, protocolVersion = '1') => ({
  agentInstallationId: installationId,
  callback,
  protocolVersion,
  adapterVersion: '0.2.0',
  firstSeenAt: lastSeenAt,
  lastSeenAt,
});

describe('activation status', () => {
  test('requires real current-version read and write callbacks for active', () => {
    const base = { clientType: 'codex', detected: true, installed: true, enabled: true, protocolVersion: '1', adapterVersion: '0.2.0' };
    expect(activationReport({ ...base, heartbeats: [] }).state).toBe(ActivationState.pendingTrust);
    expect(activationReport({ ...base, heartbeats: [heartbeat('beforeTask', '2026-07-16T00:00:00.000Z')] }).state).toBe(ActivationState.pendingTrust);
    expect(activationReport({ ...base, heartbeats: [heartbeat('beforeTask', '2026-07-16T00:00:00.000Z'), heartbeat('onUserMessage', '2026-07-16T00:00:01.000Z')] }).state).toBe(ActivationState.active);
  });

  test('keeps subagent capability independent and reports Claude reload instead of trust', () => {
    const report = activationReport({
      clientType: 'claude-code',
      detected: true,
      installed: true,
      enabled: true,
      protocolVersion: '1',
      adapterVersion: '0.2.0',
      heartbeats: [heartbeat('beforeTask', '2026-07-16T00:00:00.000Z'), heartbeat('onUserMessage', '2026-07-16T00:00:01.000Z')],
    });
    expect(report.state).toBe(ActivationState.active);
    expect(report.callbacks.onSubagentStart.lastSeen).toBeUndefined();
    const degraded = activationReport({ ...reportInput(report), heartbeats: [heartbeat('beforeTask', '2026-07-16T00:00:00.000Z')] });
    expect(degraded.state).toBe(ActivationState.degraded);
    expect(degraded.reason).toContain('Reload');
  });

  test('flags old protocol heartbeats without using them as current activation', () => {
    const report = activationReport({
      clientType: 'openclaw',
      detected: true,
      installed: true,
      enabled: true,
      protocolVersion: '1',
      adapterVersion: '0.2.0',
      heartbeats: [heartbeat('beforeTask', '2026-07-16T00:00:00.000Z', '0'), heartbeat('onUserMessage', '2026-07-16T00:00:01.000Z', '0')],
    });
    expect(report.state).toBe(ActivationState.failed);
  });
});

function reportInput(report: ReturnType<typeof activationReport>) {
  return {
    clientType: report.clientType,
    detected: true,
    installed: true,
    enabled: true,
    protocolVersion: report.protocolVersion,
    adapterVersion: report.adapterVersion,
  };
}
