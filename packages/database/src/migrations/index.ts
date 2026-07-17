import type { Migration } from './001_initial.js';
import { initialMigration } from './001_initial.js';
import { eventReferenceDedupMigration } from './002_event_reference_dedup.js';
import { sharedBrainsMigration } from './003_shared_brains.js';
import { memoryOutcomesMigration } from './004_memory_outcomes.js';
import { feedbackReceiptsMigration } from './005_feedback_receipts.js';
import { receiptHardeningMigration } from './006_receipt_hardening.js';
import { projectModelMigration } from './007_project_model.js';
import { recordProjectionMigration } from './008_record_projection.js';
import { captureReceiptsMigration } from './009_capture_receipts.js';
import { adapterHeartbeatsMigration } from './010_adapter_heartbeats.js';
import { outcomeResultsMigration } from './011_outcome_results.js';
import { documentProjectsMigration } from './012_document_projects.js';
import { documentGovernanceMigration } from './013_document_governance.js';

export const migrations: readonly Migration[] = [initialMigration, eventReferenceDedupMigration, sharedBrainsMigration, memoryOutcomesMigration, feedbackReceiptsMigration, receiptHardeningMigration, projectModelMigration, recordProjectionMigration, captureReceiptsMigration, adapterHeartbeatsMigration, outcomeResultsMigration, documentProjectsMigration, documentGovernanceMigration];
