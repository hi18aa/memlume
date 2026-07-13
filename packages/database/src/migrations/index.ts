import type { Migration } from './001_initial.js';
import { initialMigration } from './001_initial.js';
import { eventReferenceDedupMigration } from './002_event_reference_dedup.js';
import { sharedBrainsMigration } from './003_shared_brains.js';
import { memoryOutcomesMigration } from './004_memory_outcomes.js';
import { feedbackReceiptsMigration } from './005_feedback_receipts.js';
import { receiptHardeningMigration } from './006_receipt_hardening.js';

export const migrations: readonly Migration[] = [initialMigration, eventReferenceDedupMigration, sharedBrainsMigration, memoryOutcomesMigration, feedbackReceiptsMigration, receiptHardeningMigration];
