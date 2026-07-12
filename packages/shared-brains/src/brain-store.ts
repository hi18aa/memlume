import { createHash, randomBytes } from 'node:crypto';

import {
  AgentInstallationSchema,
  BrainMountSchema,
  BrainSchema,
  NonEmptyTextSchema,
  UuidV7Schema,
  createUuidV7,
  type AgentInstallation,
  type Brain,
  type BrainKind,
  type BrainMount,
} from '@memlume/contracts';
import type { SqliteDatabase } from '@memlume/database/internal';

type BrainRow = {
  id: string;
  kind: string;
  name: string;
  created_at: string;
  updated_at: string;
};

type MountedBrainRow = BrainRow & { access: string };
type AccessRow = { access: string };
type AgentInstallationRow = {
  id: string;
  client_type: string;
  installation_id: string;
  profile_id: string;
  display_name: string | null;
};

export type RegisteredInstallation = {
  readonly installation: AgentInstallation;
  readonly token: string;
};

export type RotatedToken = { readonly token: string };

export type MountedBrain = {
  readonly brain: Brain;
  readonly access: BrainMount['access'];
};

export class BrainStore {
  constructor(private readonly database: SqliteDatabase) {}

  createBrain(input: { readonly kind: BrainKind; readonly name: string }): Brain {
    const now = new Date().toISOString();
    const brain = BrainSchema.parse({
      id: createUuidV7(),
      kind: input.kind,
      name: NonEmptyTextSchema.parse(input.name),
      createdAt: now,
      updatedAt: now,
    });

    this.database
      .prepare('INSERT INTO brains (id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(brain.id, brain.kind, brain.name, brain.createdAt, brain.updatedAt);
    return brain;
  }

  listBrains(): Brain[] {
    const rows = this.database
      .prepare('SELECT id, kind, name, created_at, updated_at FROM brains ORDER BY created_at, id')
      .all() as BrainRow[];
    return rows.map(toBrain);
  }

  registerInstallation(input: {
    readonly clientType: string;
    readonly installationId: string;
    readonly profileId: string;
    readonly displayName?: string;
  }): RegisteredInstallation {
    const { clientType, installationId, profileId, displayName } = input;
    const registration = { id: createUuidV7(), clientType, installationId, profileId };
    const candidate = AgentInstallationSchema.parse(
      displayName === undefined ? registration : { ...registration, displayName },
    );
    const token = createToken();
    const now = new Date().toISOString();
    const installation = this.database
      .transaction(() => {
        const existing = this.database
          .prepare(
            `
              SELECT id, client_type, installation_id, profile_id, display_name
              FROM agent_installations
              WHERE client_type = ? AND installation_id = ? AND profile_id = ?
            `,
          )
          .get(candidate.clientType, candidate.installationId, candidate.profileId) as AgentInstallationRow | undefined;
        const installation = existing === undefined ? candidate : toAgentInstallation(existing);

        if (existing === undefined) {
          this.database
            .prepare(
              `
                INSERT INTO agent_installations (
                  id, client_type, installation_id, profile_id, display_name, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
              `,
            )
            .run(
              installation.id,
              installation.clientType,
              installation.installationId,
              installation.profileId,
              installation.displayName ?? null,
              now,
              now,
            );
        }
        this.database
          .prepare('UPDATE adapter_tokens SET revoked_at = ? WHERE agent_installation_id = ? AND revoked_at IS NULL')
          .run(now, installation.id);
        this.database
          .prepare('INSERT INTO adapter_tokens (id, agent_installation_id, token_hash, created_at) VALUES (?, ?, ?, ?)')
          .run(createUuidV7(), installation.id, hashToken(token), now);
        return installation;
      })
      .immediate();

    return { installation, token };
  }

  mountBrain(input: BrainMount): BrainMount {
    const mount = BrainMountSchema.parse(input);
    const now = new Date().toISOString();
    this.database
      .prepare(
        `
          INSERT INTO brain_mounts (brain_id, agent_installation_id, access, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(brain_id, agent_installation_id) DO UPDATE SET
            access = excluded.access,
            updated_at = excluded.updated_at
        `,
      )
      .run(mount.brainId, mount.agentInstallationId, mount.access, now, now);
    return mount;
  }

  listMountedBrains(agentInstallationId: string): MountedBrain[] {
    const installationId = UuidV7Schema.parse(agentInstallationId);
    const rows = this.database
      .prepare(
        `
          SELECT brains.id, brains.kind, brains.name, brains.created_at, brains.updated_at, brain_mounts.access
          FROM brain_mounts
          JOIN brains ON brains.id = brain_mounts.brain_id
          WHERE brain_mounts.agent_installation_id = ?
          ORDER BY brains.created_at, brains.id
        `,
      )
      .all(installationId) as MountedBrainRow[];
    return rows.map((row) => ({
      brain: toBrain(row),
      access: BrainMountSchema.parse({ brainId: row.id, agentInstallationId: installationId, access: row.access }).access,
    }));
  }

  assertAccess(agentInstallationId: string, brainId: string, required: BrainMount['access']): void {
    const requested = BrainMountSchema.parse({ brainId, agentInstallationId, access: required });
    const row = this.database
      .prepare('SELECT access FROM brain_mounts WHERE brain_id = ? AND agent_installation_id = ?')
      .get(requested.brainId, requested.agentInstallationId) as AccessRow | undefined;
    if (row === undefined) {
      throw new Error('Brain is not mounted for this agent installation.');
    }

    const access = BrainMountSchema.parse({ ...requested, access: row.access }).access;
    if (requested.access === 'read_write' && access !== 'read_write') {
      throw new Error('Brain mount does not grant write access.');
    }
  }

  authenticateToken(token: string): AgentInstallation {
    if (token.length === 0) {
      throw new Error('Invalid adapter token.');
    }

    const row = this.database
      .prepare(
        `
          SELECT
            agent_installations.id,
            agent_installations.client_type,
            agent_installations.installation_id,
            agent_installations.profile_id,
            agent_installations.display_name
          FROM adapter_tokens
          JOIN agent_installations ON agent_installations.id = adapter_tokens.agent_installation_id
          WHERE adapter_tokens.token_hash = ?
            AND adapter_tokens.revoked_at IS NULL
            AND (adapter_tokens.expires_at IS NULL OR adapter_tokens.expires_at > ?)
          LIMIT 1
        `,
      )
      .get(hashToken(token), new Date().toISOString()) as AgentInstallationRow | undefined;
    if (row === undefined) {
      throw new Error('Invalid adapter token.');
    }
    return toAgentInstallation(row);
  }

  rotateToken(agentInstallationId: string): RotatedToken {
    const installationId = UuidV7Schema.parse(agentInstallationId);
    const token = createToken();
    const now = new Date().toISOString();
    this.database
      .transaction(() => {
        this.database
          .prepare('UPDATE adapter_tokens SET revoked_at = ? WHERE agent_installation_id = ? AND revoked_at IS NULL')
          .run(now, installationId);
        this.database
          .prepare('INSERT INTO adapter_tokens (id, agent_installation_id, token_hash, created_at) VALUES (?, ?, ?, ?)')
          .run(createUuidV7(), installationId, hashToken(token), now);
      })
      .immediate();
    return { token };
  }
}

function toBrain(row: BrainRow): Brain {
  return BrainSchema.parse({
    id: row.id,
    kind: row.kind,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toAgentInstallation(row: AgentInstallationRow): AgentInstallation {
  const installation = {
    id: row.id,
    clientType: row.client_type,
    installationId: row.installation_id,
    profileId: row.profile_id,
  };
  return AgentInstallationSchema.parse(
    row.display_name === null ? installation : { ...installation, displayName: row.display_name },
  );
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function createToken(): string {
  return randomBytes(32).toString('base64url');
}
