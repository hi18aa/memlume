import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export type BackupSchedulerOptions = {
  readonly directory: string;
  readonly createAndVerify: (outputPath: string) => Promise<{ readonly verified: boolean }>;
  readonly clock?: () => Date;
  readonly retention?: number;
  readonly prefix?: string;
};

export type BackupSchedulerStatus = {
  readonly lastScheduledDate?: string;
  readonly lastSuccessDate?: string;
  readonly lastError?: string;
  readonly verifiedBackups: number;
};

/**
 * Small, host-independent daily scheduler. It only reacts to a durable write;
 * callers decide how the process itself is kept alive.
 */
export class BackupScheduler {
  private readonly clock: () => Date;
  private readonly retention: number;
  private readonly prefix: string;
  private pending: Promise<void> | undefined;
  private scheduledDate: string | undefined;
  private lastSuccessDate: string | undefined;
  private lastError: string | undefined;

  constructor(private readonly options: BackupSchedulerOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.retention = Number.isInteger(options.retention) && (options.retention ?? 0) > 0 ? options.retention! : 7;
    this.prefix = options.prefix ?? 'memlume-backup-';
  }

  /** Queue at most one background backup for the current local calendar day. */
  notifyDurableWrite(): void {
    const date = localDate(this.clock());
    if (this.scheduledDate === date || this.pending !== undefined) return;
    this.scheduledDate = date;
    this.pending = Promise.resolve().then(async () => {
      const outputPath = join(this.options.directory, `${this.prefix}${date}-${Date.now()}.memlume`);
      try {
        const result = await this.options.createAndVerify(outputPath);
        if (!result.verified) throw new Error('backup_verification_failed');
        this.lastSuccessDate = date;
        this.lastError = undefined;
        await this.pruneVerified();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      } finally {
        this.pending = undefined;
      }
    });
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  status(): BackupSchedulerStatus {
    return {
      ...(this.scheduledDate === undefined ? {} : { lastScheduledDate: this.scheduledDate }),
      ...(this.lastSuccessDate === undefined ? {} : { lastSuccessDate: this.lastSuccessDate }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      verifiedBackups: 0,
    };
  }

  private async pruneVerified(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.options.directory);
    } catch {
      return;
    }
    const candidates = names
      .filter((name) => name.startsWith(this.prefix) && name.endsWith('.memlume') && /^memlume-backup-\d{4}-\d{2}-\d{2}-\d+\.memlume$/u.test(name))
      .sort()
      .reverse();
    // Only files created by this scheduler prefix are eligible for retention.
    for (const name of candidates.slice(this.retention)) {
      await rm(join(this.options.directory, name), { force: true }).catch(() => undefined);
    }
  }
}

function localDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

