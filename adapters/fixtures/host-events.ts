import { AdapterEnvelopeSchema, type AdapterEnvelope } from '../../packages/contracts/src/index.js';
import {
  type AdapterClient,
  type AdapterMessage,
  type BeforeTaskInput,
  type SubagentStartInput,
  type WriteResult,
} from '../../packages/adapter-sdk/src/index.js';

type AdapterOperations = Pick<AdapterClient, 'beforeTask' | 'onUserMessage' | 'onSubagentStart'>;

export type AdapterInitialization = {
  readonly envelope: AdapterEnvelope;
};

export type AdapterHostCallbacks = {
  readonly initialize: (event: AdapterInitialization) => void;
  readonly beforeTask: (event: Omit<BeforeTaskInput, 'envelope'>) => ReturnType<AdapterOperations['beforeTask']>;
  readonly onUserMessage: (event: AdapterMessage) => Promise<WriteResult>;
  readonly onSubagentStart: (event: Omit<SubagentStartInput, 'envelope'>) => ReturnType<AdapterOperations['onSubagentStart']>;
};

/**
 * 將各 Host 的生命週期事件收斂為 Memlume 的共用呼叫方式；記憶判斷與掛載授權仍完全由 Core 負責。
 */
export function createAdapterHostCallbacks(client: AdapterOperations): AdapterHostCallbacks {
  let envelope: AdapterEnvelope | undefined;
  const initializedEnvelope = (): AdapterEnvelope => {
    if (envelope === undefined) {
      throw new Error('Adapter callback must be initialized before receiving events.');
    }
    return envelope;
  };

  return {
    initialize: (event) => {
      const nextEnvelope = AdapterEnvelopeSchema.parse(event.envelope);
      if (envelope !== undefined && !sameAdapterIdentity(envelope, nextEnvelope)) {
        throw new Error('Adapter identity cannot change after initialization.');
      }
      envelope = nextEnvelope;
    },
    beforeTask: (event) => client.beforeTask({ ...event, envelope: initializedEnvelope() }),
    onUserMessage: (event) => client.onUserMessage(initializedEnvelope(), event),
    onSubagentStart: (event) => client.onSubagentStart({ ...event, envelope: initializedEnvelope() }),
  };
}

function sameAdapterIdentity(left: AdapterEnvelope, right: AdapterEnvelope): boolean {
  return left.clientType === right.clientType &&
    left.installationId === right.installationId &&
    left.profileId === right.profileId;
}
