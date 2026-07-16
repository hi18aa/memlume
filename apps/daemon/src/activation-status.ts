import { AdapterCallbackSchema, AdapterHeartbeatSchema, NonEmptyTextSchema, type AdapterHeartbeat } from '@memlume/contracts';

export const ActivationState = {
  notDetected: 'not_detected',
  notInstalled: 'not_installed',
  installed: 'installed',
  pendingTrust: 'pending_trust',
  active: 'active',
  degraded: 'degraded',
  failed: 'failed',
} as const;
export type ActivationState = typeof ActivationState[keyof typeof ActivationState];

export interface ActivationInput {
  readonly clientType: string;
  readonly detected: boolean;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly protocolVersion: string;
  readonly adapterVersion: string;
  readonly heartbeats: readonly AdapterHeartbeat[];
}

export interface ActivationReport {
  readonly clientType: string;
  readonly state: ActivationState;
  readonly protocolVersion: string;
  readonly adapterVersion: string;
  readonly callbacks: Readonly<Record<'beforeTask' | 'onUserMessage' | 'onSubagentStart', { readonly lastSeen?: string }>>;
  readonly reason?: string;
}

export function activationReport(input: ActivationInput): ActivationReport {
  const clientType = NonEmptyTextSchema.parse(input.clientType);
  const protocolVersion = NonEmptyTextSchema.parse(input.protocolVersion);
  const adapterVersion = NonEmptyTextSchema.parse(input.adapterVersion);
  const heartbeats = input.heartbeats.map((heartbeat) => AdapterHeartbeatSchema.parse(heartbeat));
  const callbacks = {
    beforeTask: latestHeartbeat(heartbeats, 'beforeTask', protocolVersion, adapterVersion),
    onUserMessage: latestHeartbeat(heartbeats, 'onUserMessage', protocolVersion, adapterVersion),
    onSubagentStart: latestHeartbeat(heartbeats, 'onSubagentStart', protocolVersion, adapterVersion),
  } as const;
  let state: ActivationState;
  let reason: string | undefined;
  if (!input.detected) {
    state = ActivationState.notDetected;
  } else if (!input.installed || !input.enabled) {
    state = ActivationState.notInstalled;
  } else if (hasProtocolMismatch(heartbeats, protocolVersion)) {
    state = ActivationState.failed;
    reason = 'Adapter protocol version mismatch.';
  } else if (callbacks.beforeTask.lastSeen !== undefined && callbacks.onUserMessage.lastSeen !== undefined) {
    state = ActivationState.active;
  } else if (clientType === 'codex') {
    state = ActivationState.pendingTrust;
    reason = 'Trust the Codex hooks, then send one task and one user message.';
  } else {
    state = ActivationState.degraded;
    reason = clientType === 'claude-code'
      ? 'Reload Claude Code plugins and send the first callback.'
      : 'Send the missing lifecycle callback to confirm activation.';
  }
  return {
    clientType,
    state,
    protocolVersion,
    adapterVersion,
    callbacks,
    ...(reason === undefined ? {} : { reason }),
  };
}

function latestHeartbeat(heartbeats: readonly AdapterHeartbeat[], callback: 'beforeTask' | 'onUserMessage' | 'onSubagentStart', protocolVersion: string, adapterVersion: string): { readonly lastSeen?: string } {
  const matching = heartbeats
    .filter((heartbeat) => heartbeat.callback === callback && heartbeat.protocolVersion === protocolVersion && heartbeat.adapterVersion === adapterVersion)
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  return matching[0] === undefined ? {} : { lastSeen: matching[0].lastSeenAt };
}

function hasProtocolMismatch(heartbeats: readonly AdapterHeartbeat[], protocolVersion: string): boolean {
  return heartbeats.some((heartbeat) => AdapterCallbackSchema.safeParse(heartbeat.callback).success && heartbeat.protocolVersion !== protocolVersion);
}
