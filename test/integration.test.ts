import assert from 'node:assert/strict';
import { access, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createNodeProcessRunner, createWorkspace, nodeProcessRunner, PROCESS_OUTPUT_LIMIT, UnconfirmedProcessReapError } from '../src/workspaces.js';
import { execWorkspaceLifecycle } from '../src/runtime.js';
import type { LocalMetadata } from '../src/state.js';
import { isLiveIntegrationEnabled, probeLiveIntegrationPrerequisites } from '../src/live-integration.js';
import { loadMetadata, saveMetadata } from '../src/state.js';

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
  git('config', 'core.autocrlf', 'false');
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

test('nodeProcessRunner rejects a Windows lifecycle cancellation when taskkill errors even after the root closes', async () => {
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
    if (!command.endsWith('taskkill.exe')) return managedChild;
    const killer = new EventEmitter();
    killers.push(killer);
    return killer as ChildProcess;
  }) as typeof spawn;
  const controller = new AbortController();
  const runner = createNodeProcessRunner({ platform: 'win32', spawn: spawnForTest, windowsReapTimeoutMs: 0, windowsDirectory: () => 'C:\\Windows' });
  let settled = false;
  const running = runner.run('managed-command', [], { kind: 'lifecycle', signal: controller.signal }).then((result) => { settled = true; return result; }, (error: unknown) => { settled = true; return error; });

  controller.abort();
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.deepEqual(calls, [
    { command: 'managed-command', args: [], options: { cwd: undefined, shell: false, stdio: 'pipe', detached: false } },
    { command: 'C:\\Windows\\System32\\taskkill.exe', args: ['/PID', '4321', '/T', '/F'], options: { shell: false, stdio: 'ignore', windowsHide: true } },
  ]);
  killers[0]?.emit('error', new Error('taskkill could not start'));
  await new Promise((resolveTick) => setImmediate(resolveTick));
  try {
    assert.deepEqual(rootKillSignals, ['SIGKILL'], 'a taskkill error gets one direct root fallback without a shell');
  } finally {
    managedChild.emit('close', 1);
  }

  assert.ok(await running instanceof UnconfirmedProcessReapError);
  assert.equal(settled, true);
});

test('nodeProcessRunner rejects through Windows reaping recovery when taskkill and the managed child never close', async () => {
  const rootKillSignals: NodeJS.Signals[] = [];
  const managedChild = Object.assign(new EventEmitter(), {
    pid: 8765,
    kill: (signal: NodeJS.Signals) => { rootKillSignals.push(signal); return true; },
  }) as unknown as ChildProcess;
  const spawnForTest = ((command: string) => command.endsWith('System32\\taskkill.exe')
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
  assert.match(failure?.message ?? '', /Windows process-tree reaping could not be confirmed/);
  assert.deepEqual(rootKillSignals, ['SIGKILL'], 'the timed-out recovery makes one shell-free root termination attempt');
});

test('nodeProcessRunner drives the bounded Windows failure path through its injected reaping timer', async () => {
  const managedChild = Object.assign(new EventEmitter(), { pid: 9753, kill: () => true }) as unknown as ChildProcess;
  const timerCallbacks: Array<() => void> = [];
  const runner = createNodeProcessRunner({
    platform: 'win32',
      windowsDirectory: () => 'C:\\Windows',
      spawn: ((command: string) => command.endsWith('System32\\taskkill.exe') ? new EventEmitter() as ChildProcess : managedChild) as typeof spawn,
    setTimeout: ((callback: () => void) => { timerCallbacks.push(callback); return {} as NodeJS.Timeout; }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
  });
  const controller = new AbortController();
  const running = runner.run('managed-command', [], { kind: 'lifecycle', signal: controller.signal });
  controller.abort();
  assert.equal(timerCallbacks.length, 1);
  timerCallbacks[0]();
  await assert.rejects(running, UnconfirmedProcessReapError);
});

test('nodeProcessRunner keeps the Windows reaper deadline when the root closes before taskkill', async () => {
  const rootKillSignals: NodeJS.Signals[] = [];
  const reaperKillSignals: NodeJS.Signals[] = [];
  const root = Object.assign(new EventEmitter(), {
    pid: 9754,
    kill: (signal: NodeJS.Signals) => { rootKillSignals.push(signal); return true; },
  }) as unknown as ChildProcess;
  const taskkill = Object.assign(new EventEmitter(), {
    kill: (signal: NodeJS.Signals) => { reaperKillSignals.push(signal); return true; },
  }) as unknown as ChildProcess;
  const timers: Array<() => void> = [];
  const runner = createNodeProcessRunner({
    platform: 'win32',
    windowsDirectory: () => 'C:\\Windows',
    spawn: ((command: string) => command.endsWith('taskkill.exe') ? taskkill : root) as typeof spawn,
    setTimeout: ((callback: () => void) => { timers.push(callback); return {} as NodeJS.Timeout; }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
  });
  const controller = new AbortController();
  const running = runner.run('managed-command', [], { kind: 'lifecycle', signal: controller.signal });
  controller.abort();
  root.emit('close', 1);

  assert.equal(timers.length, 1, 'root close must not cancel the deadline while taskkill remains live');
  timers[0]?.();
  await assert.rejects(running, UnconfirmedProcessReapError);
  assert.deepEqual(reaperKillSignals, ['SIGKILL']);
  assert.deepEqual(rootKillSignals, ['SIGKILL']);
});

test('nodeProcessRunner ignores custom and UNC SystemRoot values without an authoritative Windows directory', async () => {
  const originalSystemRoot = process.env.SystemRoot;
  try {
    for (const systemRoot of ['C:\\attacker-controlled', '\\\\attacker\\share\\Windows']) {
      const calls: string[] = [];
      const rootKillSignals: NodeJS.Signals[] = [];
      const root = Object.assign(new EventEmitter(), {
        pid: 9755,
        kill: (signal: NodeJS.Signals) => { rootKillSignals.push(signal); return true; },
      }) as unknown as ChildProcess;
      const timers: Array<() => void> = [];
      process.env.SystemRoot = systemRoot;
      const runner = createNodeProcessRunner({
        platform: 'win32',
        windowsDirectory: () => undefined,
        spawn: ((command: string) => { calls.push(command); return root; }) as typeof spawn,
        setTimeout: ((callback: () => void) => { timers.push(callback); return {} as NodeJS.Timeout; }) as typeof setTimeout,
        clearTimeout: (() => undefined) as typeof clearTimeout,
      });
      const controller = new AbortController();
      const running = runner.run('managed-command', [], { kind: 'lifecycle', signal: controller.signal });
      controller.abort();

      assert.deepEqual(calls, ['managed-command']);
      assert.deepEqual(rootKillSignals, ['SIGKILL']);
      timers[0]?.();
      await assert.rejects(running, UnconfirmedProcessReapError);
    }
  } finally {
    if (originalSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalSystemRoot;
  }
});

test('nodeProcessRunner turns Windows post-cancellation fallback failures into lifecycle recovery errors', async () => {
  for (const scenario of ['taskkill-nonzero', 'taskkill-sync-throw', 'child-error', 'no-pid', 'deadline-fallback-throw'] as const) {
    const root = Object.assign(new EventEmitter(), {
      pid: scenario === 'no-pid' ? undefined : 1357,
      kill: () => { throw new Error('root termination failed'); },
    }) as unknown as ChildProcess;
    const taskkill = new EventEmitter() as ChildProcess;
    const timers: Array<() => void> = [];
    const runner = createNodeProcessRunner({
      platform: 'win32',
      spawn: ((command: string) => {
        if (!command.endsWith('System32\\taskkill.exe')) return root;
        if (scenario === 'taskkill-sync-throw') throw new Error('taskkill spawn failed');
        return taskkill;
      }) as typeof spawn,
      setTimeout: ((callback: () => void) => { timers.push(callback); return {} as NodeJS.Timeout; }) as typeof setTimeout,
      clearTimeout: (() => undefined) as typeof clearTimeout,
    });
    const controller = new AbortController();
    const running = runner.run('managed-command', [], { kind: 'lifecycle', signal: controller.signal });
    controller.abort();
    if (scenario === 'taskkill-nonzero') taskkill.emit('close', 1);
    if (scenario === 'child-error') root.emit('error', new Error('managed child failed'));
    if (scenario === 'deadline-fallback-throw') timers[0]?.();
    await assert.rejects(running, UnconfirmedProcessReapError, scenario);
  }
});

test('nodeProcessRunner records an unconfirmed reap when a cancelled POSIX group disappears because descendants can escape it', async () => {
  const managedChild = Object.assign(new EventEmitter(), {
    pid: 2468,
    kill: () => true,
  }) as unknown as ChildProcess;
  const signals: NodeJS.Signals[] = [];
  let groupGone = false;
  const processKill = ((pid: number, signal?: NodeJS.Signals | 0) => {
    if (pid !== -2468) throw new Error(`unexpected PID ${pid}`);
    if (signal === 0 && !groupGone) return true;
    if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    signals.push(signal as NodeJS.Signals);
    if (signal === 'SIGKILL') groupGone = true;
    return true;
  }) as typeof process.kill;
  const runner = createNodeProcessRunner({
    platform: 'linux',
    spawn: (() => managedChild) as typeof spawn,
    processKill,
    posixGraceMs: 0,
    posixVerificationTimeoutMs: 50,
  } as never);
  const controller = new AbortController();
  const running = runner.run('managed-command', [], { kind: 'lifecycle', signal: controller.signal });
  const rejected = assert.rejects(running, UnconfirmedProcessReapError);

  controller.abort();
  managedChild.emit('close', 1);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  assert.deepEqual(signals, ['SIGTERM'], 'a closed root prevents a delayed SIGKILL against a potentially recycled PGID');
  await rejected;
});

test('nodeProcessRunner stops cancellation targeting after the root exits but before stdio closes', async () => {
  const root = Object.assign(new EventEmitter(), { pid: 2472, kill: () => true }) as unknown as ChildProcess;
  const processKillCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
  const runner = createNodeProcessRunner({
    platform: 'linux',
    spawn: (() => root) as typeof spawn,
    processKill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      processKillCalls.push({ pid, signal });
      return true;
    }) as typeof process.kill,
  });
  const controller = new AbortController();
  const running = runner.run('managed-command', [], { signal: controller.signal });

  root.emit('exit', 0);
  controller.abort();
  assert.deepEqual(processKillCalls, [], 'an exited root PID must never be reused as a process-group cancellation target');
  root.emit('close', 0);
  assert.equal((await running).code, 0, 'the runner still waits for stdio close');

  const windowsRoot = Object.assign(new EventEmitter(), { pid: 2473, kill: () => true }) as unknown as ChildProcess;
  const windowsCommands: string[] = [];
  const windowsRunner = createNodeProcessRunner({
    platform: 'win32',
    spawn: ((command: string) => {
      windowsCommands.push(command);
      return windowsRoot;
    }) as typeof spawn,
    windowsDirectory: () => 'C:\\Windows',
  });
  const windowsController = new AbortController();
  const windowsRunning = windowsRunner.run('managed-command', [], { signal: windowsController.signal });

  windowsRoot.emit('exit', 0);
  windowsController.abort();
  assert.deepEqual(windowsCommands, ['managed-command'], 'an exited root PID must never be passed to taskkill');
  windowsRoot.emit('close', 0);
  assert.equal((await windowsRunning).code, 0, 'the Windows runner still waits for stdio close');
});

test('nodeProcessRunner bounds lifecycle cancellation after root exit when inherited streams never close', async () => {
  const posixRoot = Object.assign(new EventEmitter(), { pid: 2474, kill: () => true }) as unknown as ChildProcess;
  const posixTimers: Array<() => void> = [];
  const posixTargets: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
  const posixRunner = createNodeProcessRunner({
    platform: 'linux',
    spawn: (() => posixRoot) as typeof spawn,
    processKill: ((pid: number, signal?: NodeJS.Signals | 0) => { posixTargets.push({ pid, signal }); return true; }) as typeof process.kill,
    setTimeout: ((callback: () => void) => { posixTimers.push(callback); return {} as NodeJS.Timeout; }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
  });
  const posixController = new AbortController();
  const posixRunning = posixRunner.run('managed-command', [], { kind: 'lifecycle', signal: posixController.signal });
  posixRoot.emit('exit', 0);
  posixController.abort();

  assert.equal(posixTimers.length, 1, 'post-exit cancellation schedules a bounded uncertainty deadline');
  assert.deepEqual(posixTargets, [], 'an exited root PID is never reused as a POSIX process-group target');
  posixTimers[0]?.();
  await assert.rejects(posixRunning, UnconfirmedProcessReapError);

  const windowsRoot = Object.assign(new EventEmitter(), { pid: 2475, kill: () => true }) as unknown as ChildProcess;
  const windowsTimers: Array<() => void> = [];
  const windowsCommands: string[] = [];
  const windowsRunner = createNodeProcessRunner({
    platform: 'win32',
    spawn: ((command: string) => { windowsCommands.push(command); return windowsRoot; }) as typeof spawn,
    windowsDirectory: () => 'C:\\Windows',
    setTimeout: ((callback: () => void) => { windowsTimers.push(callback); return {} as NodeJS.Timeout; }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
  });
  const windowsController = new AbortController();
  const windowsRunning = windowsRunner.run('managed-command', [], { kind: 'lifecycle', signal: windowsController.signal });
  windowsRoot.emit('exit', 0);
  windowsController.abort();

  assert.equal(windowsTimers.length, 1, 'post-exit cancellation schedules a bounded uncertainty deadline');
  assert.deepEqual(windowsCommands, ['managed-command'], 'an exited root PID is never passed to taskkill');
  windowsTimers[0]?.();
  await assert.rejects(windowsRunning, UnconfirmedProcessReapError);
});

test('nodeProcessRunner retains POSIX escalation after root close when a descendant may remain', async () => {
  const root = Object.assign(new EventEmitter(), { pid: 2469, kill: () => true }) as unknown as ChildProcess;
  const signals: NodeJS.Signals[] = [];
  const timers: Array<() => void> = [];
  const runner = createNodeProcessRunner({
    platform: 'linux',
    spawn: (() => root) as typeof spawn,
    processKill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      assert.equal(pid, -2469);
      if (signal !== 0) signals.push(signal as NodeJS.Signals);
      return true;
    }) as typeof process.kill,
    posixGraceMs: 10,
    posixVerificationTimeoutMs: 10,
    setTimeout: ((callback: () => void) => { timers.push(callback); return {} as NodeJS.Timeout; }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
  });
  const controller = new AbortController();
  const running = runner.run('managed-command', [], { kind: 'lifecycle', signal: controller.signal });

  controller.abort();
  root.emit('close', 1);
  assert.deepEqual(signals, ['SIGTERM']);
  timers[1]?.();
  assert.deepEqual(signals, ['SIGTERM']);
  timers[0]?.();
  await assert.rejects(running, UnconfirmedProcessReapError);
});

test('nodeProcessRunner never treats Windows taskkill success and root close as escaped-descendant proof', async () => {
  const root = Object.assign(new EventEmitter(), { pid: 2468, kill: () => true }) as unknown as ChildProcess;
  const taskkill = new EventEmitter() as ChildProcess;
  const calls: string[] = [];
  const runner = createNodeProcessRunner({
    platform: 'win32',
    windowsDirectory: () => 'C:\\Windows',
    spawn: ((command: string) => {
      calls.push(command);
      return command.endsWith('taskkill.exe') ? taskkill : root;
    }) as typeof spawn,
  });
  const controller = new AbortController();
  const running = runner.run('managed-command', [], { kind: 'lifecycle', signal: controller.signal });
  controller.abort();
  taskkill.emit('close', 0);
  root.emit('close', 1);
  await assert.rejects(running, UnconfirmedProcessReapError);
  assert.deepEqual(calls, ['managed-command', 'C:\\Windows\\System32\\taskkill.exe']);
});

test('nodeProcessRunner waits for Windows root close after successful taskkill and bounds a missing close', async () => {
  const root = Object.assign(new EventEmitter(), { pid: 2470, kill: () => true }) as unknown as ChildProcess;
  const taskkill = new EventEmitter() as ChildProcess;
  const timers: Array<() => void> = [];
  const runner = createNodeProcessRunner({
    platform: 'win32',
    windowsDirectory: () => 'C:\\Windows',
    spawn: ((command: string) => command.endsWith('taskkill.exe') ? taskkill : root) as typeof spawn,
    setTimeout: ((callback: () => void) => { timers.push(callback); return {} as NodeJS.Timeout; }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
  });
  const controller = new AbortController();
  const running = runner.run('managed-command', [], { kind: 'lifecycle', signal: controller.signal });

  controller.abort();
  taskkill.emit('close', 0);
  let settled = false;
  void running.catch(() => { settled = true; });
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.equal(settled, false, 'taskkill success alone cannot release the lifecycle lock');
  root.emit('close', 1);
  await assert.rejects(running, UnconfirmedProcessReapError);

  const noCloseRoot = Object.assign(new EventEmitter(), { pid: 2471, kill: () => true }) as unknown as ChildProcess;
  const noCloseTaskkill = new EventEmitter() as ChildProcess;
  const noCloseTimers: Array<() => void> = [];
  const noClose = createNodeProcessRunner({
    platform: 'win32',
    windowsDirectory: () => 'C:\\Windows',
    spawn: ((command: string) => command.endsWith('taskkill.exe') ? noCloseTaskkill : noCloseRoot) as typeof spawn,
    setTimeout: ((callback: () => void) => { noCloseTimers.push(callback); return {} as NodeJS.Timeout; }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
  });
  const noCloseController = new AbortController();
  const noCloseRunning = noClose.run('managed-command', [], { kind: 'lifecycle', signal: noCloseController.signal });
  noCloseController.abort();
  noCloseTaskkill.emit('close', 0);
  noCloseTimers[0]?.();
  await assert.rejects(noCloseRunning, UnconfirmedProcessReapError);
});

test('nodeProcessRunner returns an unconfirmed lifecycle failure when POSIX process-group death cannot be proven', async () => {
  const managedChild = Object.assign(new EventEmitter(), { pid: 1357, kill: () => true }) as unknown as ChildProcess;
  const processKill = (() => true) as typeof process.kill;
  const runner = createNodeProcessRunner({
    platform: 'linux',
    spawn: (() => managedChild) as typeof spawn,
    processKill,
    posixGraceMs: 0,
    posixVerificationTimeoutMs: 0,
  } as never);
  const controller = new AbortController();
  const running = runner.run('managed-command', [], { kind: 'lifecycle', signal: controller.signal });
  const rejected = assert.rejects(running, UnconfirmedProcessReapError);
  controller.abort();
  managedChild.emit('close', 1);
  await rejected;
});

test('nodeProcessRunner bounds initial POSIX SIGTERM ESRCH when the root never closes', async () => {
  const managedChild = Object.assign(new EventEmitter(), { pid: 8642, kill: () => true }) as unknown as ChildProcess;
  const timers: Array<() => void> = [];
  const processKill = (() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }) as typeof process.kill;
  const runner = createNodeProcessRunner({
    platform: 'linux',
    spawn: (() => managedChild) as typeof spawn,
    processKill,
    setTimeout: ((callback: () => void) => { timers.push(callback); return {} as NodeJS.Timeout; }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
  });
  const controller = new AbortController();
  const running = runner.run('managed-command', [], { kind: 'lifecycle', signal: controller.signal });
  controller.abort();
  assert.equal(timers.length, 2, 'the deadline and bounded SIGKILL attempt start even when SIGTERM reports ESRCH');
  timers[0]();
  await assert.rejects(running, UnconfirmedProcessReapError);
});

test('nodeProcessRunner reports bounded readonly cancellation when the POSIX group is gone but escaped descendants remain unknowable', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-containers-process-group-'));
  const marker = join(directory, 'grandchild-survived');
  const controller = new AbortController();
  const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived')`;
  const program = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => ${grandchild}, 250)`)}], { detached: true, stdio: 'ignore' }); child.unref(); setInterval(() => {}, 1000);`;
  try {
    const running = createNodeProcessRunner({ posixGraceMs: 0, posixVerificationTimeoutMs: 0 }).run(process.execPath, ['-e', program], { signal: controller.signal });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    controller.abort();
    await assert.rejects(running, /POSIX process-group reaping could not be confirmed/);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    assert.equal(await readFile(marker, 'utf8'), 'survived');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('POSIX SIGTERM keeps the lifecycle lock until a cancelled child process has exited', { skip: process.platform === 'win32', timeout: 5_000 }, async () => {
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
    await saveMetadata(stateDir, metadata);
    const runCommonDirectoryCheck = () => execWorkspaceLifecycle(metadata, ['sh', '-lc', 'git rev-parse --git-common-dir > .agent-containers-git-common-dir'], nodeProcessRunner, async (next: LocalMetadata) => { containerId = next.containerId; }, stateDir);
    await assert.rejects(runCommonDirectoryCheck, /Initialized the durable manual-recovery journal for workspace "integration"\. No Dev Containers command was dispatched; retry this invocation before remote work can begin\./);
    await runCommonDirectoryCheck();
    containerId = (await loadMetadata(stateDir, metadata.name))?.containerId;
    assert.match(await readFile(join(worktree, '.agent-containers-git-common-dir'), 'utf8'), /worktrees|\.git/);
  } finally {
    if (containerId) spawnSync('docker', ['rm', '-f', containerId]);
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repo });
    await rm(repo, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});
