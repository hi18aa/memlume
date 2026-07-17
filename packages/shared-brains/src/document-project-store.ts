import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  ContextDocumentSectionSchema,
  NonEmptyTextSchema,
  UuidV7Schema,
  createUuidV7,
  type ContextDocumentBudget,
  type ContextDocumentSection,
} from '@memlume/contracts';
import type { SqliteDatabase } from '@memlume/database/internal';

const TEXT_UNITS_PER_CHARS = 4;
const DEFAULT_CONTEXT_BUDGET = 320;
const EMPTY_PATHS: readonly string[] = [];

export type DocumentProject = {
  readonly brainId: string;
  readonly sourceRoot: string;
  readonly authorityMode: 'markdown';
  readonly activeRevisionId?: string;
  readonly state: 'ready' | 'drift' | 'repair_required';
  readonly captureMode: 'manual_only';
  readonly retrievalPolicy: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type DocumentSummary = {
  readonly id: string;
  readonly brainId: string;
  readonly logicalPath: string;
  readonly documentType: string;
  readonly activeVersionId?: string;
  readonly status: 'active' | 'missing';
  readonly sourceSha256?: string;
  readonly revisionId?: string;
  readonly updatedAt: string;
};

export type DocumentBinding = {
  readonly agentInstallationId: string;
  readonly brainId: string;
  readonly mode: 'always_core' | 'task_conditional' | 'explicit_only';
  readonly defaultDocumentPaths: readonly string[];
  readonly maxContextBudget: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type DocumentSearchResult = ContextDocumentSection & { readonly rank: number };

export type DocumentContextResult = {
  readonly documents: readonly ContextDocumentSection[];
  readonly sourceDocumentIds: readonly string[];
  readonly budget: ContextDocumentBudget;
};

export type DocumentProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'conflict' | 'apply_failed';

export type DocumentProposal = {
  readonly id: string;
  readonly brainId: string;
  readonly documentId: string;
  readonly logicalPath: string;
  readonly baseRevisionId: string;
  readonly baseSourceSha256: string;
  readonly proposedBody: string;
  readonly reason: string;
  readonly evidence: Record<string, unknown>;
  readonly status: DocumentProposalStatus;
  readonly actorId: string;
  readonly reviewerId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewedAt?: string;
  readonly appliedAt?: string;
};

export class DocumentProjectNotReadyError extends Error {
  readonly code = 'document_project_not_ready';
  readonly status = 409;
  constructor(readonly brainId: string, readonly state: DocumentProject['state'] | 'not_ready', options?: ErrorOptions) {
    super(`Document project is not ready for reads: ${brainId} (${state}).`, options);
    this.name = 'DocumentProjectNotReadyError';
  }
}

export class DocumentProposalConflictError extends Error {
  readonly code = 'document_proposal_conflict';
  readonly status = 409;
  constructor(readonly brainId: string, message = 'Document proposal base revision is stale.') {
    super(message);
    this.name = 'DocumentProposalConflictError';
  }
}

export class DocumentProposalStateError extends Error {
  readonly code = 'document_proposal_state';
  readonly status = 409;
  constructor(readonly proposalId: string, message = 'Document proposal is not in the required state.') {
    super(message);
    this.name = 'DocumentProposalStateError';
  }
}

type ProjectRow = {
  brain_id: string;
  source_root: string;
  active_revision_id: string | null;
  retrieval_policy: string;
  created_at: string;
  updated_at: string;
  state: DocumentProject['state'];
};

type ProposalRow = {
  id: string;
  brain_id: string;
  document_id: string;
  logical_path: string;
  base_revision_id: string;
  base_source_sha256: string;
  proposed_body: string;
  reason: string;
  evidence_json: string;
  status: DocumentProposalStatus;
  actor_id: string;
  reviewer_id: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  applied_at: string | null;
};

type DocumentRow = {
  id: string;
  brain_id: string;
  logical_path: string;
  document_type: string;
  active_version_id: string | null;
  status: 'active' | 'missing';
  source_sha256: string | null;
  revision_id: string | null;
  updated_at: string;
};

type SectionRow = {
  section_id: string;
  document_id: string;
  brain_id: string;
  logical_path: string;
  version_id: string;
  revision_id: string;
  source_sha256: string;
  heading_path_json: string;
  text: string;
  priority: number;
  estimated_text_units: number;
  rank?: number;
};

type BindingRow = {
  agent_installation_id: string;
  brain_id: string;
  mode: DocumentBinding['mode'];
  default_document_paths: string;
  max_context_budget: number;
  created_at: string;
  updated_at: string;
};

type SourceFile = {
  readonly logicalPath: string;
  readonly absolutePath: string;
  readonly body: string;
  readonly sha256: string;
  readonly frontmatter: Record<string, unknown>;
  readonly headingIndex: readonly { readonly headingPath: readonly string[]; readonly line: number }[];
  readonly sections: readonly ParsedSection[];
};

type ParsedSection = {
  readonly headingPath: readonly string[];
  readonly text: string;
  readonly priority: number;
  readonly estimatedTextUnits: number;
};

export class DocumentProjectStore {
  constructor(private readonly database: SqliteDatabase) {}

  configure(input: { readonly brainId: string; readonly sourceRoot: string }): DocumentProject {
    const brainId = UuidV7Schema.parse(input.brainId);
    const sourceRoot = validateSourceRoot(input.sourceRoot);
    const brain = this.database.prepare('SELECT kind FROM brains WHERE id = ?').get(brainId) as { kind: string } | undefined;
    if (brain === undefined) throw new Error('Brain not found.');
    if (brain.kind !== 'project') throw new Error('Document projects require a project Brain.');
    const now = new Date().toISOString();
    const existing = this.database.prepare('SELECT source_root FROM document_projects WHERE brain_id = ?').get(brainId) as { source_root: string } | undefined;
    this.database.transaction(() => {
      if (existing !== undefined && resolve(existing.source_root) !== sourceRoot) {
        this.database.prepare("UPDATE documents SET status = 'missing', updated_at = ? WHERE brain_id = ?").run(now, brainId);
        this.database.prepare("UPDATE document_versions SET status = 'missing' WHERE document_id IN (SELECT id FROM documents WHERE brain_id = ?)").run(brainId);
        this.database.prepare("UPDATE document_projects SET active_revision_id = NULL, state = 'drift' WHERE brain_id = ?").run(brainId);
      }
      this.database.prepare(`
        INSERT INTO document_projects (brain_id, source_root, authority_mode, capture_mode, retrieval_policy, created_at, updated_at)
        VALUES (?, ?, 'markdown', 'manual_only', ?, ?, ?)
        ON CONFLICT(brain_id) DO UPDATE SET source_root = excluded.source_root, updated_at = excluded.updated_at
      `).run(brainId, sourceRoot, JSON.stringify({ defaultMode: 'task_conditional' }), now, now);
    })();
    return this.getProject(brainId)!;
  }

  getProject(brainId: string): DocumentProject | undefined {
    const id = UuidV7Schema.parse(brainId);
    const row = this.database.prepare(`
      SELECT brain_id, source_root, active_revision_id, retrieval_policy, created_at, updated_at, state
      FROM document_projects WHERE brain_id = ?
    `).get(id) as ProjectRow | undefined;
    return row === undefined ? undefined : toProject(row);
  }

  listDocuments(brainId: string): DocumentSummary[] {
    const id = UuidV7Schema.parse(brainId);
    const rows = this.database.prepare(`
      SELECT d.id, d.brain_id, d.logical_path, d.document_type, d.active_version_id, d.status, d.updated_at,
             v.source_sha256, v.revision_id
      FROM documents d
      LEFT JOIN document_versions v ON v.id = d.active_version_id
      WHERE d.brain_id = ?
      ORDER BY d.status, d.logical_path
    `).all(id) as DocumentRow[];
    return rows.map(toDocumentSummary);
  }

  sync(brainId: string): { readonly revisionId: string; readonly documents: number; readonly sections: number; readonly sourceManifestSha256: string } {
    const id = UuidV7Schema.parse(brainId);
    const project = this.getProject(id);
    if (project === undefined) throw new Error('Document project is not configured.');
    const files = scanSourceRoot(project.sourceRoot);
    const revisionId = createUuidV7();
    const sourceManifestSha256 = hashText(JSON.stringify(files.map(({ logicalPath, sha256 }) => ({ logicalPath, sha256 }))));
    let sectionCount = 0;

    this.database.transaction(() => {
      const now = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO document_revisions (id, brain_id, source_manifest_sha256, status, created_at)
        VALUES (?, ?, ?, 'staged', ?)
      `).run(revisionId, id, sourceManifestSha256, now);
      const seen = new Set<string>();
      for (const file of files) {
        seen.add(file.logicalPath);
        const document = this.database.prepare(
          'SELECT id, active_version_id FROM documents WHERE brain_id = ? AND logical_path = ?',
        ).get(id, file.logicalPath) as { id: string; active_version_id: string | null } | undefined;
        const documentId = document?.id ?? createUuidV7();
        if (document === undefined) {
          this.database.prepare(`
            INSERT INTO documents (id, brain_id, logical_path, document_type, status, created_at, updated_at)
            VALUES (?, ?, ?, 'markdown', 'active', ?, ?)
          `).run(documentId, id, file.logicalPath, now, now);
        }
        const existingVersion = this.database.prepare(
          'SELECT id FROM document_versions WHERE document_id = ? AND source_sha256 = ? ORDER BY created_at DESC LIMIT 1',
        ).get(documentId, file.sha256) as { id: string } | undefined;
        const versionId = existingVersion?.id ?? createUuidV7();
        if (existingVersion === undefined) {
          this.database.prepare(`
            INSERT INTO document_versions (
              id, document_id, revision_id, source_sha256, source_path, markdown_body,
              frontmatter_json, heading_index_json, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
          `).run(
            versionId,
            documentId,
            revisionId,
            file.sha256,
            file.logicalPath,
            file.body,
            JSON.stringify(file.frontmatter),
            JSON.stringify(file.headingIndex),
            now,
          );
          for (const section of file.sections) {
            const sectionId = createUuidV7();
            this.database.prepare(`
              INSERT INTO document_sections (id, document_id, version_id, heading_path_json, text, priority, estimated_text_units)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(sectionId, documentId, versionId, JSON.stringify(section.headingPath), section.text, section.priority, section.estimatedTextUnits);
            this.database.prepare(`
              INSERT INTO document_section_search (section_id, brain_id, document_id, version_id, logical_path, heading_path, text)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(sectionId, id, documentId, versionId, file.logicalPath, section.headingPath.join(' > '), section.text);
          }
        }
        sectionCount += file.sections.length;
        if (document !== undefined && document.active_version_id !== null && document.active_version_id !== versionId) {
          this.database.prepare("UPDATE document_versions SET status = 'superseded' WHERE id = ?").run(document.active_version_id);
        }
        this.database.prepare("UPDATE document_versions SET status = 'active' WHERE id = ?").run(versionId);
        this.database.prepare(`
          UPDATE documents SET active_version_id = ?, status = 'active', updated_at = ? WHERE id = ?
        `).run(versionId, now, documentId);
      }
      const oldDocuments = this.database.prepare(
        'SELECT id, logical_path, active_version_id FROM documents WHERE brain_id = ?',
      ).all(id) as { id: string; logical_path: string; active_version_id: string | null }[];
      for (const document of oldDocuments) {
        if (seen.has(document.logical_path)) continue;
        this.database.prepare("UPDATE documents SET status = 'missing', updated_at = ? WHERE id = ?").run(now, document.id);
        if (document.active_version_id !== null) {
          this.database.prepare("UPDATE document_versions SET status = 'missing' WHERE id = ?").run(document.active_version_id);
        }
      }
      this.database.prepare("UPDATE document_revisions SET status = 'superseded' WHERE brain_id = ? AND status = 'active'").run(id);
      this.database.prepare("UPDATE document_revisions SET status = 'active' WHERE id = ?").run(revisionId);
      this.database.prepare("UPDATE document_projects SET active_revision_id = ?, state = 'ready', updated_at = ? WHERE brain_id = ?").run(revisionId, now, id);
    })();

    return { revisionId, documents: files.length, sections: sectionCount, sourceManifestSha256 };
  }

  /** Reconciles the Markdown authority before any document read is exposed. */
  reconcile(brainId: string): DocumentProject {
    const id = UuidV7Schema.parse(brainId);
    const project = this.getProject(id);
    if (project === undefined) throw new Error('Document project is not configured.');
    if (project.state === 'repair_required') throw new DocumentProjectNotReadyError(id, project.state);
    if (project.activeRevisionId === undefined) {
      this.setProjectState(id, 'drift');
      throw new DocumentProjectNotReadyError(id, 'not_ready');
    }
    let files: SourceFile[];
    try {
      files = scanSourceRoot(project.sourceRoot);
    } catch (error) {
      this.setProjectState(id, 'repair_required');
      throw new DocumentProjectNotReadyError(id, 'repair_required', { cause: error });
    }
    const manifest = hashText(JSON.stringify(files.map(({ logicalPath, sha256 }) => ({ logicalPath, sha256 }))));
    const revision = this.database.prepare('SELECT source_manifest_sha256 FROM document_revisions WHERE id = ? AND brain_id = ?').get(project.activeRevisionId, id) as { source_manifest_sha256: string } | undefined;
    if (revision === undefined || revision.source_manifest_sha256 !== manifest) {
      this.setProjectState(id, 'drift');
      throw new DocumentProjectNotReadyError(id, 'drift');
    }
    if (project.state !== 'ready') this.setProjectState(id, 'ready');
    return this.getProject(id)!;
  }

  propose(input: {
    readonly agentInstallationId: string;
    readonly brainId: string;
    readonly logicalPath: string;
    readonly proposedBody: string;
    readonly baseRevisionId: string;
    readonly baseSourceSha256: string;
    readonly reason: string;
    readonly evidence?: Record<string, unknown>;
  }): DocumentProposal {
    const agentId = UuidV7Schema.parse(input.agentInstallationId);
    const brainId = UuidV7Schema.parse(input.brainId);
    const logicalPath = normalizeDocumentPath(input.logicalPath);
    const baseRevisionId = UuidV7Schema.parse(input.baseRevisionId);
    const baseSourceSha256 = normalizeSha256(input.baseSourceSha256);
    const reason = NonEmptyTextSchema.parse(input.reason);
    if (typeof input.proposedBody !== 'string') throw new Error('Document proposal body must be text.');
    this.reconcile(brainId);
    const current = this.database.prepare(`
      SELECT d.id, d.active_version_id, v.revision_id, v.source_sha256
      FROM documents d JOIN document_versions v ON v.id = d.active_version_id
      WHERE d.brain_id = ? AND d.logical_path = ? AND d.status = 'active' AND v.status = 'active'
    `).get(brainId, logicalPath) as { id: string; active_version_id: string; revision_id: string; source_sha256: string } | undefined;
    if (current === undefined || current.revision_id !== baseRevisionId || current.source_sha256 !== baseSourceSha256) {
      throw new DocumentProposalConflictError(brainId);
    }
    const id = createUuidV7();
    const now = new Date().toISOString();
    const evidence = input.evidence ?? {};
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO document_proposals (
          id, brain_id, document_id, logical_path, base_revision_id, base_source_sha256,
          proposed_body, reason, evidence_json, status, actor_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(id, brainId, current.id, logicalPath, baseRevisionId, baseSourceSha256, input.proposedBody, reason, JSON.stringify(evidence), agentId, now, now);
      this.appendAudit({ brainId, proposalId: id, eventType: 'proposal_created', actorId: agentId, detail: { logicalPath, baseRevisionId } });
    })();
    return this.getProposal(id)!;
  }

  listProposals(brainId: string, status?: DocumentProposalStatus): DocumentProposal[] {
    const id = UuidV7Schema.parse(brainId);
    const rows = status === undefined
      ? this.database.prepare('SELECT * FROM document_proposals WHERE brain_id = ? ORDER BY created_at DESC, id DESC').all(id)
      : this.database.prepare('SELECT * FROM document_proposals WHERE brain_id = ? AND status = ? ORDER BY created_at DESC, id DESC').all(id, status);
    return (rows as ProposalRow[]).map(toProposal);
  }

  reviewProposal(input: { readonly proposalId: string; readonly reviewerId: string; readonly decision: 'approve' | 'reject' }): DocumentProposal {
    const proposalId = UuidV7Schema.parse(input.proposalId);
    const reviewerId = UuidV7Schema.parse(input.reviewerId);
    const row = this.getProposalRow(proposalId);
    if (row === undefined) throw new Error('Document proposal not found.');
    if (row.status !== 'pending') throw new DocumentProposalStateError(proposalId);
    const status: DocumentProposalStatus = input.decision === 'approve' ? 'approved' : 'rejected';
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.prepare('UPDATE document_proposals SET status = ?, reviewer_id = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND status = \'pending\'').run(status, reviewerId, now, now, proposalId);
      this.appendAudit({ brainId: row.brain_id, proposalId, eventType: input.decision === 'approve' ? 'proposal_approved' : 'proposal_rejected', actorId: reviewerId, detail: {} });
    })();
    return this.getProposal(proposalId)!;
  }

  applyProposal(input: { readonly proposalId: string; readonly actorId: string }): DocumentProposal {
    const proposalId = UuidV7Schema.parse(input.proposalId);
    const actorId = UuidV7Schema.parse(input.actorId);
    const row = this.getProposalRow(proposalId);
    if (row === undefined) throw new Error('Document proposal not found.');
    if (row.status !== 'approved') throw new DocumentProposalStateError(proposalId, 'Only an approved document proposal can be applied.');
    const project = this.reconcile(row.brain_id);
    const current = this.database.prepare(`
      SELECT d.active_version_id, d.status, v.revision_id, v.source_sha256
      FROM documents d JOIN document_versions v ON v.id = d.active_version_id
      WHERE d.id = ? AND d.brain_id = ? AND v.status = 'active'
    `).get(row.document_id, row.brain_id) as { active_version_id: string; status: string; revision_id: string; source_sha256: string } | undefined;
    if (current === undefined || current.status !== 'active' || current.revision_id !== row.base_revision_id || current.source_sha256 !== row.base_source_sha256) {
      this.markProposalConflict(row, actorId);
      throw new DocumentProposalConflictError(row.brain_id);
    }
    const absolutePath = safeSourcePath(project.sourceRoot, row.logical_path);
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      this.setProjectState(row.brain_id, 'repair_required');
      throw new DocumentProjectNotReadyError(row.brain_id, 'repair_required');
    }
    const sourceBody = readFileUtf8(absolutePath);
    if (hashText(sourceBody) !== row.base_source_sha256) {
      this.markProposalConflict(row, actorId);
      throw new DocumentProposalConflictError(row.brain_id);
    }
    const temporaryPath = `${absolutePath}.${createUuidV7()}.memlume.tmp`;
    try {
      writeFileSync(temporaryPath, row.proposed_body, { encoding: 'utf8', flag: 'wx' });
      renameSync(temporaryPath, absolutePath);
    } catch (error) {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      throw error;
    }
    try {
      this.sync(row.brain_id);
    } catch (error) {
      this.setProjectState(row.brain_id, 'repair_required');
      this.database.transaction(() => {
        this.database.prepare("UPDATE document_proposals SET status = 'apply_failed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), proposalId);
        this.appendAudit({ brainId: row.brain_id, proposalId, eventType: 'proposal_apply_failed', actorId, detail: { error: error instanceof Error ? error.message : String(error) } });
      })();
      throw error;
    }
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.prepare("UPDATE document_proposals SET status = 'applied', applied_at = ?, updated_at = ? WHERE id = ? AND status = 'approved'").run(now, now, proposalId);
      this.appendAudit({ brainId: row.brain_id, proposalId, eventType: 'proposal_applied', actorId, detail: {} });
    })();
    return this.getProposal(proposalId)!;
  }

  private setProjectState(brainId: string, state: DocumentProject['state']): void {
    this.database.prepare('UPDATE document_projects SET state = ?, updated_at = ? WHERE brain_id = ?').run(state, new Date().toISOString(), brainId);
  }

  private getProposalRow(proposalId: string): ProposalRow | undefined {
    return this.database.prepare('SELECT * FROM document_proposals WHERE id = ?').get(proposalId) as ProposalRow | undefined;
  }

  getProposal(proposalId: string): DocumentProposal | undefined {
    const row = this.getProposalRow(proposalId);
    return row === undefined ? undefined : toProposal(row);
  }

  private markProposalConflict(row: ProposalRow, actorId: string): void {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.prepare("UPDATE document_proposals SET status = 'conflict', updated_at = ? WHERE id = ? AND status = 'approved'").run(now, row.id);
      this.appendAudit({ brainId: row.brain_id, proposalId: row.id, eventType: 'proposal_conflict', actorId, detail: {} });
    })();
  }

  private appendAudit(input: { readonly brainId: string; readonly proposalId?: string; readonly eventType: string; readonly actorId: string; readonly detail: Record<string, unknown> }): void {
    this.database.prepare(`
      INSERT INTO document_audit_events (id, brain_id, proposal_id, event_type, actor_id, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(createUuidV7(), input.brainId, input.proposalId ?? null, input.eventType, input.actorId, JSON.stringify(input.detail), new Date().toISOString());
  }

  search(input: { readonly brainIds: readonly string[]; readonly query: string; readonly documentPaths?: readonly string[]; readonly limit?: number }): DocumentSearchResult[] {
    const brainIds = [...new Set(input.brainIds.map((brainId) => UuidV7Schema.parse(brainId)))];
    const ftsQuery = toFtsQuery(input.query);
    if (ftsQuery === undefined || brainIds.length === 0) return [];
    for (const brainId of brainIds) this.reconcile(brainId);
    const placeholders = brainIds.map(() => '?').join(', ');
    const pathFilter = pathPredicate(input.documentPaths, 'd.logical_path');
    const rows = this.database.prepare(`
      SELECT s.section_id, s.document_id, s.brain_id, s.logical_path, s.version_id,
             ds.heading_path_json, s.text, ds.priority, ds.estimated_text_units,
             v.revision_id, v.source_sha256, bm25(document_section_search) AS rank
      FROM document_section_search s
      JOIN documents d ON d.id = s.document_id AND d.status = 'active'
      JOIN document_versions v ON v.id = s.version_id AND v.status = 'active'
      JOIN document_sections ds ON ds.id = s.section_id
      WHERE s.brain_id IN (${placeholders}) AND document_section_search MATCH ?${pathFilter.sql}
      ORDER BY rank, ds.priority DESC, s.logical_path, s.section_id
      LIMIT ?
    `).all(...brainIds, ftsQuery, ...pathFilter.values, clampLimit(input.limit)) as SectionRow[];
    return rows.map((row) => ({ ...toSection(row), rank: row.rank ?? 0 }));
  }

  listBindings(agentInstallationId: string): DocumentBinding[] {
    const id = UuidV7Schema.parse(agentInstallationId);
    const rows = this.database.prepare(`
      SELECT agent_installation_id, brain_id, mode, default_document_paths, max_context_budget, created_at, updated_at
      FROM profile_document_bindings WHERE agent_installation_id = ? ORDER BY brain_id
    `).all(id) as BindingRow[];
    return rows.map(toBinding);
  }

  upsertBinding(input: {
    readonly agentInstallationId: string;
    readonly brainId: string;
    readonly mode: DocumentBinding['mode'];
    readonly defaultDocumentPaths?: readonly string[];
    readonly maxContextBudget?: number;
  }): DocumentBinding {
    const agentInstallationId = UuidV7Schema.parse(input.agentInstallationId);
    const brainId = UuidV7Schema.parse(input.brainId);
    if (this.database.prepare('SELECT 1 FROM agent_installations WHERE id = ?').get(agentInstallationId) === undefined) throw new Error('Agent installation not found.');
    if (this.getProject(brainId) === undefined) throw new Error('Document project is not configured.');
    const paths = (input.defaultDocumentPaths ?? EMPTY_PATHS).map(normalizeDocumentPath);
    const maxContextBudget = input.maxContextBudget ?? DEFAULT_CONTEXT_BUDGET;
    if (!Number.isSafeInteger(maxContextBudget) || maxContextBudget < 0) throw new Error('Document context budget must be a non-negative integer.');
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO profile_document_bindings (
        agent_installation_id, brain_id, mode, default_document_paths, max_context_budget, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_installation_id, brain_id) DO UPDATE SET
        mode = excluded.mode,
        default_document_paths = excluded.default_document_paths,
        max_context_budget = excluded.max_context_budget,
        updated_at = excluded.updated_at
    `).run(agentInstallationId, brainId, input.mode, JSON.stringify(paths), maxContextBudget, now, now);
    return this.listBindings(agentInstallationId).find((binding) => binding.brainId === brainId)!;
  }

  resolveForInstallation(input: {
    readonly agentInstallationId: string;
    readonly query: string;
    readonly contextBudget: number;
    readonly explicitDocumentPaths?: readonly string[];
    readonly allowedBrainIds?: readonly string[];
  }): DocumentContextResult {
    const installationId = UuidV7Schema.parse(input.agentInstallationId);
    const allowed = input.allowedBrainIds === undefined
      ? undefined
      : new Set(input.allowedBrainIds.map((brainId) => UuidV7Schema.parse(brainId)));
    const candidates: Array<{ readonly section: ContextDocumentSection; readonly reason: string }> = [];
    for (const binding of this.listBindings(installationId)) {
      if (allowed !== undefined && !allowed.has(binding.brainId)) continue;
      const paths = input.explicitDocumentPaths ?? binding.defaultDocumentPaths;
      let sections: ContextDocumentSection[] = [];
      if (binding.mode === 'always_core') {
        sections = this.listActiveSections([binding.brainId], paths);
      } else if (binding.mode === 'task_conditional' && toFtsQuery(input.query) !== undefined) {
        sections = this.search({ brainIds: [binding.brainId], query: input.query, documentPaths: paths, limit: 256 });
      } else if (binding.mode === 'explicit_only' && (input.explicitDocumentPaths?.length ?? 0) > 0) {
        sections = this.listActiveSections([binding.brainId], input.explicitDocumentPaths ?? []);
      }
      const reason = binding.mode;
      for (const section of sections) candidates.push({ section, reason });
    }
    const deduped = new Map(candidates.map(({ section, reason }) => [section.sectionId, { section, reason }]));
    const limitUnits = Math.min(input.contextBudget, ...this.listBindings(installationId).map(({ maxContextBudget }) => maxContextBudget), DEFAULT_CONTEXT_BUDGET);
    const documents: ContextDocumentSection[] = [];
    const included: ContextDocumentBudget['included'] = [];
    const omitted: ContextDocumentBudget['omitted'] = [];
    let usedUnits = 0;
    for (const { section, reason } of deduped.values()) {
      if (usedUnits + section.estimatedTextUnits <= limitUnits) {
        documents.push(section);
        included.push({ sectionId: section.sectionId, reason, estimatedTextUnits: section.estimatedTextUnits });
        usedUnits += section.estimatedTextUnits;
      } else {
        omitted.push({ sectionId: section.sectionId, reason: 'budget' });
      }
    }
    return {
      documents,
      sourceDocumentIds: [...new Set(documents.map(({ documentId }) => documentId))],
      budget: { limitUnits, usedUnits, included, omitted, truncated: omitted.length > 0 },
    };
  }

  private listActiveSections(brainIds: readonly string[], documentPaths: readonly string[]): ContextDocumentSection[] {
    if (brainIds.length === 0) return [];
    for (const brainId of brainIds) this.reconcile(brainId);
    const placeholders = brainIds.map(() => '?').join(', ');
    const pathFilter = pathPredicate(documentPaths, 'd.logical_path');
    const rows = this.database.prepare(`
      SELECT ds.id AS section_id, ds.document_id, d.brain_id, d.logical_path, ds.version_id,
             v.revision_id, v.source_sha256, ds.heading_path_json, ds.text, ds.priority, ds.estimated_text_units
      FROM document_sections ds
      JOIN documents d ON d.id = ds.document_id AND d.status = 'active'
      JOIN document_versions v ON v.id = ds.version_id AND v.status = 'active'
      WHERE d.brain_id IN (${placeholders})${pathFilter.sql}
      ORDER BY ds.priority DESC, d.logical_path, ds.id
    `).all(...brainIds, ...pathFilter.values) as SectionRow[];
    return rows.map(toSection);
  }
}

function toProject(row: ProjectRow): DocumentProject {
  let retrievalPolicy: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.retrieval_policy);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) retrievalPolicy = parsed as Record<string, unknown>;
  } catch {
    // A malformed policy is non-authoritative metadata; keep reads available.
  }
  return {
    brainId: UuidV7Schema.parse(row.brain_id),
    sourceRoot: row.source_root,
    authorityMode: 'markdown',
    ...(row.active_revision_id === null ? {} : { activeRevisionId: UuidV7Schema.parse(row.active_revision_id) }),
    state: row.state,
    captureMode: 'manual_only',
    retrievalPolicy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProposal(row: ProposalRow): DocumentProposal {
  let evidence: unknown = {};
  try { evidence = JSON.parse(row.evidence_json); } catch { evidence = {}; }
  return {
    id: UuidV7Schema.parse(row.id),
    brainId: UuidV7Schema.parse(row.brain_id),
    documentId: UuidV7Schema.parse(row.document_id),
    logicalPath: normalizeDocumentPath(row.logical_path),
    baseRevisionId: UuidV7Schema.parse(row.base_revision_id),
    baseSourceSha256: normalizeSha256(row.base_source_sha256),
    proposedBody: row.proposed_body,
    reason: NonEmptyTextSchema.parse(row.reason),
    evidence: evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence as Record<string, unknown> : {},
    status: row.status,
    actorId: NonEmptyTextSchema.parse(row.actor_id),
    ...(row.reviewer_id === null ? {} : { reviewerId: NonEmptyTextSchema.parse(row.reviewer_id) }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.reviewed_at === null ? {} : { reviewedAt: row.reviewed_at }),
    ...(row.applied_at === null ? {} : { appliedAt: row.applied_at }),
  };
}

function toDocumentSummary(row: DocumentRow): DocumentSummary {
  return {
    id: UuidV7Schema.parse(row.id),
    brainId: UuidV7Schema.parse(row.brain_id),
    logicalPath: NonEmptyTextSchema.parse(row.logical_path),
    documentType: NonEmptyTextSchema.parse(row.document_type),
    ...(row.active_version_id === null ? {} : { activeVersionId: UuidV7Schema.parse(row.active_version_id) }),
    status: row.status,
    ...(row.source_sha256 === null ? {} : { sourceSha256: row.source_sha256 }),
    ...(row.revision_id === null ? {} : { revisionId: UuidV7Schema.parse(row.revision_id) }),
    updatedAt: row.updated_at,
  };
}

function toBinding(row: BindingRow): DocumentBinding {
  let paths: unknown = [];
  try { paths = JSON.parse(row.default_document_paths); } catch { paths = []; }
  return {
    agentInstallationId: UuidV7Schema.parse(row.agent_installation_id),
    brainId: UuidV7Schema.parse(row.brain_id),
    mode: row.mode,
    defaultDocumentPaths: Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string').map(normalizeDocumentPath) : [],
    maxContextBudget: row.max_context_budget,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSection(row: SectionRow): ContextDocumentSection {
  let headingPath: unknown = [];
  try { headingPath = JSON.parse(row.heading_path_json); } catch { headingPath = []; }
  return ContextDocumentSectionSchema.parse({
    sectionId: row.section_id,
    documentId: row.document_id,
    brainId: row.brain_id,
    logicalPath: row.logical_path,
    headingPath,
    text: row.text,
    revisionId: row.revision_id,
    sourceSha256: row.source_sha256,
    priority: row.priority,
    estimatedTextUnits: row.estimated_text_units,
  });
}

function scanSourceRoot(sourceRoot: string): SourceFile[] {
  const paths = collectMarkdownFiles(sourceRoot);
  return paths.map((absolutePath) => {
    let body: string;
    try {
      body = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(absolutePath));
    } catch (error) {
      throw new Error(`Invalid UTF-8 Markdown source: ${absolutePath}`, { cause: error });
    }
    const parsed = parseMarkdown(body);
    return {
      logicalPath: relative(sourceRoot, absolutePath).split(sep).join('/'),
      absolutePath,
      body,
      sha256: createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex'),
      frontmatter: parsed.frontmatter,
      headingIndex: parsed.headingIndex,
      sections: parsed.sections,
    };
  }).sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
}

function collectMarkdownFiles(root: string): string[] {
  const result: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }) as Dirent[]) {
      const child = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Document source cannot contain symlinks: ${child}`);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile() && extname(entry.name).toLocaleLowerCase() === '.md') {
        result.push(child);
      }
    }
  };
  walk(root);
  return result;
}

function validateSourceRoot(value: string): string {
  const sourceRoot = NonEmptyTextSchema.parse(value);
  if (!isAbsolute(sourceRoot)) throw new Error('Document source root must be absolute.');
  const resolved = resolve(sourceRoot);
  if (!existsSync(resolved)) throw new Error('Document source root does not exist.');
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error('Document source root cannot be a symlink.');
  if (!stat.isDirectory()) throw new Error('Document source root must be a directory.');
  return resolved;
}

function parseMarkdown(body: string): {
  readonly frontmatter: Record<string, unknown>;
  readonly headingIndex: readonly { readonly headingPath: readonly string[]; readonly line: number }[];
  readonly sections: readonly ParsedSection[];
} {
  const normalized = body.replace(/\r\n?/gu, '\n');
  const lines = normalized.split('\n');
  let start = 0;
  let frontmatter: Record<string, unknown> = {};
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end >= 0) {
      frontmatter = parseFrontmatter(lines.slice(1, end));
      start = end + 1;
    }
  }
  const headings: Array<{ level: number; text: string; line: number; headingPath: readonly string[] }> = [];
  const stack: string[] = [];
  for (let line = start; line < lines.length; line += 1) {
    const match = /^(#{1,6})[ \t]+(.+?)\s*#*\s*$/u.exec(lines[line] ?? '');
    if (match === null) continue;
    const level = match[1].length;
    const text = match[2].trim();
    stack.splice(Math.max(0, level - 1));
    stack.push(text);
    headings.push({ level, text, line, headingPath: [...stack] });
  }
  const priority = Number.isInteger(frontmatter.priority) ? Number(frontmatter.priority) : 0;
  const sections: ParsedSection[] = [];
  const firstHeadingLine = headings[0]?.line ?? lines.length;
  const preamble = lines.slice(start, firstHeadingLine).join('\n').trim();
  if (preamble !== '') sections.push(section(['(document)'], preamble, priority));
  headings.forEach((heading, index) => {
    const end = headings[index + 1]?.line ?? lines.length;
    const text = lines.slice(heading.line, end).join('\n').trim();
    if (text !== '') sections.push(section(heading.headingPath, text, priority));
  });
  return {
    frontmatter,
    headingIndex: headings.map(({ headingPath, line }) => ({ headingPath, line: line + 1 })),
    sections,
  };
}

function section(headingPath: readonly string[], text: string, priority: number): ParsedSection {
  return { headingPath, text, priority, estimatedTextUnits: Math.max(1, Math.ceil(text.length / TEXT_UNITS_PER_CHARS)) };
}

function parseFrontmatter(lines: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of lines) {
    const match = /^([^:#][^:]*):[ \t]*(.*)$/u.exec(line);
    if (match === null) continue;
    const key = match[1].trim();
    if (key === '' || Object.prototype.hasOwnProperty.call(result, key)) continue;
    const raw = match[2].trim();
    try {
      result[key] = raw === '' ? '' : JSON.parse(raw);
    } catch {
      result[key] = raw.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, '$1$2');
    }
  }
  return result;
}

function toFtsQuery(value: string): string | undefined {
  const tokens = value.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (tokens.length === 0) return undefined;
  return tokens.slice(0, 32).map((token) => `"${token.replaceAll('"', '""')}"*`).join(' AND ');
}

function pathPredicate(paths: readonly string[] | undefined, column: string): { readonly sql: string; readonly values: readonly string[] } {
  const normalized = (paths ?? []).map(normalizeDocumentPath);
  if (normalized.length === 0) return { sql: '', values: [] };
  const predicates = normalized.map(() => `(${column} = ? OR ${column} LIKE ? ESCAPE '!')`);
  const values = normalized.flatMap((path) => [path, `${path.replace(/[!%_]/gu, '!$&')}/%`]);
  return { sql: ` AND (${predicates.join(' OR ')})`, values };
}

function normalizeDocumentPath(value: string): string {
  const path = NonEmptyTextSchema.parse(value).replaceAll('\\', '/').replace(/^\.\//u, '');
  if (path.startsWith('/') || /^[A-Za-z]:/u.test(path) || path.split('/').some((part) => part === '..' || part === '')) {
    throw new Error('Document path must stay inside the configured source root.');
  }
  return path;
}

function normalizeSha256(value: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error('Document source hash must be a lowercase SHA-256 digest.');
  return value;
}

function readFileUtf8(path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    throw new Error(`Invalid UTF-8 Markdown source: ${path}`, { cause: error });
  }
}

function safeSourcePath(sourceRoot: string, logicalPath: string): string {
  const normalized = normalizeDocumentPath(logicalPath);
  const root = resolve(sourceRoot);
  const target = resolve(root, normalized);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(prefix)) throw new Error('Document path escapes the configured source root.');
  return target;
}

function clampLimit(value: number | undefined): number {
  if (value === undefined) return 64;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Document search limit must be a positive integer.');
  return Math.min(value, 256);
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
