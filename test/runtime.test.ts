import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execWorkspace, type ProcessRunner } from '../src/runtime.js';
import { clearManualRecovery, recordManualRecovery, withWorkspaceLock, type WorkspaceMetadata } from '../src/state.js';

const metadata: WorkspaceMetadata = {
  version: 1,
  name: 'safe-name',
  repoRoot: '/repo',
  worktree: '/repo/worktrees/safe-name',
  branch: 'agent-containers/safe-name',
  baseRef: 'refs/heads/main',
  devcontainerPath: '.devcontainer/devcontainer.json',
  createdAt: '2026-01-01T00:00:00.000Z',
};

test('execWorkspace uses the linked-worktree mount, requires a current container ID, and inherits the terminal for agents', async () => {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
  let saved: WorkspaceMetadata | undefined;
  const runner: ProcessRunner = {
    async run(command, args, options) {
      calls.push({ command, args, options });
      if (args[0] === 'up') return { code: 0, stdout: '[info] started\n{"outcome":"success","containerId":"container-1"}\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };

  await execWorkspace(metadata, ['sh', '-lc', 'printf "$HOME;$(whoami)"'], runner, async (next) => { saved = next; }, async () => '{}');
  assert.deepEqual(calls, [
    { command: 'devcontainer', args: ['up', '--workspace-folder', '/repo/worktrees/safe-name', '--config', '/repo/worktrees/safe-name/.devcontainer/devcontainer.json', '--log-format', 'json', '--mount-git-worktree-common-dir'], options: undefined },
    { command: 'devcontainer', args: ['exec', '--workspace-folder', '/repo/worktrees/safe-name', '--config', '/repo/worktrees/safe-name/.devcontainer/devcontainer.json', '--container-id', 'container-1', 'sh', '-lc', 'printf "$HOME;$(whoami)"'], options: { stdio: 'inherit' } },
  ]);
  assert.equal(saved?.containerId, 'container-1');
});

test('execWorkspace refuses successful up output without a terminal container ID', async () => {
  const runner: ProcessRunner = { async run() { return { code: 0, stdout: '{"outcome":"success"}\n', stderr: '' }; } };
  await assert.rejects(() => execWorkspace(metadata, ['true'], runner, async () => undefined, async () => '{}'), /containerId/);
});

test('execWorkspace reconciles an interrupted up through an exact worktree label and then blocks for manual recovery', async () => {
  const lifecycle = new AbortController();
  const calls: Array<{ command: string; args: string[]; signal?: AbortSignal }> = [];
  let saved: WorkspaceMetadata | undefined;
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
      if (args[0] === 'inspect') return { code: 0, stdout: metadata.worktree, stderr: '' };
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
  };
  await assert.rejects(
    () => (execWorkspace as (...args: unknown[]) => Promise<unknown>)(metadata, ['true'], runner, async (next: WorkspaceMetadata) => { saved = next; }, async () => '{}', lifecycle.signal, async (next: unknown) => { recovery = next; }),
    /manual recovery/,
  );
  assert.equal(saved?.containerId, discoveredId);
  assert.deepEqual(recovery, { reason: 'devcontainer-up-ambiguous', containerIds: [discoveredId], worktree: metadata.worktree });
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
  const runner: ProcessRunner = { async run() { return { code: 0, stdout: '{"containerId":"stale"}\n{"outcome":"success"}\n', stderr: '' }; } };
  await assert.rejects(() => execWorkspace(metadata, ['true'], runner, async () => undefined, async () => '{}'), /containerId/);
});

test('execWorkspace preserves a remote command exit code', async () => {
  const runner: ProcessRunner = {
    async run(_command, args) {
      return args[0] === 'up'
        ? { code: 0, stdout: '{"containerId":"container-1"}\n', stderr: '' }
        : { code: 42, stdout: '', stderr: 'remote command failed' };
    },
  };
  await assert.rejects(() => execWorkspace(metadata, ['false'], runner, async () => undefined, async () => '{}'), (error: unknown) => {
    assert.equal((error as { exitCode?: number }).exitCode, 42);
    return true;
  });
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
        ? { code: 0, stdout: '{"containerId":"container-1"}\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    },
  };
  const config = `{
    // line comment
    "name": "literal // and /* comment markers */",
    "image": "example",
    /* block comment */
  }`;
  await execWorkspace(metadata, ['true'], runner, async () => undefined, async () => config);
  assert.equal(calls.length, 2);
});

test('execWorkspace removes exactly the untracked container when saving its ID fails', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: ProcessRunner = {
    async run(command, args) {
      calls.push({ command, args });
      return args[0] === 'up'
        ? { code: 0, stdout: '{"containerId":"new-container"}\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    },
  };
  await assert.rejects(
    () => execWorkspace(metadata, ['true'], runner, async () => { throw new Error('state disk full'); }, async () => '{}'),
    /state disk full.*removed untracked container new-container/s,
  );
  assert.deepEqual(calls.at(-1), { command: 'docker', args: ['rm', '-f', 'new-container'] });
});

test('execWorkspace never removes a reused recorded container when persisting it would fail', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: ProcessRunner = {
    async run(command, args) {
      calls.push({ command, args });
      return args[0] === 'up'
        ? { code: 0, stdout: '{"containerId":"existing-container"}\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    },
  };
  await execWorkspace({ ...metadata, containerId: 'existing-container' }, ['true'], runner, async () => { throw new Error('must not rewrite known container'); }, async () => '{}');
  assert.equal(calls.some((call) => call.command === 'docker' && call.args[0] === 'rm'), false);
  assert.equal(calls.filter((call) => call.command === 'devcontainer').length, 2);
});

test('execWorkspace cleanup uses a fresh bounded signal after the lifecycle signal is aborted', async () => {
  const lifecycle = new AbortController();
  let cleanupSignal: AbortSignal | undefined;
  const runner: ProcessRunner = {
    async run(_command, args, options) {
      if (args[0] === 'up') return { code: 0, stdout: '{"containerId":"new-container"}\n', stderr: '' };
      cleanupSignal = options?.signal;
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  await assert.rejects(
    () => execWorkspace(metadata, ['true'], runner, async () => { lifecycle.abort(); throw new Error('state disk full'); }, async () => '{}', lifecycle.signal),
    /removed untracked container new-container/,
  );
  assert.ok(cleanupSignal, 'cleanup receives its own bounded signal');
  assert.notEqual(cleanupSignal, lifecycle.signal);
  assert.equal(cleanupSignal.aborted, false);
});

test('execWorkspace forwards interruption to the local Dev Containers CLI but refuses to claim remote cancellation', async () => {
  const lifecycle = new AbortController();
  let remoteSignal: AbortSignal | undefined;
  const runner: ProcessRunner = {
    async run(_command, args, options) {
      if (args[0] === 'up') return { code: 0, stdout: '{"containerId":"container-1"}\n', stderr: '' };
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
  assert.deepEqual(recovery, { reason: 'remote-exec-interrupted', containerIds: ['container-1'], worktree: metadata.worktree });
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
      if (args[0] === 'up') return { code: 0, stdout: '{"containerId":"container-1"}\n', stderr: '' };
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
  assert.equal(recoveryWrites, 1, 'repeated interruption does not create a second recovery record');
  assert.ok(await observedExecution);
  await clearManualRecovery(stateDir, 'safe-name');
  await withWorkspaceLock(stateDir, 'safe-name', async () => { removalRan = true; });
  assert.equal(removalRan, true);
});

test('execWorkspace reports both metadata and exact container cleanup failures', async () => {
  const runner: ProcessRunner = {
    async run(_command, args) {
      return args[0] === 'up'
        ? { code: 0, stdout: '{"containerId":"new-container"}\n', stderr: '' }
        : { code: 1, stdout: '', stderr: 'permission denied' };
    },
  };
  await assert.rejects(
    () => execWorkspace(metadata, ['true'], runner, async () => { throw new Error('state disk full'); }, async () => '{}'),
    /state disk full.*could not remove untracked container new-container: permission denied/s,
  );
});

test('execWorkspace preserves recovery context when exact container cleanup throws', async () => {
  const runner: ProcessRunner = {
    async run(_command, args) {
      if (args[0] === 'up') return { code: 0, stdout: '{"containerId":"new-container"}\n', stderr: '' };
      throw new Error('docker executable missing');
    },
  };
  await assert.rejects(
    () => execWorkspace(metadata, ['true'], runner, async () => { throw new Error('state disk full'); }, async () => '{}'),
    /state disk full.*could not remove untracked container new-container: docker executable missing/s,
  );
});
