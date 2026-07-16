import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createMarkdownBundle, verifyMarkdownBundle } from '../dist/index.js';

test('creates and verifies a Markdown-first v3 bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memlume-v3-bundle-'));
  try {
    await mkdir(join(root, 'brains', 'brain-1', 'records', '2026', '07'), { recursive: true });
    await mkdir(join(root, 'inbox', 'pending'), { recursive: true });
    await writeFile(join(root, 'brains', 'brain-1', 'brain.md'), '# Personal\n', 'utf8');
    await writeFile(join(root, 'brains', 'brain-1', 'records', '2026', '07', 'record-1.md'), '---\n{}\n---\n', 'utf8');
    await writeFile(join(root, 'inbox', 'pending', 'item-1.md'), '---\n{}\n---\n', 'utf8');
    const bundle = await createMarkdownBundle({ dataRoot: root, snapshot: Uint8Array.from([1, 2, 3]), bindings: { workspace: 'repo' } });
    const verified = verifyMarkdownBundle(bundle);
    assert.equal(verified.manifest.formatVersion, 3);
    assert.ok(verified.files['brains/brain-1/records/2026/07/record-1.md']);
    assert.ok(verified.files['inbox/pending/item-1.md']);
    assert.equal(verified.files['memlume.sqlite'][2], 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects unlisted or unsafe entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memlume-v3-bundle-'));
  try {
    await mkdir(join(root, 'brains', 'brain-1'), { recursive: true });
    await writeFile(join(root, 'brains', 'brain-1', 'brain.md'), '# Brain\n', 'utf8');
    const bundle = await createMarkdownBundle({ dataRoot: root });
    assert.throws(() => verifyMarkdownBundle(Uint8Array.from([1, 2, 3])), /backup|invalid|checksum/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
