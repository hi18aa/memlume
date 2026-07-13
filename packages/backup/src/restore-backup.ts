import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

import { inspectSnapshotPath, readVerifiedBackup, type VerifyBackupOptions } from './verify-backup.js';

export type RestoreBackupOptions = VerifyBackupOptions & {
  readonly databasePath: string;
  readonly pauseWrites: () => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
};

export type RestoreResult = {
  readonly rollbackPath: string;
};

export class RestoreRecoveryError extends Error {
  constructor(operationError: unknown, recoveryError: unknown) {
    super('Memlume could not automatically recover the previous database; manual recovery is required.', {
      cause: new AggregateError([operationError, recoveryError], 'Restore and automatic recovery both failed.'),
    });
    this.name = 'RestoreRecoveryError';
  }
}

export class BrainImportRequiredError extends Error {
  constructor() {
    super('A single Brain backup must use the brain import command instead of restore.');
    this.name = 'BrainImportRequiredError';
  }
}

export async function restoreBackup(options: RestoreBackupOptions): Promise<RestoreResult> {
  const verified = await readVerifiedBackup(options);
  if (verified.manifest.scope !== 'full') {
    throw new BrainImportRequiredError();
  }
  if (typeof options.pauseWrites !== 'function') {
    throw new Error('Restore requires exclusive database access through pauseWrites.');
  }
  const destinationDirectory = dirname(options.databasePath);
  const suffix = randomUUID();
  const candidatePath = join(destinationDirectory, `.${basename(options.databasePath)}.${suffix}.restore`);
  const rollbackPath = join(destinationDirectory, `${basename(options.databasePath)}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  let resume: (() => void | Promise<void>) | undefined;
  let replaced = false;
  let resumed = false;
  let recoveryFailed = false;

  try {
    writeFileSync(candidatePath, verified.snapshot);
    inspectSnapshotPath(candidatePath, verified.manifest);
    const pauseResult = await options.pauseWrites();
    if (typeof pauseResult === 'function') {
      resume = pauseResult;
    }
    if (existsSync(options.databasePath)) {
      const current = new Database(options.databasePath);
      try {
        await current.backup(rollbackPath);
      } finally {
        current.close();
      }
    }
    replaceDatabase(candidatePath, options.databasePath, suffix);
    replaced = true;
    if (resume !== undefined) {
      await resume();
      resumed = true;
    }
    return { rollbackPath };
  } catch (error) {
    if (resume !== undefined && !resumed) {
      if (replaced) {
        try {
          restorePreviousDatabase(rollbackPath, options.databasePath, suffix);
        } catch (recoveryError) {
          recoveryFailed = true;
          throw new RestoreRecoveryError(error, recoveryError);
        }
      }
      await resume();
      resumed = true;
    }
    throw error;
  } finally {
    rmSync(candidatePath, { force: true });
    if (resume !== undefined && !resumed && !recoveryFailed) {
      await resume();
    }
  }
}

function restorePreviousDatabase(rollbackPath: string, databasePath: string, suffix: string): void {
  if (!existsSync(rollbackPath)) {
    throw new Error('The pre-restore database copy is unavailable.');
  }
  replaceDatabase(rollbackPath, databasePath, `${suffix}-rollback`);
}

function replaceDatabase(candidatePath: string, databasePath: string, suffix: string): void {
  const sidecars = [
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ];
  const moved = sidecars
    .filter((path) => existsSync(path))
    .map((path) => ({ source: path, temporary: `${path}.${suffix}.restore` }));
  const previousPath = `${databasePath}.${suffix}.restore`;
  let movedMain = false;
  let installedCandidate = false;

  try {
    for (const sidecar of moved) renameSync(sidecar.source, sidecar.temporary);
    if (existsSync(databasePath)) {
      renameSync(databasePath, previousPath);
      movedMain = true;
    }
    renameSync(candidatePath, databasePath);
    installedCandidate = true;
  } catch (error) {
    if (installedCandidate && existsSync(databasePath)) {
      renameSync(databasePath, candidatePath);
    }
    if (movedMain && existsSync(previousPath)) {
      renameSync(previousPath, databasePath);
    }
    for (const sidecar of moved) {
      if (existsSync(sidecar.temporary) && !existsSync(sidecar.source)) {
        renameSync(sidecar.temporary, sidecar.source);
      }
    }
    throw error;
  }
  for (const sidecar of moved) {
    try {
      rmSync(sidecar.temporary, { force: true });
    } catch {
      // ponytail: retired sidecars are outside the live SQLite paths; a later cleanup can remove them without risking a restored database.
    }
  }
  try {
    rmSync(previousPath, { force: true });
  } catch {
    // ponytail: retain a retired main file if cleanup fails; never turn successful replacement into data loss.
  }
}
