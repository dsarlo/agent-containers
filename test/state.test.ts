import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createNativeDurabilityAdapter } from '../src/durability.js';
import * as state from '../src/state.js';
import { acknowledgeUnconfirmedProcessReap, bootstrapManualRecoveryJournal, listMetadata, loadManualRecovery, loadMetadata, recordManualRecovery, releaseStaleWorkspaceLock, saveMetadata, setStateDurabilityAdapterForTesting, setStateDurableRenameForTesting, setStateJournalStagingWriteForTesting, withWorkspaceLock, type WorkspaceLockOptions, type WorkspaceMetadata } from '../src/state.js';
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

const repoRoot = resolve(tmpdir(), 'agent-containers-repo');
const worktreeRoot = join(repoRoot, 'worktrees');
const metadata: WorkspaceMetadata = { version: 1, name: 'safe', repoRoot, worktree: join(worktreeRoot, 'safe'), branch: 'agent-containers/safe', baseRef: 'refs/heads/main', devcontainerPath: '.devcontainer/devcontainer.json', createdAt: '2026-01-01T00:00:00.000Z' };

test('metadata rejects a filename/name mismatch and non-canonical paths', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-state-'));
  await saveMetadata(stateDir, metadata);
  await rename(join(stateDir, 'workspaces', 'safe.json'), join(stateDir, 'workspaces', 'other.json'));
  await assert.rejects(() => loadMetadata(stateDir, 'other'), /does not match/);
  const nonCanonicalWorktree = `${metadata.worktree}${sep}..${sep}${metadata.name}`;
  await assert.rejects(() => saveMetadata(stateDir, { ...metadata, worktree: nonCanonicalWorktree }), /invalid/);
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

test('listMetadata reads in bounded batches and returns deterministic workspace-name order', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-list-metadata-'));
  for (const name of ['zeta', 'alpha', 'middle']) await saveMetadata(stateDir, { ...metadata, name, branch: `agent-containers/${name}`, worktree: join(worktreeRoot, name) });
  assert.deepEqual((await listMetadata(stateDir)).map((entry) => entry.name), ['alpha', 'middle', 'zeta']);
});

test('manual recovery drops non-canonical container hints rather than persisting untrusted IDs', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-recovery-container-hints-'));
  const canonical = 'a'.repeat(64);
  await recordManualRecovery(stateDir, 'safe', { reason: 'devcontainer-up-ambiguous', containerIds: ['not-a-container', canonical], worktree: metadata.worktree });
  assert.deepEqual((await loadManualRecovery(stateDir, 'safe'))?.containerIds, [canonical]);
});

test('legacy recovery journals retain their barrier while discarding short Docker ID hints', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-legacy-recovery-id-'));
  const recovery = { version: 1, reason: 'operation-may-be-active', containerIds: ['abcdef012345'], worktree: metadata.worktree, createdAt: '2026-01-01T00:00:00.000Z' };
  const event = { event: 'set' as const, recovery };
  const entry = { ...event, checksum: createHash('sha256').update(JSON.stringify(event)).digest('hex') };
  await mkdir(join(stateDir, 'locks'), { recursive: true });
  await writeFile(join(stateDir, 'locks', 'safe.manual-recovery.journal'), `${JSON.stringify(entry)}\n`);

  assert.deepEqual(await loadManualRecovery(stateDir, 'safe'), {
    ...recovery,
    generation: (await loadManualRecovery(stateDir, 'safe'))?.generation,
    containerIds: [],
  });
});

test('legacy recovery identities bind acknowledgements to the stored short-ID record', async () => {
  for (const format of ['journal', 'json'] as const) {
    const stateDir = await mkdtemp(join(tmpdir(), `agent-containers-legacy-recovery-generation-${format}-`));
    const first = { version: 1, reason: 'operation-may-be-active' as const, containerIds: ['a'.repeat(12)], worktree: metadata.worktree, createdAt: '2026-01-01T00:00:00.000Z' };
    const second = { ...first, containerIds: ['b'.repeat(12)] };
    await mkdir(join(stateDir, 'locks'), { recursive: true });
    const path = join(stateDir, 'locks', `safe.manual-recovery.${format === 'journal' ? 'journal' : 'json'}`);
    const encode = (recovery: typeof first) => {
      if (format === 'json') return JSON.stringify(recovery);
      const event = { event: 'set' as const, recovery };
      return `${JSON.stringify({ ...event, checksum: createHash('sha256').update(JSON.stringify(event)).digest('hex') })}\n`;
    };
    await writeFile(path, encode(first));
    const observed = await loadManualRecovery(stateDir, 'safe');
    assert.ok(observed);
    await writeFile(path, encode(second));

    await assert.rejects(() => state.clearManualRecoveryIfCurrent(stateDir, 'safe', observed.generation), /changed since it was acknowledged/i);
    assert.notEqual((await loadManualRecovery(stateDir, 'safe'))?.generation, observed.generation);
    assert.deepEqual((await loadManualRecovery(stateDir, 'safe'))?.containerIds, []);
  }
});

test('legacy recovery remains a barrier when every staged journal migration boundary fails', async () => {
  for (const boundary of ['staging write', 'staging sync', 'publication', 'journal parent sync'] as const) {
    const stateDir = await mkdtemp(join(tmpdir(), `agent-containers-legacy-migration-${boundary.replace(' ', '-')}-`));
    await mkdir(join(stateDir, 'locks'), { recursive: true });
    const legacy = { version: 1, reason: 'operation-may-be-active', containerIds: [], worktree: metadata.worktree, createdAt: '2026-01-01T00:00:00.000Z' };
    await writeFile(join(stateDir, 'locks', 'safe.manual-recovery.json'), JSON.stringify(legacy));
    let fail = true;
    const adapter: StateDurabilityAdapter = {
      ...testDurabilityAdapter,
      syncFile: async (path) => { if (fail && boundary === 'staging sync' && path.endsWith('.manual-recovery.journal.tmp')) throw new Error(boundary); },
      syncDirectory: async (path) => { if (fail && boundary === 'journal parent sync' && path.endsWith('locks')) throw new Error(boundary); },
    };
    setStateDurabilityAdapterForTesting(adapter);
    if (boundary === 'staging write') setStateJournalStagingWriteForTesting(async () => { throw new Error(boundary); });
    if (boundary === 'publication') setStateDurableRenameForTesting(async () => { throw new Error(boundary); });
    try {
      await assert.rejects(() => bootstrapManualRecoveryJournal(stateDir, 'safe'), new RegExp(boundary));
      assert.deepEqual(await loadManualRecovery(stateDir, 'safe'), { ...legacy, generation: (await loadManualRecovery(stateDir, 'safe'))?.generation }, `${boundary} must retain the legacy barrier`);
    } finally {
      fail = false;
      setStateDurableRenameForTesting(undefined);
      setStateJournalStagingWriteForTesting(undefined);
      setStateDurabilityAdapterForTesting(testDurabilityAdapter);
    }
  }
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

test('a partial journal tail is durably repaired before the next recovery append', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-recovery-journal-repair-'));
  await recordManualRecovery(stateDir, 'safe', { reason: 'operation-may-be-active', containerIds: [], worktree: metadata.worktree });
  const journalPath = join(stateDir, 'locks', 'safe.manual-recovery.journal');
  const journal = await readFile(journalPath, 'utf8');
  await writeFile(journalPath, `${journal}{"event":"clear"`);
  await recordManualRecovery(stateDir, 'safe', { reason: 'remote-exec-interrupted', containerIds: [], worktree: metadata.worktree });
  assert.equal((await loadManualRecovery(stateDir, 'safe'))?.reason, 'remote-exec-interrupted');
  assert.equal((await readFile(journalPath, 'utf8')).endsWith('\n'), true);
});

test('a stale recovery observation cannot clear a newer manual recovery record', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-recovery-generation-'));
  await recordManualRecovery(stateDir, 'safe', { reason: 'operation-may-be-active', containerIds: [], worktree: metadata.worktree });
  const observed = await loadManualRecovery(stateDir, 'safe');
  assert.ok(observed);
  await recordManualRecovery(stateDir, 'safe', { reason: 'remote-exec-interrupted', containerIds: [], worktree: metadata.worktree });
  await assert.rejects(() => state.clearManualRecoveryIfCurrent(stateDir, 'safe', observed.generation), /changed since it was acknowledged/i);
  assert.equal((await loadManualRecovery(stateDir, 'safe'))?.reason, 'remote-exec-interrupted');
});

test('a failed strict clear retains a durable recovery barrier and a retry clears it', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-recovery-clear-failure-'));
  await recordManualRecovery(stateDir, 'safe', { reason: 'operation-may-be-active', containerIds: [], worktree: metadata.worktree });
  let failClearSync = true;
  let locksSyncs = 0;
  setStateDurabilityAdapterForTesting({
    ...testDurabilityAdapter,
    syncDirectory: async (path) => {
      if (path === join(stateDir, 'locks')) locksSyncs += 1;
      if (failClearSync && locksSyncs === 2) {
        failClearSync = false;
        throw new Error('locks sync failed');
      }
    },
  });
  try {
    await assert.rejects(() => state.clearManualRecovery(stateDir, 'safe'), /locks sync failed/);
  } finally {
    setStateDurabilityAdapterForTesting(testDurabilityAdapter);
  }
  assert.ok(await loadManualRecovery(stateDir, 'safe'), 'a failed clear must retain the recovery barrier');
  await state.clearManualRecovery(stateDir, 'safe');
  assert.equal(await loadManualRecovery(stateDir, 'safe'), undefined);
});

test('a journal-clear parent sync failure never admits lifecycle after its visible clear', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-recovery-clear-journal-sync-'));
  await recordManualRecovery(stateDir, 'safe', { reason: 'operation-may-be-active', containerIds: [], worktree: metadata.worktree });
  const observed = await loadManualRecovery(stateDir, 'safe');
  assert.ok(observed);
  let locksSyncs = 0;
  setStateDurabilityAdapterForTesting({
    ...testDurabilityAdapter,
    syncDirectory: async (path) => {
      if (path === join(stateDir, 'locks') && ++locksSyncs === 2) throw new Error('journal-clear parent sync failed');
    },
  });
  try {
    await assert.rejects(() => state.clearManualRecoveryIfCurrent(stateDir, 'safe', observed.generation), /journal-clear parent sync failed/);
    assert.equal((await loadManualRecovery(stateDir, 'safe'))?.generation, observed.generation);
    let lifecycleRan = false;
    await assert.rejects(() => withWorkspaceLock(stateDir, 'safe', async () => { lifecycleRan = true; }), /manual recovery/i);
    assert.equal(lifecycleRan, false);
  } finally {
    setStateDurabilityAdapterForTesting(testDurabilityAdapter);
  }
  await state.clearManualRecoveryIfCurrent(stateDir, 'safe', observed.generation);
  assert.equal(await loadManualRecovery(stateDir, 'safe'), undefined);
});

test('a post-delete failsafe directory-sync failure completes the committed acknowledgement', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-recovery-clear-post-delete-'));
  await recordManualRecovery(stateDir, 'safe', { reason: 'operation-may-be-active', containerIds: [], worktree: metadata.worktree });
  const observed = await loadManualRecovery(stateDir, 'safe');
  assert.ok(observed);
  let locksSyncs = 0;
  let failPostDeleteSync = true;
  const failsafePath = join(stateDir, 'locks', 'safe.manual-recovery.clear-failsafe.json');
  setStateDurabilityAdapterForTesting({
    ...testDurabilityAdapter,
    syncDirectory: async (path) => {
      if (path !== join(stateDir, 'locks')) return;
      locksSyncs += 1;
      if (!failPostDeleteSync || locksSyncs !== 3) return;
      try {
        await lstat(failsafePath);
      } catch (error: unknown) {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
      throw new Error('post-delete failsafe sync failed');
    },
  });
  try {
    await state.clearManualRecoveryIfCurrent(stateDir, 'safe', observed.generation);
    assert.equal(locksSyncs, 3, 'the journal clear is durably published before failsafe cleanup');
    const retained = await loadManualRecovery(stateDir, 'safe');
    assert.equal(retained, undefined, 'a durable journal clear is authoritative after the final deletion sync becomes uncertain');
    setStateDurabilityAdapterForTesting(testDurabilityAdapter);
    let lifecycleRan = false;
    await withWorkspaceLock(stateDir, 'safe', async () => { lifecycleRan = true; });
    assert.equal(lifecycleRan, true, 'a successful acknowledgement may admit lifecycle work');
    failPostDeleteSync = false;
  } finally {
    setStateDurabilityAdapterForTesting(testDurabilityAdapter);
  }
});

test('a post-journal-clear publication-mode failure retains the recovery barrier', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-recovery-clear-publication-mode-'));
  await recordManualRecovery(stateDir, 'safe', { reason: 'operation-may-be-active', containerIds: [], worktree: metadata.worktree });
  const observed = await loadManualRecovery(stateDir, 'safe');
  assert.ok(observed);
  let publicationModeCalls = 0;
  setStateDurabilityAdapterForTesting({
    ...testDurabilityAdapter,
    publicationMode: async () => {
      publicationModeCalls += 1;
      if (publicationModeCalls === 5) throw new Error('publication mode unavailable after journal clear');
      return 'strict';
    },
  });
  try {
    await assert.rejects(() => state.clearManualRecoveryIfCurrent(stateDir, 'safe', observed.generation), /publication mode unavailable after journal clear/);
    assert.equal((await loadManualRecovery(stateDir, 'safe'))?.generation, observed.generation);
    let lifecycleRan = false;
    await assert.rejects(() => withWorkspaceLock(stateDir, 'safe', async () => { lifecycleRan = true; }), /manual recovery/i);
    assert.equal(lifecycleRan, false);
  } finally {
    setStateDurabilityAdapterForTesting(testDurabilityAdapter);
  }
});

test('a durable manual recovery blocks lifecycle and stale-PID unlock until an explicit operator acknowledgement', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-manual-recovery-'));
  const recoveryApi = state as unknown as {
    recordManualRecovery: (stateDir: string, name: string, recovery: { reason: string; containerIds: string[]; worktree: string }) => Promise<void>;
    clearManualRecovery: (stateDir: string, name: string) => Promise<void>;
  };
  await recoveryApi.recordManualRecovery(stateDir, 'safe', { reason: 'remote-exec-interrupted', containerIds: ['container-1'], worktree: metadata.worktree });
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

test('withWorkspaceLock retries a Windows-style EPERM only when a recovery lock was concurrently published', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-windows-recovery-collision-'));
  let recoveryPublications = 0;
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolveFirst) => { releaseFirst = resolveFirst; });
  let firstStarted!: () => void;
  const firstHasStarted = new Promise<void>((resolveFirstStarted) => { firstStarted = resolveFirstStarted; });
  let collisionObserved!: () => void;
  const collisionWasObserved = new Promise<void>((resolveCollision) => { collisionObserved = resolveCollision; });
  setStateDurableRenameForTesting(async (source, destination) => {
    if (destination.endsWith('safe.recovery') && recoveryPublications++ === 1) {
      collisionObserved();
      throw Object.assign(new Error('Windows directory collision'), { code: 'EPERM' });
    }
    await rename(source, destination);
  });
  try {
    const first = withWorkspaceLock(stateDir, 'safe', async () => {
      firstStarted();
      await firstMayFinish;
    });
    await firstHasStarted;
    let secondRan = false;
    const second = withWorkspaceLock(stateDir, 'safe', async () => { secondRan = true; });
    await collisionWasObserved;
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(secondRan, true);
  } finally {
    setStateDurableRenameForTesting(undefined);
  }
});

test('withWorkspaceLock does not retry an EPERM without a published recovery-lock collision', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-windows-recovery-permission-'));
  setStateDurableRenameForTesting(async (source, destination) => {
    if (destination.endsWith('safe.recovery')) throw Object.assign(new Error('Windows permission denied'), { code: 'EPERM' });
    await rename(source, destination);
  });
  try {
    await assert.rejects(
      () => withWorkspaceLock(stateDir, 'safe', async () => undefined),
      /Windows permission denied/,
    );
  } finally {
    setStateDurableRenameForTesting(undefined);
  }
});

test('withWorkspaceLock retries native Windows access denial while retiring its validated recovery lock', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-windows-recovery-retirement-'));
  let retirementAttempts = 0;
  const recoverable = createNativeDurabilityAdapter({
    capabilities: () => ({ regularFileSync: true, directorySync: false, writeThroughMove: true }),
    syncPath: (path) => ({ ok: true, path, target: 'file', method: 'flush-file-buffers' }),
    moveFileWriteThrough: async (source, destination) => {
      if (source.endsWith('safe.recovery') && destination.endsWith('.retired') && retirementAttempts++ === 0) {
        return { ok: false, source, destination, method: 'move-file-write-through', windowsError: 'ERROR_ACCESS_DENIED', error: 'Windows recovery retirement contention' };
      }
      await rename(source, destination);
      return { ok: true, source, destination, method: 'move-file-write-through' };
    },
  });

  await withWorkspaceLock(stateDir, 'safe', async () => undefined, { durabilityAdapter: recoverable });
  assert.equal(retirementAttempts, 2);
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
    `created:${join('state', 'agent-containers')}`,
    `directory-synced:${join('state', 'agent-containers')}`,
    'parent-directory-synced:state',
    `created:${join('state', 'agent-containers', 'locks')}`,
    `directory-synced:${join('state', 'agent-containers', 'locks')}`,
    `parent-directory-synced:${join('state', 'agent-containers')}`,
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

test('stale lock recovery refuses an active owner and releases a proven-dead legacy owner', async () => {
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

test('ordinary stale unlock retains a dead current guarded lock until explicit recovery acknowledgement', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-guarded-stale-lock-'));
  const lockPath = join(stateDir, 'locks', 'safe.lock');
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: 424242, token: '13131313-1313-4131-8131-131313131313' }));
  await writeFile(join(lockPath, 'reap-guard'), '');

  await assert.rejects(() => releaseStaleWorkspaceLock(stateDir, 'safe', () => false), /current guarded.*recover safe --yes --remote-command-stopped/i);
  assert.equal((await lstat(lockPath)).isDirectory(), true, 'ordinary unlock must preserve a crash-surviving guarded lock');

  await acknowledgeUnconfirmedProcessReap(stateDir, 'safe');
  await assert.rejects(() => lstat(lockPath), { code: 'ENOENT' });
});

test('explicit reap acknowledgement refuses an active current guarded owner', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-active-guarded-lock-'));
  const lockPath = join(stateDir, 'locks', 'safe.lock');
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, token: '14141414-1414-4141-8141-141414141414' }));
  await writeFile(join(lockPath, 'reap-guard'), '');

  await assert.rejects(() => acknowledgeUnconfirmedProcessReap(stateDir, 'safe'), /active PID/);
  assert.equal((await lstat(lockPath)).isDirectory(), true);
});

test('failed guarded-lock acknowledgement deletion leaves the recognized recovery barrier', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-guarded-ack-failure-'));
  const lockPath = join(stateDir, 'locks', 'safe.lock');
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: 424242, token: '15151515-1515-4151-8151-151515151515' }));
  await writeFile(join(lockPath, 'reap-guard'), '');
  let syncs = 0;
  setStateDurabilityAdapterForTesting({
    ...testDurabilityAdapter,
    syncDirectory: async () => { syncs += 1; if (syncs === 4) throw new Error('quarantine removal sync failed'); },
  });
  try {
    await assert.rejects(() => acknowledgeUnconfirmedProcessReap(stateDir, 'safe'), /quarantine removal sync failed/);
  } finally {
    setStateDurabilityAdapterForTesting(testDurabilityAdapter);
  }
  await assert.rejects(() => releaseStaleWorkspaceLock(stateDir, 'safe', () => false), /quarantined.*Ordinary unlock never clears/i);
});

test('failed uncertain-reap recovery publication refuses acknowledgement while its recorded owner remains alive', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-quarantined-lock-'));
  const { UnconfirmedProcessReapError } = await import('../src/workspaces.js');
  await assert.rejects(
    () => withWorkspaceLock(stateDir, 'safe', async () => { throw new UnconfirmedProcessReapError(); }, {
      onUnconfirmedProcessReap: async () => { throw new Error('recovery disk full'); },
    }),
    /recovery disk full/,
  );
  await assert.rejects(() => releaseStaleWorkspaceLock(stateDir, 'safe', () => false), /quarantined.*Ordinary unlock never clears/i);
  await assert.rejects(() => acknowledgeUnconfirmedProcessReap(stateDir, 'safe'), /active PID/);
});

test('explicit reap acknowledgement rejects an active lifecycle normal guard', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-normal-reap-guard-'));
  const lockPath = join(stateDir, 'locks', 'safe.lock');
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, token: '12121212-1212-4121-8121-121212121212' }));
  await writeFile(join(lockPath, 'reap-guard'), '');
  await assert.rejects(() => acknowledgeUnconfirmedProcessReap(stateDir, 'safe'), /active PID/);
  assert.equal((await lstat(lockPath)).isDirectory(), true, 'the normal lifecycle guard is not a retained uncertain-reap marker');
});

test('failed recovery publication and failed quarantine preserve the marked lifecycle lock until acknowledgement', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-retained-uncertain-lock-'));
  let directorySyncs = 0;
  let failAt = Number.POSITIVE_INFINITY;
  const failingRename: StateDurabilityAdapter = {
    ...testDurabilityAdapter,
    syncDirectory: async () => {
      directorySyncs += 1;
      if (directorySyncs === failAt) throw new Error('quarantine directory sync failed');
    },
  };
  await assert.rejects(
    () => withWorkspaceLock(stateDir, 'safe', async () => { const error = new Error('unconfirmed'); error.name = 'UnconfirmedProcessReapError'; throw error; }, {
      durabilityAdapter: failingRename,
      onLockPublication: (step) => {
        if (step === 'locks-directory-synced') failAt = directorySyncs + 2;
      },
      onUnconfirmedProcessReap: async () => { throw new Error('recovery journal unavailable'); },
    }),
    /recovery journal unavailable/,
  );
  await assert.rejects(() => releaseStaleWorkspaceLock(stateDir, 'safe', () => false), /reaping could not be confirmed.*Ordinary unlock never clears/i);
  let ran = false;
  await assert.rejects(() => withWorkspaceLock(stateDir, 'safe', async () => { ran = true; }, { timeoutMs: 0 }), /lock|uncertain/i);
  assert.equal(ran, false, 'a later lifecycle cannot proceed after both recovery persistence paths fail');
});

test('marker open, file sync, and parent publication failures still quarantine the lifecycle lock', async () => {
  for (const failure of ['open', 'file sync', 'parent publication'] as const) {
    const stateDir = await mkdtemp(join(tmpdir(), `agent-containers-marker-${failure.replace(' ', '-')}-`));
    let failMarker = false;
    const adapter: StateDurabilityAdapter = {
      ...testDurabilityAdapter,
      syncFile: async (path) => {
        if (failMarker && failure === 'file sync' && path.endsWith('reap-unconfirmed')) throw new Error('marker file sync failed');
      },
      syncDirectory: async (path) => {
        if (failMarker && failure === 'parent publication' && path.endsWith('safe.lock')) throw new Error('marker parent publication failed');
      },
    };
    await assert.rejects(() => withWorkspaceLock(stateDir, 'safe', async () => {
      failMarker = true;
      throw new (await import('../src/workspaces.js')).UnconfirmedProcessReapError();
    }, {
      durabilityAdapter: adapter,
      onUnconfirmedProcessReap: async () => { throw new Error('journal unavailable'); },
      writeUnconfirmedReapMarker: failure === 'open' ? async () => { throw new Error('marker open failed'); } : undefined,
    }), /journal unavailable/);
    await assert.rejects(() => releaseStaleWorkspaceLock(stateDir, 'safe', () => false), /quarantined.*Ordinary unlock never clears/i);
    await assert.rejects(() => acknowledgeUnconfirmedProcessReap(stateDir, 'safe'), /active PID/);
  }
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

test('withWorkspaceLock rejects an empty published lifecycle lock without running or replacing it', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-empty-published-lock-'));
  const lockPath = join(stateDir, 'locks', 'safe.lock');
  const recoverable: StateDurabilityAdapter = {
    publicationMode: async () => 'recoverable',
    assertStateWriteSupport: async () => undefined,
    syncFile: async () => undefined,
    syncDirectory: async () => undefined,
    moveFileWriteThrough: async (source, destination) => {
      try {
        await lstat(destination);
        throw Object.assign(new Error('Windows directory collision'), { code: 'EEXIST' });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rename(source, destination);
    },
  };
  await mkdir(lockPath, { recursive: true });
  let ran = false;

  await assert.rejects(
    () => withWorkspaceLock(stateDir, 'safe', async () => { ran = true; }, { timeoutMs: 0, durabilityAdapter: recoverable }),
    /malformed owner metadata/i,
  );
  assert.equal(ran, false, 'a malformed published lock cannot be adopted as lifecycle ownership');
  assert.equal((await lstat(lockPath)).isDirectory(), true, 'the original malformed lock remains for verified manual repair');
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

test('recovery never transitions a replacement live lock after validating a dead owner', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-lock-owner-race-'));
  const locksDir = join(stateDir, 'locks');
  const lockPath = join(locksDir, 'safe.lock');
  const dead = { pid: 424242, token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: '2026-01-01T00:00:00.000Z' };
  const live = { pid: process.pid, token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', createdAt: '2026-01-01T00:00:00.000Z' };
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify(dead));
  let replaced = false;
  setStateDurableRenameForTesting(async (source, destination) => {
    if (!replaced && source === lockPath) {
      replaced = true;
      await rm(lockPath, { recursive: true });
      await mkdir(lockPath);
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify(live));
    }
    await rename(source, destination);
  });
  try {
    await assert.rejects(() => releaseStaleWorkspaceLock(stateDir, 'safe', (pid) => pid === process.pid), /owner changed|active PID/i);
    assert.deepEqual(JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')), live, 'stale recovery must not move or remove the replacement owner');
    let ran = false;
    const contender = withWorkspaceLock(stateDir, 'safe', async () => { ran = true; }, { timeoutMs: 0 });
    await assert.rejects(() => contender, /lock|active|timed out/i);
    assert.equal(ran, false, 'a lifecycle cannot run alongside the replacement owner');
  } finally {
    setStateDurableRenameForTesting(undefined);
  }
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
  let deletionFinished!: () => void;
  const deletionHasFinished = new Promise<void>((resolveDeletionFinished) => { deletionFinished = resolveDeletionFinished; });
  const first = withWorkspaceLock(stateDir, 'safe', async () => {
    await rm(join(stateDir, 'workspaces', 'safe.json'));
    deletionFinished();
    await firstCanFinish;
  });
  await deletionHasFinished;
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
