import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { loadManualRecovery, recordManualRecovery, withWorkspaceLock } from '../src/state.js';
import { exitCodeForError, runCli } from '../src/cli.js';

test('CLI parses destructive confirmation options strictly', async () => {
  const messages: string[] = [];
  assert.equal(await runCli(['remove', 'safe'], process.cwd(), (message) => messages.push(message)), 2);
  assert.match(messages.at(-1) ?? '', /--yes/);
  assert.equal(await runCli(['remove', 'safe', '--yes', '--unexpected'], process.cwd(), () => undefined), 2);
  assert.equal(await runCli(['remove', 'safe', '--skip-container-cleanup'], process.cwd(), () => undefined), 2);
});

test('CLI preserves valid remote process exit statuses', () => {
  assert.equal(exitCodeForError({ exitCode: 42 }), 42);
  assert.equal(exitCodeForError({ exitCode: 0 }), undefined);
  assert.equal(exitCodeForError({ exitCode: 256 }), undefined);
});

test('CLI help and errors use the public Agent Containers command identity', async () => {
  const messages: string[] = [];
  assert.equal(await runCli(['unknown-command'], process.cwd(), (message) => messages.push(message)), 2);
  assert.match(messages[0], /Usage: agent-containers /);
});

test('CLI help returns success and describes public commands', async () => {
  const messages: string[] = [];
  assert.equal(await runCli(['--help'], process.cwd(), (message) => messages.push(message)), 0);
  assert.match(messages[0], /unlock/);
  assert.match(messages[0], /recover/);
  const recoveryMessages: string[] = [];
  assert.equal(await runCli(['recover', 'safe', '--yes'], process.cwd(), (message) => recoveryMessages.push(message)), 2);
  assert.match(recoveryMessages.at(-1) ?? '', /--remote-command-stopped/);
});

test('recover waits for an active workspace lifecycle lock before clearing manual recovery', async () => {
  const stateHome = await mkdtemp(join(tmpdir(), 'agent-containers-cli-recover-'));
  const stateDir = join(stateHome, 'agent-containers');
  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  let releaseLock!: () => void;
  const lockMayRelease = new Promise<void>((resolve) => { releaseLock = resolve; });
  let lockHeld!: () => void;
  const lockIsHeld = new Promise<void>((resolve) => { lockHeld = resolve; });
  try {
    const activeLifecycle = withWorkspaceLock(stateDir, 'safe', async () => {
      await recordManualRecovery(stateDir, 'safe', { reason: 'operation-may-be-active', containerIds: [], worktree: '/repo/worktrees/safe' });
      lockHeld();
      await lockMayRelease;
    });
    await lockIsHeld;
    let recoverSettled = false;
    const recover = runCli(['recover', 'safe', '--yes', '--remote-command-stopped'], process.cwd(), () => undefined).finally(() => { recoverSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(recoverSettled, false, 'recover must not clear a guard while another lifecycle holds the workspace lock');
    assert.ok(await loadManualRecovery(stateDir, 'safe'));
    releaseLock();
    await activeLifecycle;
    assert.equal(await recover, 0);
    assert.equal(await loadManualRecovery(stateDir, 'safe'), undefined);
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
  }
});

test('init and implicit validation resolve the repository root from a subdirectory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-containers-cli-root-'));
  const nested = join(root, 'nested', 'deeper');
  await mkdir(nested, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-b', 'main'], { cwd: root }).status, 0);
  const messages: string[] = [];
  assert.equal(await runCli(['init'], nested, (message) => messages.push(message)), 0);
  assert.match(messages[0], new RegExp(`Wrote ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.agent-containers\\.yml`));
  assert.match(await readFile(join(root, '.agent-containers.yml'), 'utf8'), /version: 1/);
  await writeFile(join(root, '.agent-containers.yml'), 'version: 1\n');
  assert.equal(await runCli(['validate'], nested, () => undefined), 0);
});
