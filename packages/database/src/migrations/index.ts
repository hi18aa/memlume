import type { Migration } from './001_initial.js';
import { initialMigration } from './001_initial.js';
import { eventReferenceDedupMigration } from './002_event_reference_dedup.js';
import { sharedBrainsMigration } from './003_shared_brains.js';

export const migrations: readonly Migration[] = [initialMigration, eventReferenceDedupMigration, sharedBrainsMigration];
