import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BackupScheduler, createMarkdownBundle, verifyMarkdownBundle } from '../dist/index.js';

test('coalesces concurrent durable writes and retains seven verified backups', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memlume-scheduler-'));
  let now = new Date('2026-07-16T08:00:00Z');
  let calls = 0;
  try {
    const scheduler = new BackupScheduler({
      directory,
      clock: () => now,
      createAndVerify: async (path) => {
        calls += 1;
        const { writeFile } = await import('node:fs/promises');
        await writeFile(path, 'verified');
        return { verified: true };
      },
    });
    scheduler.notifyDurableWrite();
    scheduler.notifyDurableWrite();
    await scheduler.flush();
    assert.equal(calls, 1);
    for (let index = 0; index < 8; index += 1) {
      now = new Date(`2026-07-${String(17 + index).padStart(2, '0')}T08:00:00Z`);
      scheduler.notifyDurableWrite();
      await scheduler.flush();
    }
    const files = (await readdir(directory)).filter((name) => name.endsWith('.memlume'));
    assert.equal(files.length, 7);
    assert.equal(scheduler.status().lastError, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('write success is independent from a failed background backup and exposes degraded status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memlume-scheduler-'));
  try {
    const scheduler = new BackupScheduler({
      directory,
      createAndVerify: async () => ({ verified: false }),
    });
    scheduler.notifyDurableWrite();
    await scheduler.flush();
    assert.match(scheduler.status().lastError ?? '', /verification/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reports verified Markdown-first v3 bundles in scheduler status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memlume-scheduler-v3-'));
  try {
    await mkdir(join(root, 'brains', 'personal'), { recursive: true });
    await writeFile(join(root, 'brains', 'personal', 'brain.md'), '# Personal\n', 'utf8');
    const scheduler = new BackupScheduler({
      directory: root,
      createAndVerify: async (outputPath) => {
        const bundle = await createMarkdownBundle({ dataRoot: root });
        verifyMarkdownBundle(bundle);
        await writeFile(outputPath, bundle);
        return { verified: true };
      },
    });

    scheduler.notifyDurableWrite();
    await scheduler.flush();

    assert.equal(scheduler.status().verifiedBackups, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
