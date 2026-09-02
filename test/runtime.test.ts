import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createDevcontainerProgressReporter, devcontainerUpFailureDetail, execNamedWorkspaceLifecycle, execWorkspace, execWorkspaceLifecycle, formatDevcontainerProgressLine, type ProcessRunner } from '../src/runtime.js';
import type { ProcessRunOptions } from '../src/types.js';
import { bootstrapManualRecoveryJournal, clearManualRecovery, deleteMetadata, isLocalWorkspaceMetadata, loadManualRecovery, loadMetadata, recordManualRecovery, saveMetadata, withWorkspaceLock, type CodespacesWorkspaceMetadata, type LocalMetadata, type WorkspaceMetadata } from '../src/state.js';
import { UnconfirmedProcessReapError } from '../src/workspaces.js';

const noOpRecovery = async (): Promise<void> => undefined;
const containerId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const untrackedContainerId = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const knownContainerId = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const repoRoot = resolve(tmpdir(), 'agent-containers-runtime-repo');
const worktree = join(repoRoot, 'worktrees', 'safe-name');

const metadata: LocalMetadata = {
  version: 1,
  name: 'safe-name',
  repoRoot,
  worktree,
  branch: 'agent-containers/safe-name',
  baseRef: 'refs/heads/main',
  devcontainerPath: '.devcontainer/devcontainer.json',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const codespacesMetadata: CodespacesWorkspaceMetadata = {
  version: 2,
  backend: 'codespaces',
  name: 'safe-name',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-01-01T00:00:00.000Z',
  control: { githubHost: 'github.com', actorId: '1', actorLogin: 'octo', ghVersion: '2.0.0' },
  repository: { id: '2', owner: 'owner', name: 'repo' },
  source: { requestedRef: 'refs/heads/main', expectedOid: '0123456789012345678901234567890123456789', effectiveBranch: 'agent-containers/safe-name', devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' },
  remote: { codespaceId: '3', name: 'safe-codespace', environmentId: 'env', ownerId: '1', ownerLogin: 'octo', billableOwnerId: '1', machine: 'basicLinux32gb', geo: 'WestUs2', createdAt: '2026-01-01T00:00:00.000Z' },
  lifecycle: { desired: 'ready', normalized: 'provisioning', providerRawState: 'Provisioning', lastObservedAt: '2026-01-01T00:00:00.000Z', activeOperation: null },
  recovery: null,
  cleanup: { remoteStopped: false, remoteDeleted: false, tombstoneWritten: false },
};

const ownedInspection = (id: string): string => `${id}\n${metadata.worktree}\n`;

test('Codespaces metadata never enters a local lifecycle, recovery, or container path', async () => {
  let runnerCalls = 0;
  let saveCalls = 0;
  let recoveryCalls = 0;
  const runner: ProcessRunner = { async run() { runnerCalls += 1; return { code: 0, stdout: '', stderr: '' }; } };

  await assert.rejects(
    () => execWorkspace(codespacesMetadata, ['true'], runner, async () => { saveCalls += 1; }, async () => '{}', undefined, async () => { recoveryCalls += 1; }),
    /Codespaces backend.*not implemented/i,
  );
  assert.equal(runnerCalls, 0);
  assert.equal(saveCalls, 0);
  assert.equal(recoveryCalls, 0);
});

test('execWorkspace uses the linked-worktree mount, requires a current container ID, and inherits the terminal for agents', async () => {
  const calls: Array<{ command: string; args: string[]; options?: ProcessRunOptions }> = [];
  let saved: LocalMetadata | undefined;
  const runner: ProcessRunner = {
    async run(command, args, options) {
      calls.push({ command, args, options });
      if (args[0] === 'up') return { code: 0, stdout: `[info] started\n{"outcome":"success","containerId":"${containerId}"}\n`, stderr: '' };
      if (args[0] === 'inspect') return { code: 0, stdout: ownedInspection(containerId), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };

  await execWorkspace(metadata, ['sh', '-lc', 'printf "$HOME;$(whoami)"'], runner, async (next) => { saved = next; }, async () => '{}', undefined, noOpRecovery, noOpRecovery);
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
    { command: 'devcontainer', args: ['up', '--workspace-folder', worktree, '--config', join(worktree, '.devcontainer/devcontainer.json'), '--log-format', 'json', '--mount-git-worktree-common-dir'] },
    { command: 'docker', args: ['inspect', '--format', '{{.Id}}\n{{ index .Config.Labels "devcontainer.local_folder" }}', containerId] },
    { command: 'devcontainer', args: ['exec', '--workspace-folder', worktree, '--config', join(worktree, '.devcontainer/devcontainer.json'), '--container-id', containerId, '--mount-git-worktree-common-dir', 'sh', '-lc', 'printf "$HOME;$(whoami)"'] },
  ]);
  assert.equal(calls[0].options?.stdio, 'pipe');
  assert.equal(typeof (calls[0].options as { onOutput?: unknown } | undefined)?.onOutput, 'function');
  assert.deepEqual(calls[2].options, { kind: 'lifecycle', stdio: 'inherit' });
  assert.equal(saved?.containerId, containerId);
});

test('Dev Containers JSON progress formatting emits only compact structured messages', () => {
  assert.equal(formatDevcontainerProgressLine('{"type":"text","level":2,"text":"[231 ms] Start: Run: docker build"}'), 'Start: Run: docker build');
  assert.equal(formatDevcontainerProgressLine('{"type":"progress","message":"Building development container"}'), 'Building development container');
  assert.equal(formatDevcontainerProgressLine(`{"outcome":"success","containerId":"${containerId}"}`), undefined);
  assert.equal(formatDevcontainerProgressLine('ordinary non-JSON output'), undefined);
});

test('Dev Containers progress reporter frames JSON lines split across output chunks', () => {
  const reported: string[] = [];
  const report = createDevcontainerProgressReporter((message) => reported.push(message));
  report({ stream: 'stdout', text: '{"type":"progress","message":"Building' });
  report({ stream: 'stdout', text: ' development container"}\n{"outcome":"success"}\n' });
  assert.deepEqual(reported, ['Building development container']);
});

test('Dev Containers up failure detail leads with the last meaningful structured cause and stays bounded', () => {
  const detail = devcontainerUpFailureDetail({
    code: 17,
    stdout: `${JSON.stringify({ type: 'text', text: 'fetching base image' })}\n${JSON.stringify({ type: 'text', text: '#9 ERROR: failed to solve: process "/bin/sh -c npm ci" did not complete successfully' })}\n${JSON.stringify({ type: 'text', text: 'irrelevant'.repeat(100_000) })}\n`,
    stderr: '',
  });
  assert.match(detail, /^#9 ERROR: failed to solve:/);
  assert.ok(detail.length < 2_500, 'failure detail remains bounded instead of replaying the JSON transcript');
  assert.equal(detail.includes('{"type"'), false, 'raw JSON transcript is never included');
});

test('execWorkspace refuses successful up output without a terminal container ID', async () => {
  const runner: ProcessRunner = { async run() { return { code: 0, stdout: '{"outcome":"success"}\n', stderr: '' }; } };
  await assert.rejects(() => execWorkspace(metadata, ['true'], runner, async () => undefined, async () => '{}', undefined, noOpRecovery, noOpRecovery), /containerId/);
});

test('execWorkspace refuses dispatch when its durable pre-dispatch operation guard cannot be persisted', async () => {
  const calls: string[] = [];
  const runner: ProcessRunner = {
    async run(command, args) {
      calls.push(`${command} ${args[0]}`);
      return args[0] === 'up'
        ? { code: 0, stdout: `{"outcome":"success","containerId":"${containerId}"}\n`, stderr: '' }
        : args[0] === 'inspect' ? { code: 0, stdout: ownedInspection(containerId), stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    },
  };

  await assert.rejects(
    () => (execWorkspace as (...args: unknown[]) => Promise<unknown>)(metadata, ['true'], runner, async () => undefined, async () => '{}', undefined, async () => { throw new Error('state disk full'); }),
    /state disk full/,
  );
  assert.deepEqual(calls, [], 'no local Dev Containers command is dispatched without durable protection');
});

test('execWorkspace clears its pre-dispatch operation guard only after confirmed normal completion', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-normal-operation-'));
  const runner: ProcessRunner = {
    async run(_command, args) {
      return args[0] === 'up'
        ? { code: 0, stdout: `{"outcome":"success","containerId":"${containerId}"}\n`, stderr: '' }
        : args[0] === 'inspect' ? { code: 0, stdout: ownedInspection(containerId), stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    },
  };

  await (execWorkspace as (...args: unknown[]) => Promise<unknown>)(
    metadata,
    ['true'],
    runner,
    async () => undefined,
    async () => '{}',
    undefined,
    (recovery: { reason: 'operation-may-be-active' | 'remote-exec-interrupted' | 'devcontainer-up-ambiguous'; containerIds: string[]; worktree: string }) => recordManualRecovery(stateDir, metadata.name, recovery),
    () => clearManualRecovery(stateDir, metadata.name),
  );
  assert.equal(await loadManualRecovery(stateDir, metadata.name), undefined);
});

test('execWorkspaceLifecycle supplies durable recovery callbacks under the workspace lifecycle lock', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-live-lifecycle-'));
  const id = containerId;
  const runner: ProcessRunner = {
    async run(_command, args) {
      return args[0] === 'up'
        ? { code: 0, stdout: `{"outcome":"success","containerId":"${id}"}\n`, stderr: '' }
        : args[0] === 'inspect' ? { code: 0, stdout: ownedInspection(id), stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    },
  };

  await bootstrapManualRecoveryJournal(stateDir, metadata.name);
  await saveMetadata(stateDir, metadata);
  await execWorkspaceLifecycle(metadata, ['true'], runner, async () => undefined, stateDir, async () => '{}');
  assert.equal(await loadManualRecovery(stateDir, metadata.name), undefined);
  await withWorkspaceLock(stateDir, metadata.name, async () => undefined);
});

test('execWorkspaceLifecycle reloads recorded metadata under its lock instead of persisting a stale terminal ID', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-stale-lifecycle-'));
  const recorded = { ...metadata, containerId: knownContainerId };
  await bootstrapManualRecoveryJournal(stateDir, metadata.name);
  await saveMetadata(stateDir, metadata);
  let releaseUpdate!: () => void;
  const updateMayFinish = new Promise<void>((resolveUpdate) => { releaseUpdate = resolveUpdate; });
  let updatePersisted!: () => void;
  const updateIsPersisted = new Promise<void>((resolvePersisted) => { updatePersisted = resolvePersisted; });
  const update = withWorkspaceLock(stateDir, metadata.name, async () => {
    await saveMetadata(stateDir, recorded);
    updatePersisted();
    await updateMayFinish;
  });
  await updateIsPersisted;
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: ProcessRunner = {
    async run(command, args) {
      calls.push({ command, args });
      if (args[0] === 'up') return { code: 0, stdout: `{"outcome":"success","containerId":"${untrackedContainerId}"}\n`, stderr: '' };
      if (args[0] === 'inspect') return { code: 0, stdout: ownedInspection(untrackedContainerId), stderr: '' };
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
  };

  const executing = execWorkspaceLifecycle(metadata, ['true'], runner, async () => { throw new Error('stale save seam must not be used'); }, stateDir, async () => '{}');
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(calls.length, 0, 'the stale lifecycle invocation waits for the concurrent metadata update');
  releaseUpdate();
  await update;
  await assert.rejects(
    () => executing,
    /recorded container.*manual recovery/i,
  );
  const persisted = await loadMetadata(stateDir, metadata.name);
  assert.ok(persisted && isLocalWorkspaceMetadata(persisted));
  assert.equal(persisted.containerId, knownContainerId, 'the canonical record is not replaced by the stale invocation');
  const recovery = await loadManualRecovery(stateDir, metadata.name);
  assert.equal(recovery?.reason, 'devcontainer-up-ambiguous');
  assert.deepEqual(recovery?.containerIds, [knownContainerId, untrackedContainerId]);
  assert.equal(recovery?.worktree, metadata.worktree);
  assert.equal(calls.some((call) => call.command === 'devcontainer' && call.args[0] === 'exec'), false, 'the ambiguous terminal is never executed');
  assert.equal(calls.some((call) => call.command === 'docker' && call.args[0] === 'rm'), false, 'the ambiguous terminal is never deleted');
});

test('execWorkspaceLifecycle records known and terminal IDs when Docker inspection throws', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-inspect-throw-known-'));
  const recorded = { ...metadata, containerId: knownContainerId };
  await bootstrapManualRecoveryJournal(stateDir, metadata.name);
  await saveMetadata(stateDir, recorded);
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: ProcessRunner = {
    async run(command, args) {
      calls.push({ command, args });
      if (args[0] === 'up') return { code: 0, stdout: `{"outcome":"success","containerId":"${untrackedContainerId}"}\n`, stderr: '' };
      if (args[0] === 'inspect') throw new Error('Docker inspection transport failed');
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
  };

  await assert.rejects(() => execWorkspaceLifecycle(recorded, ['true'], runner, async () => undefined, stateDir, async () => '{}'), /Docker inspection transport failed.*manual recovery/i);
  const persisted = await loadMetadata(stateDir, metadata.name);
  assert.ok(persisted && isLocalWorkspaceMetadata(persisted));
  assert.equal(persisted.containerId, knownContainerId);
  const recovery = await loadManualRecovery(stateDir, metadata.name);
  assert.equal(recovery?.reason, 'devcontainer-up-ambiguous');
  assert.deepEqual(recovery?.containerIds, [knownContainerId, untrackedContainerId]);
  assert.equal(recovery?.worktree, metadata.worktree);
  assert.equal(calls.some((call) => call.command === 'devcontainer' && call.args[0] === 'exec'), false);
  assert.equal(calls.some((call) => call.command === 'docker' && call.args[0] === 'rm'), false);
});

test('execWorkspaceLifecycle retains the terminal ID without adoption when Docker inspection throws', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-inspect-throw-new-'));
  await bootstrapManualRecoveryJournal(stateDir, metadata.name);
  await saveMetadata(stateDir, metadata);
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: ProcessRunner = {
    async run(command, args) {
      calls.push({ command, args });
      if (args[0] === 'up') return { code: 0, stdout: `{"outcome":"success","containerId":"${untrackedContainerId}"}\n`, stderr: '' };
      if (args[0] === 'inspect') throw new Error('Docker inspection transport failed');
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
  };

  await assert.rejects(() => execWorkspaceLifecycle(metadata, ['true'], runner, async () => undefined, stateDir, async () => '{}'), /Docker inspection transport failed.*manual recovery/i);
  const persisted = await loadMetadata(stateDir, metadata.name);
  assert.ok(persisted && isLocalWorkspaceMetadata(persisted));
  assert.equal(persisted.containerId, undefined, 'an unverified terminal ID is not adopted');
  const recovery = await loadManualRecovery(stateDir, metadata.name);
  assert.equal(recovery?.reason, 'devcontainer-up-ambiguous');
  assert.deepEqual(recovery?.containerIds, [untrackedContainerId]);
  assert.equal(recovery?.worktree, metadata.worktree);
  assert.equal(calls.some((call) => call.command === 'devcontainer' && call.args[0] === 'exec'), false);
});

test('unconfirmed local lifecycle reaping records a durable block before releasing the lifecycle lock', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-unconfirmed-reap-'));
  await bootstrapManualRecoveryJournal(stateDir, metadata.name);
  await saveMetadata(stateDir, metadata);
  const runner: ProcessRunner = { async run() { throw new UnconfirmedProcessReapError(); } };

  await assert.rejects(
    () => execWorkspaceLifecycle(metadata, ['true'], runner, async () => undefined, stateDir, async () => '{}'),
    /process reaping could not be confirmed.*manual-recovery block/i,
  );
  assert.equal((await loadManualRecovery(stateDir, metadata.name))?.reason, 'local-process-reap-unconfirmed');
  await assert.rejects(() => withWorkspaceLock(stateDir, metadata.name, async () => undefined), /manual recovery/);
});

test('an existing workspace initializes its recovery journal before dispatch and requires a retry', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-journal-bootstrap-'));
  await saveMetadata(stateDir, metadata);
  const calls: string[] = [];
  const runner: ProcessRunner = {
    async run(command, args) {
      calls.push(`${command} ${args[0]}`);
      return args[0] === 'up'
        ? { code: 0, stdout: `{"outcome":"success","containerId":"${containerId}"}\n`, stderr: '' }
        : args[0] === 'inspect' ? { code: 0, stdout: ownedInspection(containerId), stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    },
  };

  await assert.rejects(() => execNamedWorkspaceLifecycle(metadata.name, ['true'], runner, stateDir, async () => '{}'), /recovery journal.*retry/i);
  assert.deepEqual(calls, [], 'journal bootstrap never dispatches Dev Containers');
  await execNamedWorkspaceLifecycle(metadata.name, ['true'], runner, stateDir, async () => '{}');
  assert.deepEqual(calls, ['devcontainer up', 'docker inspect', 'devcontainer exec']);
});

test('named lifecycle execution loads metadata only after a concurrent remove releases the workspace lock', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-named-lifecycle-race-'));
  await saveMetadata(stateDir, metadata);
  let allowRemoveToFinish!: () => void;
  const removeMayFinish = new Promise<void>((resolveRemove) => { allowRemoveToFinish = resolveRemove; });
  let metadataDeleted!: () => void;
  const metadataIsDeleted = new Promise<void>((resolveDeleted) => { metadataDeleted = resolveDeleted; });
  const remove = withWorkspaceLock(stateDir, metadata.name, async () => {
    await deleteMetadata(stateDir, metadata.name);
    metadataDeleted();
    await removeMayFinish;
  });
  await metadataIsDeleted;
  const calls: string[] = [];
  const runner: ProcessRunner = { async run(command) { calls.push(command); return { code: 0, stdout: '', stderr: '' }; } };
  const executing = execNamedWorkspaceLifecycle(metadata.name, ['true'], runner, stateDir, async () => '{}');
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(calls, [], 'execution cannot reach Dev Containers while remove owns the lifecycle lock');
  allowRemoveToFinish();
  await remove;
  await assert.rejects(() => executing, /No Agent Containers workspace named "safe-name"/);
  assert.deepEqual(calls, [], 'execution must not resurrect deleted metadata or run Dev Containers');
});

test('a recovery writer failure during interruption leaves the durable pre-dispatch guard blocking lifecycle release', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-interrupted-operation-'));
  const lifecycle = new AbortController();
  let writes = 0;
  const runner: ProcessRunner = {
    async run(_command, args, options) {
      if (args[0] === 'up') return { code: 0, stdout: `{"outcome":"success","containerId":"${containerId}"}\n`, stderr: '' };
      if (args[0] === 'inspect') return { code: 0, stdout: ownedInspection(containerId), stderr: '' };
      if (args[0] !== 'exec') throw new Error(`unexpected command: ${args.join(' ')}`);
      queueMicrotask(() => lifecycle.abort());
      await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { code: 143, stdout: '', stderr: 'local CLI interrupted' };
    },
  };
  const record = async (recovery: { reason: 'operation-may-be-active' | 'remote-exec-interrupted' | 'devcontainer-up-ambiguous'; containerIds: string[]; worktree: string }): Promise<void> => {
    writes += 1;
    if (writes === 1) return recordManualRecovery(stateDir, metadata.name, recovery);
    throw new Error('recovery storage failed');
  };

  await assert.rejects(
    () => (execWorkspace as (...args: unknown[]) => Promise<unknown>)(metadata, ['true'], runner, async () => undefined, async () => '{}', lifecycle.signal, record, () => clearManualRecovery(stateDir, metadata.name)),
    /recovery storage failed/,
  );
  assert.equal((await loadManualRecovery(stateDir, metadata.name))?.reason, 'operation-may-be-active');
  await assert.rejects(() => withWorkspaceLock(stateDir, metadata.name, async () => undefined), /manual recovery/);
});

test('a nonzero devcontainer up with zero candidates retains the manual recovery block without clearing it', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const records: Array<{ reason: string; containerIds: string[]; worktree: string }> = [];
  let cleared = false;
  const runner: ProcessRunner = {
    async run(command, args) {
      calls.push({ command, args });
      if (command === 'devcontainer') return { code: 17, stdout: '', stderr: 'post-create provisioning failed' };
      if (args[0] === 'ps') return { code: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
  };

  await assert.rejects(
    () => (execWorkspace as (...args: unknown[]) => Promise<unknown>)(metadata, ['true'], runner, async () => undefined, async () => '{}', undefined, async (recovery: { reason: string; containerIds: string[]; worktree: string }) => { records.push(recovery); }, async () => { cleared = true; }),
    /post-create provisioning failed.*manual recovery/s,
  );
  assert.deepEqual(calls.filter((call) => call.command === 'docker').map((call) => call.args[0]), ['ps', 'ps', 'ps']);
  assert.deepEqual(records.at(-1), { reason: 'devcontainer-up-ambiguous', containerIds: [], worktree: metadata.worktree });
  assert.equal(cleared, false);
});

test('an interruption during zero-candidate verification retains manual recovery instead of clearing the guard', async () => {
  const lifecycle = new AbortController();
  const records: Array<{ reason: string; containerIds: string[]; worktree: string }> = [];
  let cleared = false;
  let psCalls = 0;
  const runner: ProcessRunner = {
    async run(command, args) {
      if (command === 'devcontainer') return { code: 17, stdout: '', stderr: 'provisioning failed' };
      if (args[0] === 'ps') {
        psCalls += 1;
        if (psCalls === 1) queueMicrotask(() => lifecycle.abort());
        return { code: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
  };

  await assert.rejects(
    () => (execWorkspace as (...args: unknown[]) => Promise<unknown>)(metadata, ['true'], runner, async () => undefined, async () => '{}', lifecycle.signal, async (recovery: { reason: string; containerIds: string[]; worktree: string }) => { records.push(recovery); }, async () => { cleared = true; }),
    /manual recovery/,
  );
  assert.equal(cleared, false);
  assert.deepEqual(records.at(-1), { reason: 'devcontainer-up-ambiguous', containerIds: [], worktree: metadata.worktree });
});

test('execWorkspace retains a single exact-label interrupted-up candidate as a recovery hint without adopting it', async () => {
  const lifecycle = new AbortController();
  const calls: Array<{ command: string; args: string[]; signal?: AbortSignal }> = [];
  let saves = 0;
  let recovery: unknown;
  const discoveredId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const runner: ProcessRunner = {
    async run(command, args, options) {
      calls.push({ command, args, signal: options?.signal });
      if (command === 'devcontainer') {
        queueMicrotask(() => lifecycle.abort());
        await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        return { code: 143, stdout: '', stderr: 'local CLI interrupted' };
      }
      if (args[0] === 'ps') return { code: 0, stdout: `${discoveredId}\n`, stderr: '' };
      if (args[0] === 'inspect') return { code: 0, stdout: ownedInspection(discoveredId), stderr: '' };
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
  };
  await assert.rejects(
    () => (execWorkspace as (...args: unknown[]) => Promise<unknown>)({ ...metadata, containerId: knownContainerId }, ['true'], runner, async () => { saves += 1; }, async () => '{}', lifecycle.signal, async (next: unknown) => { recovery = next; }),
    /manual recovery/,
  );
  assert.equal(saves, 0, 'ambiguous discovery cannot replace a recorded canonical ID');
  assert.deepEqual(recovery, { reason: 'devcontainer-up-ambiguous', containerIds: [knownContainerId, discoveredId], worktree: metadata.worktree });
  const discovery = calls.filter((call) => call.command === 'docker');
  assert.deepEqual(discovery.map((call) => call.args[0]), ['ps', 'inspect']);
  assert.notEqual(discovery[0].signal, lifecycle.signal, 'reconciliation survives the interrupted lifecycle signal');
  assert.equal(calls.some((call) => call.command === 'docker' && call.args[0] === 'rm'), false, 'ambiguous discovery never deletes a resource');
});

test('interrupted up with no currently discoverable container still records a manual recovery block', async () => {
  const lifecycle = new AbortController();
  let recovery: unknown;
  const runner: ProcessRunner = {
    async run(command, args, options) {
      if (command === 'devcontainer') {
        queueMicrotask(() => lifecycle.abort());
        await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        return { code: 143, stdout: '', stderr: 'local CLI interrupted' };
      }
      if (args[0] === 'ps') return { code: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
  };
  await assert.rejects(
    () => (execWorkspace as (...args: unknown[]) => Promise<unknown>)(metadata, ['true'], runner, async () => undefined, async () => '{}', lifecycle.signal, async (next: unknown) => { recovery = next; }),
    /manual recovery/,
  );
  assert.deepEqual(recovery, { reason: 'devcontainer-up-ambiguous', containerIds: [], worktree: metadata.worktree });
});

test('execWorkspace does not reuse an earlier container ID when terminal JSON omits it', async () => {
  const runner: ProcessRunner = { async run() { return { code: 0, stdout: '{"outcome":"success","containerId":"stale"}\n{"outcome":"success"}\n', stderr: '' }; } };
  await assert.rejects(() => execWorkspace(metadata, ['true'], runner, async () => undefined, async () => '{}', undefined, noOpRecovery, noOpRecovery), /containerId/);
});

test('execWorkspace rejects untrusted terminal container records without rollback deletion', async () => {
  for (const terminal of [
    '{"outcome":"success","containerId":"container-name"}',
    `{"containerId":"${containerId}"}`,
  ]) {
    const calls: Array<{ command: string; args: string[] }> = [];
    const records: Array<{ reason: string; containerIds: string[]; worktree: string }> = [];
    const runner: ProcessRunner = {
      async run(command, args) {
        calls.push({ command, args });
        if (command === 'devcontainer') return { code: 0, stdout: `${terminal}\n`, stderr: '' };
        if (args[0] === 'ps') return { code: 0, stdout: '', stderr: '' };
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      },
    };

    await assert.rejects(
      () => execWorkspace(metadata, ['true'], runner, async () => { throw new Error('metadata should not be saved'); }, async () => '{}', undefined, async (recovery) => { records.push(recovery); }, noOpRecovery),
      /manual recovery/,
    );
    assert.deepEqual(records.at(-1), { reason: 'devcontainer-up-ambiguous', containerIds: [], worktree: metadata.worktree });
    assert.equal(calls.some((call) => call.command === 'docker' && call.args[0] === 'rm'), false);
  }
});

test('execWorkspace preserves a remote command exit code', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-failed-operation-'));
  let clears = 0;
  const runner: ProcessRunner = {
    async run(_command, args) {
      return args[0] === 'up'
        ? { code: 0, stdout: `{"outcome":"success","containerId":"${containerId}"}\n`, stderr: '' }
        : args[0] === 'inspect' ? { code: 0, stdout: ownedInspection(containerId), stderr: '' }
        : { code: 42, stdout: '', stderr: 'remote command failed' };
    },
  };
  await assert.rejects(() => execWorkspace(
    metadata,
    ['false'],
    runner,
    async () => undefined,
    async () => '{}',
    undefined,
    (recovery) => recordManualRecovery(stateDir, metadata.name, recovery),
    async () => {
      clears += 1;
      await clearManualRecovery(stateDir, metadata.name);
    },
  ), (error: unknown) => {
    assert.equal((error as { exitCode?: number }).exitCode, 42);
    return true;
  });
  assert.equal(clears, 0, 'a failed terminal remote command must not clear the recovery guard');
  const recovery = await loadManualRecovery(stateDir, metadata.name);
  assert.equal(recovery?.reason, 'operation-may-be-active');
  assert.deepEqual(recovery?.containerIds, [containerId]);
  assert.equal(recovery?.worktree, metadata.worktree);
});

test('execWorkspace rejects unsupported Dev Container fields while parsing JSONC comments and strings safely', async () => {
  for (const field of ['dockerComposeFile', 'workspaceMount', 'workspaceFolder']) {
    const runner: ProcessRunner = { async run() { throw new Error('runner must not run'); } };
    const config = `// a comment containing ${field}\n{ "name": "literal // not a comment", /* block comment */ "${field}": "value" }`;
    await assert.rejects(
      () => execWorkspace(metadata, ['true'], runner, async () => undefined, async () => config),
      new RegExp(`Agent Containers v0\\.1 does not support Dev Container ${field}`),
    );
  }
});

test('execWorkspace accepts standards-compatible JSONC comments, strings, and trailing commas', async () => {
  const calls: string[][] = [];
  const runner: ProcessRunner = {
    async run(_command, args) {
      calls.push(args);
      return args[0] === 'up'
        ? { code: 0, stdout: `{"outcome":"success","containerId":"${containerId}"}\n`, stderr: '' }
        : args[0] === 'inspect' ? { code: 0, stdout: ownedInspection(containerId), stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    },
  };
  const config = `{
    // line comment
    "name": "literal // and /* comment markers */",
    "image": "example",
    /* block comment */
  }`;
  await execWorkspace(metadata, ['true'], runner, async () => undefined, async () => config, undefined, noOpRecovery, noOpRecovery);
  assert.equal(calls.length, 3);
});

test('execWorkspace rejects a Dev Container config symlink that escapes its worktree before dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-containers-config-escape-'));
  const worktree = join(root, 'worktree');
  const outside = join(root, 'outside');
  const configPath = join(worktree, '.devcontainer', 'devcontainer.json');
  await mkdir(join(worktree, '.devcontainer'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, 'devcontainer.json'), '{}');
  await symlink(join(outside, 'devcontainer.json'), configPath);

  let dispatches = 0;
  const runner: ProcessRunner = {
    async run() {
      dispatches += 1;
      throw new Error('Dev Containers must not run for an escaping config');
    },
  };

  await assert.rejects(
    () => execWorkspace({ ...metadata, worktree }, ['true'], runner, async () => undefined, undefined, undefined, noOpRecovery, noOpRecovery),
    /Dev Container configuration.*outside.*worktree/i,
  );
  assert.equal(dispatches, 0, 'the escaping config is rejected before Dev Containers dispatch');
});

test('execWorkspace retains a new container when its Docker ownership inspection cannot verify the worktree', async () => {
  const id = untrackedContainerId;
  for (const inspection of [
    { code: 0, stdout: `${id}\n/different/worktree\n`, stderr: '' },
    { code: 0, stdout: `${containerId}\n${metadata.worktree}\n`, stderr: '' },
    { code: 1, stdout: '', stderr: 'inspect denied' },
  ]) {
    const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-unowned-rollback-'));
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: ProcessRunner = {
      async run(command, args) {
        calls.push({ command, args });
        if (command === 'devcontainer') return { code: 0, stdout: `{"outcome":"success","containerId":"${id}"}\n`, stderr: '' };
        if (args[0] === 'inspect') return inspection;
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      },
    };

    await assert.rejects(
      () => execWorkspace(metadata, ['true'], runner, async () => { throw new Error('state disk full'); }, async () => '{}', undefined, (recovery) => recordManualRecovery(stateDir, metadata.name, recovery), noOpRecovery),
      /manual recovery/,
    );
    assert.equal((await loadManualRecovery(stateDir, metadata.name))?.reason, 'devcontainer-up-ambiguous');
    assert.equal(calls.some((call) => call.command === 'docker' && call.args[0] === 'rm'), false);
  }
});

test('execWorkspace preserves a returned reused ID when metadata persistence fails and records durable recovery', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-save-failure-recovery-'));
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: ProcessRunner = {
    async run(command, args) {
      calls.push({ command, args });
      if (args[0] === 'up') return { code: 0, stdout: `{"outcome":"success","containerId":"${untrackedContainerId}"}\n`, stderr: '' };
      if (args[0] === 'inspect') return { code: 0, stdout: ownedInspection(untrackedContainerId), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  await assert.rejects(
    () => execWorkspace(metadata, ['true'], runner, async () => { throw new Error('state disk full'); }, async () => '{}', undefined, (recovery) => recordManualRecovery(stateDir, metadata.name, recovery), noOpRecovery),
    new RegExp(`state disk full.*preserved container ${untrackedContainerId}`, 's'),
  );
  assert.equal(calls.some((call) => call.command === 'docker' && call.args[0] === 'rm'), false);
  assert.equal((await loadManualRecovery(stateDir, metadata.name))?.containerIds[0], untrackedContainerId);
});

test('execWorkspace never replaces a recorded canonical container ID with a distinct exact-label terminal ID', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const recoveries: unknown[] = [];
  let saves = 0;
  const runner: ProcessRunner = {
    async run(command, args) {
      calls.push({ command, args });
      if (args[0] === 'up') return { code: 0, stdout: `{"outcome":"success","containerId":"${untrackedContainerId}"}\n`, stderr: '' };
      if (args[0] === 'inspect') return { code: 0, stdout: ownedInspection(untrackedContainerId), stderr: '' };
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
  };

  await assert.rejects(
    () => execWorkspace({ ...metadata, containerId: knownContainerId }, ['true'], runner, async () => { saves += 1; }, async () => '{}', undefined, async (recovery) => { recoveries.push(recovery); }, noOpRecovery),
    new RegExp(`recorded container.*${knownContainerId}.*returned.*${untrackedContainerId}.*manual recovery`, 'i'),
  );
  assert.equal(saves, 0, 'a label match never authorizes replacing a recorded canonical ID');
  assert.deepEqual(recoveries.at(-1), { reason: 'devcontainer-up-ambiguous', containerIds: [knownContainerId, untrackedContainerId], worktree: metadata.worktree });
  assert.equal(calls.some((call) => call.command === 'docker' && call.args[0] === 'rm'), false, 'neither resource is deleted');
});

test('execWorkspace adopts an exact inspected terminal ID only when no ID was previously recorded', async () => {
  let saved: LocalMetadata | undefined;
  const runner: ProcessRunner = {
    async run(_command, args) {
      return args[0] === 'up'
        ? { code: 0, stdout: `{"outcome":"success","containerId":"${untrackedContainerId}"}\n`, stderr: '' }
        : args[0] === 'inspect' ? { code: 0, stdout: ownedInspection(untrackedContainerId), stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    },
  };

  await execWorkspace(metadata, ['true'], runner, async (next) => { saved = next; }, async () => '{}', undefined, noOpRecovery, noOpRecovery);
  assert.equal(saved?.containerId, untrackedContainerId);
});

test('execWorkspace records recovery instead of adopting a terminal ID whose Docker ID or worktree label differs', async () => {
  for (const inspection of [
    `${containerId}\n${metadata.worktree}\n`,
    `${untrackedContainerId}\n/different/worktree\n`,
  ]) {
    let saves = 0;
    let recovery: unknown;
    const runner: ProcessRunner = {
      async run(_command, args) {
        return args[0] === 'up'
          ? { code: 0, stdout: `{"outcome":"success","containerId":"${untrackedContainerId}"}\n`, stderr: '' }
          : args[0] === 'inspect' ? { code: 0, stdout: inspection, stderr: '' }
          : { code: 0, stdout: '', stderr: '' };
      },
    };

    await assert.rejects(
      () => execWorkspace(metadata, ['true'], runner, async () => { saves += 1; }, async () => '{}', undefined, async (next) => { recovery = next; }, noOpRecovery),
      /manual recovery/,
    );
    assert.equal(saves, 0);
    assert.deepEqual(recovery, { reason: 'devcontainer-up-ambiguous', containerIds: [untrackedContainerId], worktree: metadata.worktree });
  }
});

test('execWorkspace preserves the original metadata record when an initial terminal-ID save fails', async () => {
  const persisted: WorkspaceMetadata = { ...metadata };
  let recovery: unknown;
  const runner: ProcessRunner = {
    async run(_command, args) {
      return args[0] === 'up'
        ? { code: 0, stdout: `{"outcome":"success","containerId":"${untrackedContainerId}"}\n`, stderr: '' }
        : args[0] === 'inspect' ? { code: 0, stdout: ownedInspection(untrackedContainerId), stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    },
  };

  await assert.rejects(
    () => execWorkspace(persisted, ['true'], runner, async () => { throw new Error('concurrent metadata replacement'); }, async () => '{}', undefined, async (next) => { recovery = next; }, noOpRecovery),
    /concurrent metadata replacement.*manual recovery/i,
  );
  assert.equal(persisted.containerId, undefined, 'a failed atomic replacement leaves the original metadata record intact');
  assert.deepEqual(recovery, { reason: 'devcontainer-up-ambiguous', containerIds: [untrackedContainerId], worktree: metadata.worktree });
});

test('execWorkspace never removes a reused recorded container when persisting it would fail', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: ProcessRunner = {
    async run(command, args) {
      calls.push({ command, args });
      return args[0] === 'up'
        ? { code: 0, stdout: `{"outcome":"success","containerId":"${knownContainerId}"}\n`, stderr: '' }
        : args[0] === 'inspect' ? { code: 0, stdout: ownedInspection(knownContainerId), stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    },
  };
  await execWorkspace({ ...metadata, containerId: knownContainerId }, ['true'], runner, async () => { throw new Error('must not rewrite known container'); }, async () => '{}', undefined, noOpRecovery, noOpRecovery);
  assert.equal(calls.some((call) => call.command === 'docker' && call.args[0] === 'rm'), false);
  assert.equal(calls.filter((call) => call.command === 'devcontainer').length, 2);
});

test('execWorkspace forwards interruption to the local Dev Containers CLI but refuses to claim remote cancellation', async () => {
  const lifecycle = new AbortController();
  let remoteSignal: AbortSignal | undefined;
  const runner: ProcessRunner = {
    async run(_command, args, options) {
      if (args[0] === 'up') return { code: 0, stdout: `{"outcome":"success","containerId":"${containerId}"}\n`, stderr: '' };
      if (args[0] === 'inspect') return { code: 0, stdout: ownedInspection(containerId), stderr: '' };
      if (args[0] !== 'exec') throw new Error(`unexpected command: ${args.join(' ')}`);
      remoteSignal = options?.signal;
      queueMicrotask(() => lifecycle.abort());
      const currentSignal = remoteSignal;
      if (currentSignal) await new Promise<void>((resolve) => currentSignal.addEventListener('abort', () => resolve(), { once: true }));
      return { code: 143, stdout: '', stderr: 'local CLI interrupted' };
    },
  };
  let recovery: unknown;
  await assert.rejects(
    () => (execWorkspace as (...args: unknown[]) => Promise<unknown>)(metadata, ['true'], runner, async () => undefined, async () => '{}', lifecycle.signal, async (next: unknown) => { recovery = next; }),
    /remote command may still be active/,
  );
  assert.deepEqual(recovery, { reason: 'remote-exec-interrupted', containerIds: [containerId], worktree: metadata.worktree });
  assert.equal(remoteSignal, lifecycle.signal, 'interruption is forwarded only to the local Dev Containers CLI');
});

test('a cancelled remote exec records one durable block and prevents a concurrent lifecycle after its local CLI is reaped', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-remote-lock-'));
  const lifecycle = new AbortController();
  let remoteStarted!: () => void;
  const remoteIsRunning = new Promise<void>((resolve) => { remoteStarted = resolve; });
  let finishRemote!: () => void;
  const remoteMayFinish = new Promise<void>((resolve) => { finishRemote = resolve; });
  let recoveryWrites = 0;
  const runner: ProcessRunner = {
    async run(_command, args, options) {
      if (args[0] === 'up') return { code: 0, stdout: `{"outcome":"success","containerId":"${containerId}"}\n`, stderr: '' };
      if (args[0] === 'inspect') return { code: 0, stdout: ownedInspection(containerId), stderr: '' };
      if (args[0] !== 'exec') throw new Error(`unexpected command: ${args.join(' ')}`);
      remoteStarted();
      options?.signal?.addEventListener('abort', finishRemote, { once: true });
      await remoteMayFinish;
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  const executing = withWorkspaceLock(
    stateDir,
    'safe-name',
    (signal) => execWorkspace(metadata, ['true'], runner, async () => undefined, async () => '{}', signal, async (recovery) => { recoveryWrites += 1; await recordManualRecovery(stateDir, metadata.name, recovery); }),
    { abortSignal: lifecycle.signal },
  );
  const observedExecution = executing.catch((error: unknown) => error);
  await remoteIsRunning;
  lifecycle.abort();
  lifecycle.abort();
  let removalRan = false;
  const remove = withWorkspaceLock(stateDir, 'safe-name', async () => { removalRan = true; });
  const observedRemove = remove.catch((error: unknown) => error);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(removalRan, false, 'a concurrent remove cannot proceed while the local CLI has not exited');
  finishRemote();
  await assert.rejects(() => executing, /remote command may still be active/);
  assert.match(String(await observedRemove), /manual recovery/);
  assert.equal(recoveryWrites, 3, 'the pre-dispatch guard is promoted with the observed ID, then retained when the local remote-exec transport is interrupted');
  assert.ok(await observedExecution);
  await clearManualRecovery(stateDir, 'safe-name');
  await withWorkspaceLock(stateDir, 'safe-name', async () => { removalRan = true; });
  assert.equal(removalRan, true);
});
