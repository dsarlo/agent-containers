import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as state from '../src/state.js';
import { acknowledgeUnconfirmedProcessReap, bootstrapManualRecoveryJournal, loadManualRecovery, loadMetadata, recordManualRecovery, releaseStaleWorkspaceLock, saveMetadata, setStateDurabilityAdapterForTesting, withWorkspaceLock, type WorkspaceLockOptions, type WorkspaceMetadata } from '../src/state.js';
import type { ProcessRunner } from '../src/types.js';
import type { StateDurabilityAdapter } from '../src/durability.js';

const testDurabilityAdapter: StateDurabilityAdapter = {
  publicationMode: async () => 'strict',
  assertStateWriteSupport: async () => undefined,
  syncFile: async () => undefined,
  syncDirectory: async () => undefined,
  moveFileWriteThrough: async () => undefined,
};
setStateDurabilityAdapterForTesting(testDurabilityAdapter);
test.after(() => setStateDurabilityAdapterForTesting(undefined));

const metadata: WorkspaceMetadata = { version: 1, name: 'safe', repoRoot: '/repo', worktree: '/repo/worktrees/safe', branch: 'agent-containers/safe', baseRef: 'refs/heads/main', devcontainerPath: '.devcontainer/devcontainer.json', createdAt: '2026-01-01T00:00:00.000Z' };

test('metadata rejects a filename/name mismatch and non-canonical paths', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-state-'));
  await saveMetadata(stateDir, metadata);
  await rename(join(stateDir, 'workspaces', 'safe.json'), join(stateDir, 'workspaces', 'other.json'));
  await assert.rejects(() => loadMetadata(stateDir, 'other'), /does not match/);
  await assert.rejects(() => saveMetadata(stateDir, { ...metadata, worktree: '/repo/worktrees/../safe' }), /invalid/);
  await assert.rejects(() => saveMetadata(stateDir, { ...metadata, name: 'two--hyphens', branch: 'agent-containers/two--hyphens' }), /invalid/);
});

test('metadata only persists lowercase full Docker IDs while retaining legacy records for fail-closed callers', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-container-id-'));
  await assert.rejects(() => saveMetadata(stateDir, { ...metadata, containerId: 'abcdef012345' }), /non-canonical Docker container ID/);
  const legacy = { ...metadata, containerId: 'ABCDEF012345' };
  await mkdir(join(stateDir, 'workspaces'), { recursive: true });
  await writeFile(join(stateDir, 'workspaces', 'safe.json'), JSON.stringify(legacy));
  assert.deepEqual(await loadMetadata(stateDir, 'safe'), legacy, 'legacy state remains readable so callers can fail closed with recovery guidance');
});

test('legacy recorded container IDs fail closed before removal can inspect or delete a container', async () => {
  const legacy = { ...metadata, containerId: 'abcdef012345' };
  const { removeWorkspace } = await import('../src/workspaces.js');
  let invoked = false;
  await assert.rejects(
    () => removeWorkspace(legacy, { confirmed: true }, { async run() { invoked = true; return { code: 0, stdout: '', stderr: '' }; } }, async () => undefined, async () => undefined),
    /legacy or non-canonical recorded Docker container ID/,
  );
  assert.equal(invoked, false);
});

test('metadata writes are atomic and never expose a predictable temporary file', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-state-'));
  await saveMetadata(stateDir, metadata);
  const content = await readFile(join(stateDir, 'workspaces', 'safe.json'), 'utf8');
  assert.deepEqual(JSON.parse(content), metadata);
  await writeFile(join(stateDir, 'workspaces', '.safe.json.tmp'), 'partial');
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'workspaces', 'safe.json'), 'utf8')), metadata);
});

test('recoverable Windows publication uses its write-through move without pretending to sync directories', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-windows-publication-'));
  const calls: string[] = [];
  const recoverable = {
    publicationMode: async () => 'recoverable' as const,
    assertStateWriteSupport: async () => undefined,
    syncFile: async (path: string) => { calls.push(`file:${path}`); },
    syncDirectory: async (path: string) => { calls.push(`directory:${path}`); },
    moveFileWriteThrough: async (source: string, destination: string) => {
      calls.push(`move:${source}->${destination}`);
      await rename(source, destination);
    },
  } as unknown as StateDurabilityAdapter;
  setStateDurabilityAdapterForTesting(recoverable);
  try {
    await saveMetadata(stateDir, metadata);
  } finally {
    setStateDurabilityAdapterForTesting(testDurabilityAdapter);
  }
  assert.equal(calls.some((call) => call.startsWith('move:')), true);
  assert.equal(calls.some((call) => call.startsWith('directory:')), false);
});

test('a recoverable Windows lock publication uses write-through move and never claims directory sync', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-windows-lock-'));
  const calls: string[] = [];
  const recoverable = {
    publicationMode: async () => 'recoverable' as const,
    assertStateWriteSupport: async () => undefined,
    syncFile: async () => undefined,
    syncDirectory: async () => { calls.push('directory'); },
    moveFileWriteThrough: async (source: string, destination: string) => {
      calls.push(`move:${source}->${destination}`);
      await rename(source, destination);
    },
  } as unknown as StateDurabilityAdapter;

  await withWorkspaceLock(stateDir, 'safe', async () => undefined, { durabilityAdapter: recoverable });
  assert.equal(calls.some((call) => call.startsWith('move:')), true);
  assert.equal(calls.includes('directory'), false);
});

test('recoverable Windows bootstraps the first manual recovery journal through a write-through staged-file publication without directory sync', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-windows-journal-bootstrap-'));
  const calls: string[] = [];
  const recoverable: StateDurabilityAdapter = {
    publicationMode: async () => 'recoverable',
    assertStateWriteSupport: async () => undefined,
    syncFile: async (path) => { calls.push(`file:${path}`); },
    syncDirectory: async (path) => { calls.push(`directory:${path}`); },
    moveFileWriteThrough: async (source, destination) => {
      calls.push(`move:${source}->${destination}`);
      await rename(source, destination);
    },
  };
  setStateDurabilityAdapterForTesting(recoverable);
  try {
    assert.equal(await bootstrapManualRecoveryJournal(stateDir, 'safe'), true);
  } finally {
    setStateDurabilityAdapterForTesting(testDurabilityAdapter);
  }

  const journalPath = join(stateDir, 'locks', 'safe.manual-recovery.journal');
  const move = calls.find((call) => call.startsWith('move:'));
  assert.ok(move, 'first journal bootstrap must publish through MoveFileExW write-through');
  assert.match(move, /\.safe\..+\.manual-recovery\.journal\.tmp->.*safe\.manual-recovery\.journal$/);
  assert.equal(calls.includes(`file:${journalPath}`), false, 'the final journal path is never directly initialized');
  assert.equal(calls.some((call) => call.startsWith('directory:')), false, 'recoverable Windows never claims a directory sync');
  assert.equal((await readFile(journalPath, 'utf8')), '');
});

test('failed recoverable Windows journal bootstrap blocks the lifecycle action before remote dispatch', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-windows-journal-bootstrap-failure-'));
  let remoteLifecycleDispatched = false;
  const recoverable: StateDurabilityAdapter = {
    publicationMode: async () => 'recoverable',
    assertStateWriteSupport: async () => undefined,
    syncFile: async () => undefined,
    syncDirectory: async () => undefined,
    moveFileWriteThrough: async (source, destination) => {
      if (destination.endsWith('.manual-recovery.journal')) throw new Error('write-through publication failed');
      await rename(source, destination);
    },
  };
  setStateDurabilityAdapterForTesting(recoverable);
  try {
    await assert.rejects(
      () => withWorkspaceLock(stateDir, 'safe', async () => {
        await bootstrapManualRecoveryJournal(stateDir, 'safe');
        remoteLifecycleDispatched = true;
      }),
      /write-through publication failed/,
    );
  } finally {
    setStateDurabilityAdapterForTesting(testDurabilityAdapter);
  }
  assert.equal(remoteLifecycleDispatched, false);
});

test('manual recovery journal retains an earlier recovery record when its final record is truncated', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-recovery-journal-'));
  await recordManualRecovery(stateDir, 'safe', { reason: 'operation-may-be-active', containerIds: [], worktree: metadata.worktree });
  const journalPath = join(stateDir, 'locks', 'safe.manual-recovery.journal');
  const journal = await readFile(journalPath, 'utf8');
  assert.match(journal, /"checksum"/);
  await writeFile(journalPath, `${journal}{"event":"clear"`);
  assert.equal((await loadManualRecovery(stateDir, 'safe'))?.reason, 'operation-may-be-active');
});

test('a durable manual recovery blocks lifecycle and stale-PID unlock until an explicit operator acknowledgement', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-manual-recovery-'));
  const recoveryApi = state as unknown as {
    recordManualRecovery: (stateDir: string, name: string, recovery: { reason: string; containerIds: string[]; worktree: string }) => Promise<void>;
    clearManualRecovery: (stateDir: string, name: string) => Promise<void>;
  };
  await recoveryApi.recordManualRecovery(stateDir, 'safe', { reason: 'remote-exec-interrupted', containerIds: ['container-1'], worktree: '/repo/worktrees/safe' });
  await assert.rejects(() => withWorkspaceLock(stateDir, 'safe', async () => undefined), /manual recovery.*recover safe --yes --remote-command-stopped/i);
  await assert.rejects(() => releaseStaleWorkspaceLock(stateDir, 'safe', () => false), /manual recovery/i);
  await recoveryApi.clearManualRecovery(stateDir, 'safe');
  let acquired = false;
  await withWorkspaceLock(stateDir, 'safe', async () => { acquired = true; });
  assert.equal(acquired, true);
});

test('withWorkspaceLock serializes same-name lifecycle operations across contenders', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-lock-'));
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>((resolveFirst) => { releaseFirst = resolveFirst; });
  let firstStarted!: () => void;
  const firstHasStarted = new Promise<void>((resolveFirstStarted) => { firstStarted = resolveFirstStarted; });
  const first = withWorkspaceLock(stateDir, 'safe', async () => {
    events.push('first-start');
    firstStarted();
    await firstCanFinish;
    events.push('first-end');
  });
  await firstHasStarted;
  const second = withWorkspaceLock(stateDir, 'safe', async () => { events.push('second'); });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(events, ['first-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'first-end', 'second']);
});

test('lock publication durably syncs the owner, staging directory, and locks directory in order', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-lock-durability-'));
  const steps: string[] = [];
  const options: WorkspaceLockOptions = {
    onLockPublication: (step: string) => { steps.push(step); },
  };
  await withWorkspaceLock(stateDir, 'safe', async () => undefined, options);
  assert.deepEqual(steps, ['owner-file-synced', 'staging-directory-synced', 'published', 'locks-directory-synced']);
});

test('a fully fresh state root and locks directory are created and synced progressively before lock publication', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-containers-fresh-state-'));
  const stateDir = join(temporaryRoot, 'state', 'agent-containers');
  const steps: string[] = [];
  await withWorkspaceLock(stateDir, 'safe', async () => undefined, {
    onStateDirectoryDurability: (step) => {
      steps.push(`${step.kind}:${step.path === temporaryRoot ? '.' : step.path.slice(temporaryRoot.length + 1)}`);
    },
  });
  assert.deepEqual(steps, [
    'created:state',
    'directory-synced:state',
    'parent-directory-synced:.',
    'created:state/agent-containers',
    'directory-synced:state/agent-containers',
    'parent-directory-synced:state',
    'created:state/agent-containers/locks',
    'directory-synced:state/agent-containers/locks',
    'parent-directory-synced:state/agent-containers',
  ]);
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

test('failed uncertain-reap recovery publication quarantines the lock from stale unlock until explicit acknowledgement', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-quarantined-lock-'));
  const { UnconfirmedProcessReapError } = await import('../src/workspaces.js');
  await assert.rejects(
    () => withWorkspaceLock(stateDir, 'safe', async () => { throw new UnconfirmedProcessReapError(); }, {
      onUnconfirmedProcessReap: async () => { throw new Error('recovery disk full'); },
    }),
    /recovery disk full/,
  );
  await assert.rejects(() => releaseStaleWorkspaceLock(stateDir, 'safe', () => false), /quarantined.*Ordinary unlock never clears/i);
  await acknowledgeUnconfirmedProcessReap(stateDir, 'safe');
  let acquired = false;
  await withWorkspaceLock(stateDir, 'safe', async () => { acquired = true; });
  assert.equal(acquired, true);
});

test('unlock preserves malformed published lifecycle locks and directs verified manual filesystem repair', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-malformed-lock-'));
  const lockPath = join(stateDir, 'locks', 'safe.lock');
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, 'owner.json'), '{not-json');
  await assert.rejects(
    () => releaseStaleWorkspaceLock(stateDir, 'safe', () => false),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message.includes(`perform manual filesystem repair: remove ${lockPath}, then retry the original lifecycle operation.`),
        true,
        'manual deletion is the repair and the user must retry the lifecycle operation that was blocked',
      );
      assert.doesNotMatch(error.message, /retry agent-containers unlock safe --yes/i);
      return true;
    },
  );
  assert.equal((await lstat(lockPath)).isDirectory(), true, 'unlock never deletes a published lock whose owner cannot be identified');
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

test('unlock reclaims a dead published recovery owner after an interrupted unlock and can retry safely', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-unlock-retry-'));
  const locksDir = join(stateDir, 'locks');
  const lockPath = join(locksDir, 'safe.lock');
  const recoveryPath = join(locksDir, 'safe.recovery');
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: 424242, token: '66666666-6666-4666-8666-666666666666' }));
  await mkdir(recoveryPath, { recursive: true });
  await writeFile(join(recoveryPath, 'owner.json'), JSON.stringify({ pid: 424242, token: '77777777-7777-4777-8777-777777777777' }));
  await releaseStaleWorkspaceLock(stateDir, 'safe', () => false, {}, 100);
  let acquired = false;
  await withWorkspaceLock(stateDir, 'safe', async () => { acquired = true; });
  assert.equal(acquired, true);
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
