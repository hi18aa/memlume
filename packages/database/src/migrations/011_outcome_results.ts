import type { SqliteDatabase } from '../database.js';

import type { Migration } from './001_initial.js';

/** Normalize the old success/failure/corrected vocabulary without losing correction evidence. */
export const outcomeResultsMigration: Migration = {
  id: '011_outcome_results',
  up(database: SqliteDatabase) {
    database.transaction(() => {
      database.prepare("UPDATE outcomes SET result = 'completed' WHERE result = 'success'").run();
      database.prepare("UPDATE outcomes SET result = 'error' WHERE result = 'failure'").run();
      database.prepare("UPDATE outcomes SET correction_type = COALESCE(correction_type, 'legacy_corrected'), result = 'unknown' WHERE result = 'corrected'").run();
      // Keep old imports readable, but make newly written rows canonical at the
      // service boundary. SQLite triggers cannot rewrite NEW values portably.
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_outcomes_result_created_at
          ON outcomes(result, created_at DESC);
      `);
    })();
  },
};
