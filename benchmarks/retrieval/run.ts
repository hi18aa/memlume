import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PERSONAL_BRAIN_ID } from '../../packages/contracts/dist/index.js';
import { openDatabase } from '../../packages/database/dist/internal.js';
import { ContextResolver } from '../../packages/context-resolver/dist/index.js';
import { MemoryStore } from '../../packages/retrieval/dist/index.js';

type Scope = { readonly level: 'project'; readonly projectId: string };
type Case = {
  readonly id: string;
  readonly operation: 'search' | 'context';
  readonly query?: string;
  readonly intent?: string;
  readonly task?: string | null;
  readonly scope?: Scope;
  readonly brain: 'project';
  readonly expected: string | null;
  readonly budget?: number;
};

const projectBrainId = '018f9d4e-7c30-7b91-8dc0-61749dbcc001';
const privateBrainId = '018f9d4e-7c30-7b91-8dc0-61749dbcc002';
const now = new Date().toISOString();
const today = now.slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const database = openDatabase(':memory:');
const store = new MemoryStore(database);
const resolver = new ContextResolver(store);

database.prepare(`INSERT INTO brains (id, kind, name, created_at, updated_at) VALUES (?, 'project', ?, ?, ?)`).run(projectBrainId, 'Benchmark project', now, now);
database.prepare(`INSERT INTO brains (id, kind, name, created_at, updated_at) VALUES (?, 'project', ?, ?, ?)`).run(privateBrainId, 'Private project', now, now);

const memoryIds = new Map<string, string>();
memoryIds.set('package-manager', store.save({
  brainId: projectBrainId,
  kind: 'fact',
  canonicalText: 'This project uses pnpm.',
  structuredData: { subject: 'project', predicate: 'package_manager', object: 'pnpm', confidence: 1 },
  scope: { level: 'project', projectId: 'memlume' },
}).id);
memoryIds.set('frontend-framework', store.save({
  brainId: projectBrainId,
  kind: 'fact',
  canonicalText: '前端使用 Vue 開發。',
  structuredData: { subject: 'frontend', predicate: 'framework', object: 'Vue', confidence: 1 },
  scope: { level: 'project', projectId: 'memlume' },
}).id);
memoryIds.set('expired-temporal', store.save({
  brainId: projectBrainId,
  kind: 'fact',
  canonicalText: 'Temporary release rule expired.',
  structuredData: { subject: 'release', predicate: 'temporary_rule', object: 'expired', confidence: 1, validUntil: yesterday },
  scope: { level: 'project', projectId: 'memlume' },
  validUntil: yesterday,
}).id);
memoryIds.set('current-temporal', store.save({
  brainId: projectBrainId,
  kind: 'fact',
  canonicalText: 'Temporary release rule is current.',
  structuredData: { subject: 'release', predicate: 'temporary_rule', object: 'current', confidence: 1, validFrom: today },
  scope: { level: 'project', projectId: 'memlume' },
  validFrom: today,
}).id);
memoryIds.set('global-image-policy', store.save({
  brainId: DEFAULT_PERSONAL_BRAIN_ID,
  kind: 'policy',
  canonicalText: 'Use the general image route.',
  structuredData: { trigger: { intents: ['image_generation'] }, action: { type: 'route_tool', target: 'general-image-route' }, constraints: {} },
  scope: { level: 'global' },
  priority: 100,
}).id);
memoryIds.set('project-image-policy', store.save({
  brainId: projectBrainId,
  kind: 'policy',
  canonicalText: 'Use the project image route.',
  structuredData: { trigger: { intents: ['image_generation'] }, action: { type: 'route_tool', target: 'project-image-route' }, constraints: {} },
  scope: { level: 'project', projectId: 'memlume' },
  priority: 1,
}).id);
store.save({
  brainId: privateBrainId,
  kind: 'fact',
  canonicalText: 'Private migration token is never shared.',
  structuredData: { subject: 'migration', predicate: 'visibility', object: 'private', confidence: 1 },
  scope: { level: 'global' },
});

const casesPath = fileURLToPath(new URL('./cases.jsonl', import.meta.url));
const cases = readFileSync(casesPath, 'utf8').trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Case);
const latency: number[] = [];
let precisionSum = 0;
let misses = 0;
let expectedCount = 0;
let contextTokenTotal = 0;
let contextTokenMax = 0;

for (const currentCase of cases) {
  const started = performance.now();
  const allowedBrainIds = currentCase.brain === 'project' ? [projectBrainId] : [];
  let retrieved: string[] = [];
  if (currentCase.operation === 'search') {
    retrieved = store.search(currentCase.query!, { brainIds: allowedBrainIds, status: 'active' }).map(({ id }) => id).slice(0, 3);
  } else {
    const context = resolver.resolve({
      intent: currentCase.intent!,
      scope: currentCase.scope!,
      task: currentCase.task ?? null,
      contextBudget: currentCase.budget ?? 120,
      brainIds: allowedBrainIds,
    });
    retrieved = context.explanation.sourceMemoryIds;
    contextTokenTotal += context.explanation.budget.usedUnits;
    contextTokenMax = Math.max(contextTokenMax, context.explanation.budget.usedUnits);
  }
  latency.push(performance.now() - started);
  const expectedId = currentCase.expected === null ? undefined : memoryIds.get(currentCase.expected);
  if (expectedId !== undefined) {
    expectedCount += 1;
    if (!retrieved.includes(expectedId)) misses += 1;
    precisionSum += retrieved.slice(0, 3).includes(expectedId) ? 1 / 3 : 0;
  } else {
    precisionSum += retrieved.length === 0 ? 1 : 0;
  }
}

latency.sort((left, right) => left - right);
const p95Index = Math.max(0, Math.ceil(latency.length * 0.95) - 1);
const report = {
  cases: cases.length,
  precisionAt3: Number((precisionSum / cases.length).toFixed(4)),
  missRate: Number((misses / expectedCount).toFixed(4)),
  contextTokenUnits: {
    average: Number((contextTokenTotal / Math.max(1, cases.filter(({ operation }) => operation === 'context').length)).toFixed(2)),
    max: contextTokenMax,
  },
  p95LatencyMs: Number(latency[p95Index].toFixed(2)),
  thresholds: { precisionAt3: 0.25, missRate: 0.25, p95LatencyMs: 1000 },
};
console.log(JSON.stringify(report, null, 2));

if (
  report.precisionAt3 < report.thresholds.precisionAt3 ||
  report.missRate > report.thresholds.missRate ||
  report.p95LatencyMs > report.thresholds.p95LatencyMs
) {
  process.exitCode = 1;
}
database.close();
