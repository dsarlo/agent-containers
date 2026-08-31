import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadMetadata, saveMetadata, withWorkspaceLock, type WorkspaceMetadata } from '../src/state.js';

const metadata: WorkspaceMetadata = { version: 1, name: 'safe', repoRoot: '/repo', worktree: '/repo/worktrees/safe', branch: 'agent-containers/safe', baseBranch: 'main', devcontainerPath: '.devcontainer/devcontainer.json', createdAt: '2026-01-01T00:00:00.000Z' };

test('metadata rejects a filename/name mismatch and non-canonical paths', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-state-'));
  await saveMetadata(stateDir, metadata);
  await rename(join(stateDir, 'workspaces', 'safe.json'), join(stateDir, 'workspaces', 'other.json'));
  await assert.rejects(() => loadMetadata(stateDir, 'other'), /does not match/);
  await assert.rejects(() => saveMetadata(stateDir, { ...metadata, worktree: '/repo/worktrees/../safe' }), /invalid/);
  await assert.rejects(() => saveMetadata(stateDir, { ...metadata, name: 'two--hyphens', branch: 'agent-containers/two--hyphens' }), /invalid/);
});

test('metadata writes are atomic and never expose a predictable temporary file', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-state-'));
  await saveMetadata(stateDir, metadata);
  const content = await readFile(join(stateDir, 'workspaces', 'safe.json'), 'utf8');
  assert.deepEqual(JSON.parse(content), metadata);
  await writeFile(join(stateDir, 'workspaces', '.safe.json.tmp'), 'partial');
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'workspaces', 'safe.json'), 'utf8')), metadata);
});

test('withWorkspaceLock serializes same-name lifecycle operations across contenders', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-lock-'));
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>((resolveFirst) => { releaseFirst = resolveFirst; });
  const first = withWorkspaceLock(stateDir, 'safe', async () => {
    events.push('first-start');
    await firstCanFinish;
    events.push('first-end');
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = withWorkspaceLock(stateDir, 'safe', async () => { events.push('second'); });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(events, ['first-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'first-end', 'second']);
});

test('withWorkspaceLock makes a lifecycle contender observe deletion rather than restore stale metadata', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-lock-'));
  await saveMetadata(stateDir, metadata);
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>((resolveFirst) => { releaseFirst = resolveFirst; });
  const first = withWorkspaceLock(stateDir, 'safe', async () => {
    await rm(join(stateDir, 'workspaces', 'safe.json'));
    await firstCanFinish;
  });
  await new Promise((resolve) => setImmediate(resolve));
  let contenderRan = false;
  const contender = withWorkspaceLock(stateDir, 'safe', async () => {
    contenderRan = true;
    assert.equal(await loadMetadata(stateDir, 'safe'), undefined);
  });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(contenderRan, false, 'contender has not run while destructive owner holds the lock');
  releaseFirst();
  await Promise.all([first, contender]);
  assert.equal(await loadMetadata(stateDir, 'safe'), undefined);
});
