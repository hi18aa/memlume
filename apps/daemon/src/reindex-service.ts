import { DEFAULT_PERSONAL_BRAIN_ID } from '@memlume/contracts';
import { openDatabase, type SqliteDatabase } from '@memlume/database/internal';
import { RecordProjector, type ProjectionResult } from '@memlume/retrieval';
import { scanMarkdownState, type ScannedMarkdownState } from '@memlume/shared-brains';
import { join } from 'node:path';

export type ReindexOptions = {
  readonly dataRoot: string;
  readonly database?: SqliteDatabase;
  readonly databasePath?: string;
};

export type ReindexResult = ScannedMarkdownState & {
  readonly projected: readonly ProjectionResult[];
};

/**
 * Scan and validate the complete Markdown authority before touching SQLite.
 * Only rows previously marked by `record_projections` are rebuilt; host
 * tokens, installations, heartbeat and runtime state remain database-owned.
 */
export function reindex(options: ReindexOptions): ReindexResult {
  const state = scanMarkdownState(options.dataRoot);
  const database = options.database ?? openDatabase(options.databasePath ?? join(options.dataRoot, 'memlume.sqlite'));
  const ownsDatabase = options.database === undefined;
  try {
    const projected = database.transaction(() => {
      ensureRecordBrains(database, state);
      return new RecordProjector(database).rebuildInTransaction(
        state.records.map(({ record, relativePath, checksum }) => ({ record, relativePath, checksum })),
      );
    })();
    return { ...state, projected };
  } finally {
    if (ownsDatabase) database.close();
  }
}

function ensureRecordBrains(database: SqliteDatabase, state: ScannedMarkdownState): void {
  const brainIds = [...new Set(state.records.map(({ record }) => record.brainId))];
  if (brainIds.length === 0) return;
  const now = new Date().toISOString();
  const insert = database.prepare(
    'INSERT OR IGNORE INTO brains (id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const brainId of brainIds) {
    insert.run(
      brainId,
      brainId === DEFAULT_PERSONAL_BRAIN_ID ? 'personal' : 'project',
      brainId === DEFAULT_PERSONAL_BRAIN_ID ? 'Personal Brain' : `Recovered Brain ${brainId}`,
      now,
      now,
    );
  }
}
