import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadMetadata, releaseStaleWorkspaceLock, saveMetadata, withWorkspaceLock, type WorkspaceMetadata } from '../src/state.js';
import type { ProcessRunner } from '../src/types.js';

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

test('an injected abort keeps the lifecycle lock until its active child is reaped', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-abort-lock-'));
  const abort = new AbortController();
  let signalAbortObserved!: () => void;
  const signalAborted = new Promise<void>((resolveAbort) => { signalAbortObserved = resolveAbort; });
  let childStarted!: () => void;
  const childIsRunning = new Promise<void>((resolveStarted) => { childStarted = resolveStarted; });
  let releaseChild!: () => void;
  const childMayExit = new Promise<void>((resolveChild) => { releaseChild = resolveChild; });
  let childReaped = false;
  const runner: ProcessRunner = {
    async run(_command, _args, options) {
      assert.ok(options?.signal, 'the controlled runner receives the lifecycle abort signal');
      childStarted();
      options.signal.addEventListener('abort', () => signalAbortObserved(), { once: true });
      await childMayExit;
      childReaped = true;
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  let actionSettled = false;
  const lifecycle = withWorkspaceLock(stateDir, 'safe', async (signal) => {
    await runner.run('long-child', [], { signal });
    actionSettled = true;
  }, { abortSignal: abort.signal });
  await childIsRunning;
  abort.abort();
  await signalAborted;
  let contenderRan = false;
  const contender = withWorkspaceLock(stateDir, 'safe', async () => { contenderRan = true; });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(childReaped, false, 'the controlled child has not been reaped');
  assert.equal(actionSettled, false, 'the enclosing lifecycle action has not settled');
  assert.equal(contenderRan, false, 'a contender cannot acquire the lock before the child is reaped');
  releaseChild();
  await Promise.all([lifecycle, contender]);
  assert.equal(childReaped, true);
  assert.equal(actionSettled, true);
  assert.equal(contenderRan, true);
});

test('stale lock recovery refuses an active owner and releases a proven-dead owner', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-stale-lock-'));
  const lockPath = join(stateDir, 'locks', 'safe.lock');
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: 424242, token: '11111111-1111-4111-8111-111111111111', createdAt: '2026-01-01T00:00:00.000Z' }));
  await assert.rejects(() => releaseStaleWorkspaceLock(stateDir, 'safe', () => true), /active PID 424242/);
  await releaseStaleWorkspaceLock(stateDir, 'safe', () => false);
  let acquired = false;
  await withWorkspaceLock(stateDir, 'safe', async () => { acquired = true; });
  assert.equal(acquired, true);
});

test('stale lock recovery serializes validation and removal with a new lifecycle acquisition', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-stale-lock-race-'));
  const lockPath = join(stateDir, 'locks', 'safe.lock');
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: 424242, token: '22222222-2222-4222-8222-222222222222', createdAt: '2026-01-01T00:00:00.000Z' }));
  let allowRemoval!: () => void;
  const removalMayFinish = new Promise<void>((resolveRemoval) => { allowRemoval = resolveRemoval; });
  let validationComplete!: () => void;
  const validationStarted = new Promise<void>((resolveValidation) => { validationComplete = resolveValidation; });
  const recovering = releaseStaleWorkspaceLock(stateDir, 'safe', () => false, {
    beforeRemoval: async () => { validationComplete(); await removalMayFinish; },
  });
  await validationStarted;
  let contenderRan = false;
  const contender = withWorkspaceLock(stateDir, 'safe', async () => { contenderRan = true; });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(contenderRan, false, 'normal acquisition must wait until stale-lock recovery removes the validated owner');
  allowRemoval();
  await Promise.all([recovering, contender]);
  assert.equal(contenderRan, true);
});

test('lock acquisition ignores interrupted unpublished lock and recovery creation stages', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-lock-crash-'));
  const locksDir = join(stateDir, 'locks');
  await mkdir(join(locksDir, '.safe.lock-empty.pending'), { recursive: true });
  await mkdir(join(locksDir, '.safe.lock-owned.pending'), { recursive: true });
  await writeFile(join(locksDir, '.safe.lock-owned.pending', 'owner.json'), JSON.stringify({ pid: 424242, token: '33333333-3333-4333-8333-333333333333' }));
  await mkdir(join(locksDir, '.safe.recovery-owned.pending'), { recursive: true });
  await writeFile(join(locksDir, '.safe.recovery-owned.pending', 'owner.json'), JSON.stringify({ pid: 424242, token: '44444444-4444-4444-8444-444444444444' }));
  let acquired = false;
  await withWorkspaceLock(stateDir, 'safe', async () => { acquired = true; }, { timeoutMs: 100 });
  assert.equal(acquired, true, 'only owner-complete directories are ever published at a lock path');
});

test('a crashed owner-complete recovery lock is reclaimed before a lifecycle operation blocks forever', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-recovery-crash-'));
  const recoveryPath = join(stateDir, 'locks', 'safe.recovery');
  await mkdir(recoveryPath, { recursive: true });
  await writeFile(join(recoveryPath, 'owner.json'), JSON.stringify({ pid: 424242, token: '55555555-5555-4555-8555-555555555555' }));
  let acquired = false;
  await withWorkspaceLock(stateDir, 'safe', async () => { acquired = true; }, { timeoutMs: 100 });
  assert.equal(acquired, true);
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
