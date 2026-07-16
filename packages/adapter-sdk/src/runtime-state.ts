export type DegradedArea = 'context' | 'capture' | 'outcome' | 'backup' | 'reindex';

export interface DegradedNotification {
  readonly area: DegradedArea;
  readonly reason: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly count: number;
}

export interface RuntimeStateSnapshot {
  readonly degraded: readonly DegradedNotification[];
  readonly lastReadAt: string | null;
  readonly lastWriteAt: string | null;
  readonly lastOutcomeAt: string | null;
}

/** In-process, secret-free degraded latch used by hosts that lack a live UI channel. */
export class RuntimeState {
  private readonly degraded = new Map<DegradedArea, DegradedNotification>();
  private lastReadAt: string | null = null;
  private lastWriteAt: string | null = null;
  private lastOutcomeAt: string | null = null;

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  markFailure(area: DegradedArea, reason: string): boolean {
    const safeReason = reason.trim().slice(0, 160) || 'unavailable';
    const now = this.now();
    const existing = this.degraded.get(area);
    if (existing === undefined) {
      this.degraded.set(area, { area, reason: safeReason, firstSeenAt: now, lastSeenAt: now, count: 1 });
      return true;
    }
    this.degraded.set(area, { ...existing, reason: safeReason, lastSeenAt: now, count: existing.count + 1 });
    return false;
  }

  markSuccess(area: DegradedArea): void {
    this.degraded.delete(area);
    const now = this.now();
    if (area === 'context') this.lastReadAt = now;
    if (area === 'capture') this.lastWriteAt = now;
    if (area === 'outcome') this.lastOutcomeAt = now;
  }

  markReadFailure(reason: string): boolean { return this.markFailure('context', reason); }
  markWriteFailure(reason: string): boolean { return this.markFailure('capture', reason); }
  markOutcomeFailure(reason: string): boolean { return this.markFailure('outcome', reason); }

  acknowledge(area: DegradedArea): void { this.degraded.delete(area); }

  snapshot(): RuntimeStateSnapshot {
    return {
      degraded: [...this.degraded.values()].sort((left, right) => left.area.localeCompare(right.area)),
      lastReadAt: this.lastReadAt,
      lastWriteAt: this.lastWriteAt,
      lastOutcomeAt: this.lastOutcomeAt,
    };
  }
}
