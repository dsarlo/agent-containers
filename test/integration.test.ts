import assert from 'node:assert/strict';
import { access, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createNodeProcessRunner, createWorkspace, nodeProcessRunner, PROCESS_OUTPUT_LIMIT } from '../src/workspaces.js';
import { execWorkspaceLifecycle } from '../src/runtime.js';
import { isLiveIntegrationEnabled, probeLiveIntegrationPrerequisites } from '../src/live-integration.js';

const requireLiveIntegration = isLiveIntegrationEnabled();
const { gitAvailable, dockerAvailable, devcontainerAvailable, relativeWorktreeSupported } = probeLiveIntegrationPrerequisites(process.env, (command, args) => spawnSync(command, args, { encoding: 'utf8' }));

test('required live integration prerequisites are available', { skip: !requireLiveIntegration }, () => {
  assert.ok(gitAvailable, 'Git is required');
  assert.ok(dockerAvailable, 'Docker is required');
  assert.ok(devcontainerAvailable, 'Dev Containers CLI is required');
  assert.ok(relativeWorktreeSupported, 'Git must support git worktree add --relative-paths');
});

test('create produces an isolated worktree without altering source checkout files', { skip: !gitAvailable ? 'Git is unavailable' : !relativeWorktreeSupported ? 'installed Git does not support git worktree add --relative-paths' : false }, async () => {
  const repo = await mkdtemp(join(tmpdir(), 'agent-containers-git-'));
  const git = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: repo }).status, 0);
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await writeFile(join(repo, 'source.txt'), 'original\n');
  git('add', 'source.txt');
  git('commit', '-m', 'initial');

  const metadata = await createWorkspace({ cwd: repo, name: 'isolated', config: { version: 1, workspace: { worktreeRoot: `${repo}-worktrees`, baseBranch: 'main' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, commands: {} }, stateDir: `${repo}-state`, runner: nodeProcessRunner });
  await access(metadata.worktree);
  assert.equal(await readFile(join(repo, 'source.txt'), 'utf8'), 'original\n');
  assert.equal(await readFile(join(metadata.worktree, 'source.txt'), 'utf8'), 'original\n');
});

test('nodeProcessRunner forwards inherited terminal output without a shell', async () => {
  const result = await nodeProcessRunner.run(process.execPath, ['-e', 'process.stdout.write("agent-containers-terminal-smoke\\n")'], { stdio: 'inherit' });
  assert.equal(result.code, 0);
});

test('nodeProcessRunner bounds burst capture while retaining terminal Dev Containers JSON', async () => {
  const result = await nodeProcessRunner.run(process.execPath, ['-e', `process.stdout.write('x'.repeat(${PROCESS_OUTPUT_LIMIT * 2})); process.stdout.write('\\n{"containerId":"terminal"}\\n')`]);
  assert.ok(result.stdout.length <= PROCESS_OUTPUT_LIMIT);
  assert.match(result.stdout, /\{"containerId":"terminal"\}\n$/);
});

test('nodeProcessRunner emits incrementally decoded UTF-8 pipe output while capture remains bounded', async () => {
  const events: string[] = [];
  const result = await nodeProcessRunner.run(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xf0, 0x9f])); setTimeout(() => process.stdout.write(Buffer.from([0x98, 0x80])), 20)'], {
    onOutput: (event) => events.push(event.text),
  });
  assert.equal(result.code, 0);
  assert.equal(events.join(''), '😀');
  assert.equal(result.stdout, '😀');
});

test('nodeProcessRunner does not invoke an output callback for inherited stdio', async () => {
  let observed = false;
  const result = await nodeProcessRunner.run(process.execPath, ['-e', 'process.stdout.write("inherited-output\\n")'], {
    stdio: 'inherit',
    onOutput: () => { observed = true; },
  });
  assert.equal(result.code, 0);
  assert.equal(observed, false);
});

test('nodeProcessRunner directly reaps the Windows root when taskkill errors without closing, while awaiting the managed child', async () => {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const killers: EventEmitter[] = [];
  const rootKillSignals: NodeJS.Signals[] = [];
  const managedChild = Object.assign(new EventEmitter(), {
    pid: 4321,
    kill: (signal: NodeJS.Signals) => {
      rootKillSignals.push(signal);
      throw Object.assign(new Error('already gone'), { code: 'ESRCH' });
    },
  }) as unknown as ChildProcess;
  const spawnForTest = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args: [...args], options });
    if (command !== 'taskkill') return managedChild;
    const killer = new EventEmitter();
    killers.push(killer);
    return killer as ChildProcess;
  }) as typeof spawn;
  const controller = new AbortController();
  const runner = createNodeProcessRunner({ platform: 'win32', spawn: spawnForTest });
  let settled = false;
  const running = runner.run('managed-command', [], { signal: controller.signal }).then((result) => { settled = true; return result; });

  controller.abort();
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.deepEqual(calls, [
    { command: 'managed-command', args: [], options: { cwd: undefined, shell: false, stdio: 'pipe', detached: false } },
    { command: 'taskkill', args: ['/PID', '4321', '/T', '/F'], options: { shell: false, stdio: 'ignore', windowsHide: true } },
  ]);
  killers[0]?.emit('error', new Error('taskkill could not start'));
  await new Promise((resolveTick) => setImmediate(resolveTick));
  try {
    assert.deepEqual(rootKillSignals, ['SIGKILL'], 'a taskkill error gets one direct root fallback without a shell');
    assert.equal(settled, false, 'the managed child is still awaited after cancellation');
  } finally {
    managedChild.emit('close', 1);
  }

  assert.equal((await running).code, 1);
  assert.equal(settled, true);
});

test('nodeProcessRunner rejects through Windows reaping recovery when taskkill and the managed child never close', async () => {
  const rootKillSignals: NodeJS.Signals[] = [];
  const managedChild = Object.assign(new EventEmitter(), {
    pid: 8765,
    kill: (signal: NodeJS.Signals) => { rootKillSignals.push(signal); return true; },
  }) as unknown as ChildProcess;
  const spawnForTest = ((command: string) => command === 'taskkill'
    ? new EventEmitter() as ChildProcess
    : managedChild) as typeof spawn;
  const controller = new AbortController();
  const runner = createNodeProcessRunner({
    platform: 'win32',
    spawn: spawnForTest,
    windowsReapTimeoutMs: 0,
  });
  let failure: Error | undefined;
  let settled = false;
  void runner.run('managed-command', [], { signal: controller.signal }).then(
    () => { settled = true; },
    (error: unknown) => { failure = error as Error; settled = true; },
  );

  controller.abort();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
  assert.equal(settled, true, 'a Windows child that never closes must enter recovery instead of retaining the lifecycle lock');
  assert.match(failure?.message ?? '', /Windows process reaping timed out/);
  assert.deepEqual(rootKillSignals, ['SIGKILL'], 'the timed-out recovery makes one shell-free root termination attempt');
});

test('nodeProcessRunner abort terminates spawned process-group descendants before settling', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-process-group-'));
  const marker = join(directory, 'grandchild-survived');
  const controller = new AbortController();
  const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived')`;
  const program = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => ${grandchild}, 250)`)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
  const running = nodeProcessRunner.run(process.execPath, ['-e', program], { signal: controller.signal });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  controller.abort();
  await running;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  await assert.rejects(() => lstat(marker), { code: 'ENOENT' });
});

test('SIGTERM keeps the lifecycle lock until a cancelled child process has exited', { timeout: 5_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-containers-signal-lock-'));
  const stateUrl = new URL('../src/state.js', import.meta.url).href;
  const workspacesUrl = new URL('../src/workspaces.js', import.meta.url).href;
  const reapedMarker = join(stateDir, 'child-reaped');
  const childCommand = `const fs = require('node:fs'); process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(reapedMarker)}, 'reaped'); process.exit(0); }, 200)); setTimeout(() => process.exit(0), 900); setInterval(() => {}, 1000);`;
  const childProgram = `
    import { withWorkspaceLock, setStateDurabilityAdapterForTesting } from ${JSON.stringify(stateUrl)};
    import { nodeProcessRunner } from ${JSON.stringify(workspacesUrl)};
    setStateDurabilityAdapterForTesting({
      publicationMode: async () => 'strict',
      assertStateWriteSupport: async () => undefined,
      syncFile: async () => undefined,
      syncDirectory: async () => undefined,
      moveFileWriteThrough: async () => undefined,
    });
    const stateDir = process.argv[1];
    await withWorkspaceLock(stateDir, 'safe', async (signal) => {
      process.stdout.write('LOCKED\\n');
      await nodeProcessRunner.run(process.execPath, ['-e', ${JSON.stringify(childCommand)}], { signal });
    });
  `;
  const lifecycle = spawn(process.execPath, ['--input-type=module', '-e', childProgram, stateDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  await new Promise<void>((resolveReady, rejectReady) => {
    lifecycle.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.includes('LOCKED\n')) resolveReady(); });
    lifecycle.once('error', rejectReady);
    lifecycle.once('exit', (code, signal) => rejectReady(new Error(`lifecycle process exited before locking (${code ?? signal})`)));
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => lifecycle.once('exit', (code, signal) => resolveExit({ code, signal })));
  lifecycle.kill('SIGTERM');
  try {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
    lifecycle.kill('SIGTERM');
    await lstat(join(stateDir, 'locks', 'safe.lock'));
  } finally {
    const result = await exited;
    assert.equal(result.signal, 'SIGTERM');
    assert.equal(await readFile(reapedMarker, 'utf8'), 'reaped');
    await assert.rejects(() => lstat(join(stateDir, 'locks', 'safe.lock')), { code: 'ENOENT' });
  }
});

test('production execWorkspace lifecycle exposes the Git common directory inside a linked worktree', {
  skip: !requireLiveIntegration ? 'AGENT_CONTAINERS_REQUIRE_LIVE_INTEGRATION=1 is required' : !dockerAvailable ? 'Docker is unavailable' : !devcontainerAvailable ? 'Dev Containers CLI is unavailable' : !relativeWorktreeSupported ? 'installed Git does not support git worktree add --relative-paths' : false,
}, async () => {
  const repo = await mkdtemp(join(tmpdir(), 'agent-containers-devcontainer-'));
  const worktree = `${repo}-worktree`;
  const stateDir = `${repo}-state`;
  const git = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: repo }).status, 0);
  let containerId: string | undefined;
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    await writeFile(join(repo, 'source.txt'), 'source\n');
    await writeFile(join(repo, '.devcontainer.json'), JSON.stringify({ image: 'mcr.microsoft.com/devcontainers/base:ubuntu' }));
    git('add', '.');
    git('commit', '-m', 'initial');
    git('worktree', 'add', '--relative-paths', '-b', 'agent-containers/integration', worktree, 'main');
    const metadata = { version: 1 as const, name: 'integration', repoRoot: repo, worktree, branch: 'agent-containers/integration', baseRef: 'refs/heads/main', devcontainerPath: '.devcontainer.json', createdAt: new Date().toISOString() };
    const runCommonDirectoryCheck = () => execWorkspaceLifecycle(metadata, ['sh', '-lc', 'git rev-parse --git-common-dir > .agent-containers-git-common-dir'], nodeProcessRunner, async (next) => { containerId = next.containerId; }, stateDir);
    await assert.rejects(runCommonDirectoryCheck, /Initialized the durable manual-recovery journal for workspace "integration"\. No Dev Containers command was dispatched; retry this invocation before remote work can begin\./);
    await runCommonDirectoryCheck();
    assert.match(await readFile(join(worktree, '.agent-containers-git-common-dir'), 'utf8'), /worktrees|\.git/);
  } finally {
    if (containerId) spawnSync('docker', ['rm', '-f', containerId]);
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repo });
    await rm(repo, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});
