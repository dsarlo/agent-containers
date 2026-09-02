import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { isLocalWorkspaceMetadata, loadManualRecovery, loadMetadata, recordManualRecovery, saveMetadata, setStateDurableRenameForTesting, withWorkspaceLock } from '../src/state.js';
import { exitCodeForError, runCli } from '../src/cli.js';
import { nodeProcessRunner, UnconfirmedProcessReapError } from '../src/workspaces.js';

const repoRoot = resolve(tmpdir(), 'agent-containers-cli-repo');
const worktree = join(repoRoot, 'worktrees', 'safe');

test('built public CLI entry point has the platform-appropriate package-bin contract', async () => {
  if (process.platform === 'win32') {
    const result = spawnSync(process.execPath, ['dist/src/bin/agent-containers.js', '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return;
  }
  const mode = (await stat('dist/src/bin/agent-containers.js')).mode & 0o777;
  assert.equal(mode & 0o111, 0o111, 'the built CLI must be directly executable for npm link and package bins');
});

test('CLI parses destructive confirmation options strictly', async () => {
  const messages: string[] = [];
  assert.equal(await runCli(['remove', 'safe'], process.cwd(), (message) => messages.push(message)), 2);
  assert.match(messages.at(-1) ?? '', /--yes/);
  assert.equal(await runCli(['remove', 'safe', '--yes', '--unexpected'], process.cwd(), () => undefined), 2);
  assert.equal(await runCli(['remove', 'safe', '--skip-container-cleanup'], process.cwd(), () => undefined), 2);
  const forceMessages: string[] = [];
  assert.equal(await runCli(['remove', 'safe', '--force-worktree'], process.cwd(), (message) => forceMessages.push(message)), 2);
  assert.match(forceMessages.at(-1) ?? '', /--yes/);
  assert.equal(await runCli(['remove', 'safe', '--yes', '--force-worktree', '--unexpected'], process.cwd(), () => undefined), 2);
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

test('recover retires a dead guarded lifecycle lock without a manual recovery record', async (t) => {
  const stateHome = await mkdtemp(join(tmpdir(), 'agent-containers-cli-guarded-lock-recover-'));
  const stateDir = join(stateHome, 'agent-containers');
  const lockPath = join(stateDir, 'locks', 'safe.lock');
  const previousStateHome = process.env.XDG_STATE_HOME;
  t.after(async () => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    await rm(stateHome, { recursive: true, force: true });
  });
  process.env.XDG_STATE_HOME = stateHome;
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: 2147483647, token: '00000000-0000-4000-8000-000000000001', createdAt: '2026-01-01T00:00:00.000Z' }));
  await writeFile(join(lockPath, 'reap-guard'), 'guarded\n');
  assert.equal(await loadManualRecovery(stateDir, 'safe'), undefined);

  const messages: string[] = [];
  const result = await runCli(['recover', 'safe', '--yes', '--remote-command-stopped'], process.cwd(), (message) => messages.push(message));
  assert.equal(result, 0, messages.join('\n'));
  assert.match(messages.at(-1) ?? '', /Acknowledged recovery/);
  await assert.rejects(() => lstat(lockPath), { code: 'ENOENT' });
});

test('recover acknowledges a legacy journal with a short Docker ID hint without trusting it', async (t) => {
  const stateHome = await mkdtemp(join(tmpdir(), 'agent-containers-cli-legacy-recover-'));
  const stateDir = join(stateHome, 'agent-containers');
  const previousStateHome = process.env.XDG_STATE_HOME;
  t.after(async () => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    await rm(stateHome, { recursive: true, force: true });
  });
  process.env.XDG_STATE_HOME = stateHome;
  const recovery = { version: 1, reason: 'operation-may-be-active', containerIds: ['abcdef012345'], worktree, createdAt: '2026-01-01T00:00:00.000Z' };
  const event = { event: 'set' as const, recovery };
  const entry = { ...event, checksum: createHash('sha256').update(JSON.stringify(event)).digest('hex') };
  await mkdir(join(stateDir, 'locks'), { recursive: true });
  await writeFile(join(stateDir, 'locks', 'safe.manual-recovery.journal'), `${JSON.stringify(entry)}\n`);

  assert.deepEqual((await loadManualRecovery(stateDir, 'safe'))?.containerIds, []);
  const messages: string[] = [];
  assert.equal(await runCli(['recover', 'safe', '--yes', '--remote-command-stopped'], process.cwd(), (message) => messages.push(message)), 0);
  assert.match(messages.at(-1) ?? '', /Acknowledged recovery/);
});

test('recover never clears a newer manual recovery barrier published while it waited for a lifecycle lock', async () => {
  const stateHome = await mkdtemp(join(tmpdir(), 'agent-containers-cli-recover-'));
  const stateDir = join(stateHome, 'agent-containers');
  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  let releaseLock!: () => void;
  const lockMayRelease = new Promise<void>((resolve) => { releaseLock = resolve; });
  let lockHeld!: () => void;
  const lockIsHeld = new Promise<void>((resolve) => { lockHeld = resolve; });
  try {
    await recordManualRecovery(stateDir, 'safe', { reason: 'operation-may-be-active', containerIds: [], worktree });
    const acknowledged = await loadManualRecovery(stateDir, 'safe');
    assert.ok(acknowledged);
    const activeLifecycle = withWorkspaceLock(stateDir, 'safe', async () => {
      lockHeld();
      await lockMayRelease;
    }, { allowManualRecovery: true });
    await lockIsHeld;
    let recoverSettled = false;
    const recover = runCli(['recover', 'safe', '--yes', '--remote-command-stopped'], process.cwd(), () => undefined).finally(() => { recoverSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(recoverSettled, false, 'recover must not clear a guard while another lifecycle holds the workspace lock');
    await recordManualRecovery(stateDir, 'safe', { reason: 'operation-may-be-active', containerIds: [], worktree });
    releaseLock();
    await activeLifecycle;
    assert.equal(await recover, 1);
    assert.notEqual((await loadManualRecovery(stateDir, 'safe'))?.generation, acknowledged.generation);
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
  }
});

test('recover refuses an unconfirmed-reap quarantine whose recorded owner remains alive', async (t) => {
  const stateHome = await mkdtemp(join(tmpdir(), 'agent-containers-cli-quarantine-recover-'));
  const stateDir = join(stateHome, 'agent-containers');
  const previousStateHome = process.env.XDG_STATE_HOME;
  t.after(async () => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    await rm(stateHome, { recursive: true, force: true });
  });
  process.env.XDG_STATE_HOME = stateHome;
  await saveMetadata(stateDir, {
    version: 1,
    name: 'safe',
    repoRoot,
    worktree,
    branch: 'agent-containers/safe',
    baseRef: 'refs/heads/main',
    devcontainerPath: '.devcontainer/devcontainer.json',
    createdAt: '2026-01-01T00:00:00.000Z',
    containerId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  });
  await recordManualRecovery(stateDir, 'safe', { reason: 'local-process-reap-unconfirmed', containerIds: [], worktree });
  await assert.rejects(
    () => withWorkspaceLock(stateDir, 'safe', async () => { throw new UnconfirmedProcessReapError(); }, {
      allowManualRecovery: true,
      onUnconfirmedProcessReap: async () => { throw new Error('recovery journal unavailable'); },
    }),
    /recovery journal unavailable/,
  );
  await assert.equal((await lstat(join(stateDir, 'locks', 'safe.reap-unconfirmed'))).isDirectory(), true);

  const unlockMessages: string[] = [];
  assert.equal(await runCli(['unlock', 'safe', '--yes'], process.cwd(), (message) => unlockMessages.push(message)), 1);
  assert.match(unlockMessages.at(-1) ?? '', /quarantined.*Ordinary unlock never clears/i);

  assert.equal(await runCli(['recover', 'safe', '--yes', '--remote-command-stopped'], process.cwd(), () => undefined), 1);
  assert.ok(await loadManualRecovery(stateDir, 'safe'));
  const saved = await loadMetadata(stateDir, 'safe');
  assert.ok(saved && isLocalWorkspaceMetadata(saved));
  assert.equal(saved.containerId, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  await assert.rejects(() => withWorkspaceLock(stateDir, 'safe', async () => undefined, { timeoutMs: 0 }), /quarantined|lock/i);
});

test('recover refuses a retained lock whose recorded owner remains alive', async (t) => {
  const stateHome = await mkdtemp(join(tmpdir(), 'agent-containers-cli-retained-recover-'));
  const stateDir = join(stateHome, 'agent-containers');
  const previousStateHome = process.env.XDG_STATE_HOME;
  t.after(async () => {
    setStateDurableRenameForTesting(undefined);
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    await rm(stateHome, { recursive: true, force: true });
  });
  process.env.XDG_STATE_HOME = stateHome;
  setStateDurableRenameForTesting(async (source, destination) => {
    if (source.endsWith('safe.lock') && destination.endsWith('safe.reap-unconfirmed')) throw new Error('pre-move rename failure');
    await rename(source, destination);
  });
  await assert.rejects(() => withWorkspaceLock(stateDir, 'safe', async () => { throw new UnconfirmedProcessReapError(); }, {
    onUnconfirmedProcessReap: async () => { throw new Error('journal unavailable'); },
  }), /journal unavailable/);
  const messages: string[] = [];
  assert.equal(await runCli(['unlock', 'safe', '--yes'], process.cwd(), (message) => messages.push(message)), 1);
  assert.match(messages.at(-1) ?? '', /quarantined.*Ordinary unlock never clears/i);
  assert.equal(await runCli(['recover', 'safe', '--yes', '--remote-command-stopped'], process.cwd(), () => undefined), 1);
  await assert.rejects(() => withWorkspaceLock(stateDir, 'safe', async () => undefined, { timeoutMs: 0 }), /quarantined|lock/i);
});

test('validate refuses a Dev Container config absent from the configured local base branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-containers-cli-validate-base-'));
  assert.equal(spawnSync('git', ['init', '-b', 'main'], { cwd: root }).status, 0);
  await writeFile(join(root, '.agent-containers.yml'), 'version: 1\nenvironment:\n  devcontainerPath: .devcontainer/missing.json\n');
  await writeFile(join(root, 'tracked.txt'), 'initial commit\n');
  assert.equal(spawnSync('git', ['add', '.agent-containers.yml', 'tracked.txt'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial'], { cwd: root }).status, 0);
  const messages: string[] = [];

  assert.equal(await runCli(['validate'], root, (message) => messages.push(message)), 1);
  assert.match(messages.at(-1) ?? '', /environment\.devcontainerPath.*must be committed to.*base branch.*or copied into the worktree/s);
});

test('create without --base validates its configured base before Git worktree add', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-containers-cli-create-default-base-contract-'));
  const stateHome = await mkdtemp(join(tmpdir(), 'agent-containers-cli-create-default-state-'));
  const previousStateHome = process.env.XDG_STATE_HOME;
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(stateHome, { recursive: true, force: true })]));
  assert.equal(spawnSync('git', ['init', '-b', 'main'], { cwd: root }).status, 0);
  await writeFile(join(root, '.agent-containers.yml'), 'version: 1\nworkspace:\n  worktreeRoot: worktrees\n  baseBranch: main\nenvironment:\n  devcontainerPath: .devcontainer/devcontainer.json\n');
  await writeFile(join(root, 'tracked.txt'), 'main\n');
  assert.equal(spawnSync('git', ['add', '.agent-containers.yml', 'tracked.txt'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'main missing config'], { cwd: root }).status, 0);
  try {
    process.env.XDG_STATE_HOME = stateHome;
    const messages: string[] = [];
    await assert.rejects(
      () => runCli(['create', 'blocked'], root, (message) => messages.push(message)),
      /environment\.devcontainerPath.*must be committed to.*base branch "main"/s,
    );
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
  }

  assert.equal(spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/agent-containers/blocked'], { cwd: root }).status, 1, 'default create must not create a workspace branch');
});

test('create with --base refuses a base missing its Dev Container config before Git worktree add', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-containers-cli-create-base-contract-'));
  const stateHome = await mkdtemp(join(tmpdir(), 'agent-containers-cli-create-state-'));
  const previousStateHome = process.env.XDG_STATE_HOME;
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(stateHome, { recursive: true, force: true })]));
  assert.equal(spawnSync('git', ['init', '-b', 'main'], { cwd: root }).status, 0);
  await writeFile(join(root, '.agent-containers.yml'), 'version: 1\nworkspace:\n  worktreeRoot: worktrees\n  baseBranch: main\nenvironment:\n  devcontainerPath: .devcontainer/devcontainer.json\n');
  await mkdir(join(root, '.devcontainer'));
  await writeFile(join(root, '.devcontainer', 'devcontainer.json'), '{}\n');
  assert.equal(spawnSync('git', ['add', '.agent-containers.yml', '.devcontainer/devcontainer.json'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'main config'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['checkout', '-b', 'alternate'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['rm', '.devcontainer/devcontainer.json'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'remove alternate config'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['checkout', 'main'], { cwd: root }).status, 0);
  try {
    process.env.XDG_STATE_HOME = stateHome;
    await assert.rejects(
      () => runCli(['create', 'blocked', '--base', 'alternate'], root, () => undefined),
      /environment\.devcontainerPath.*must be committed to.*base branch "alternate"/s,
    );
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
  }

  assert.equal(spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/agent-containers/blocked'], { cwd: root }).status, 1, 'create must not create a workspace branch');
});

test('public create passes its lock signal to validation and durably records uncertain worktree reaping without probes', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-containers-cli-unconfirmed-create-')));
  const stateHome = await mkdtemp(join(tmpdir(), 'agent-containers-cli-unconfirmed-state-'));
  const stateDir = join(stateHome, 'agent-containers');
  const previousStateHome = process.env.XDG_STATE_HOME;
  const originalRun = nodeProcessRunner.run;
  const calls: Array<{ args: string[]; signal?: AbortSignal; kind?: string }> = [];
  t.after(async () => {
    nodeProcessRunner.run = originalRun;
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    await Promise.all([rm(root, { recursive: true, force: true }), rm(stateHome, { recursive: true, force: true })]);
  });
  await writeFile(join(root, '.agent-containers.yml'), 'version: 1\nworkspace:\n  worktreeRoot: worktrees\n  baseBranch: main\nenvironment:\n  devcontainerPath: .devcontainer/devcontainer.json\n');
  process.env.XDG_STATE_HOME = stateHome;
  nodeProcessRunner.run = async (_command, args, options) => {
    calls.push({ args, signal: options?.signal, kind: options?.kind });
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${root}\n`, stderr: '' };
    if (args[0] === 'show-ref') return { code: args.at(-1) === 'refs/heads/agent-containers/partial' ? 1 : 0, stdout: '', stderr: '' };
    if (args[0] === 'ls-tree') return { code: 0, stdout: '100644 blob 0123456789012345678901234567890123456789\t.devcontainer/devcontainer.json\0', stderr: '' };
    if (args.at(-1) === '-h') return { code: 129, stdout: '', stderr: '--[no-]relative-paths\n' };
    if (args[0] === 'worktree' && args[1] === 'add') throw new UnconfirmedProcessReapError();
    throw new Error(`unexpected follow-on probe: ${args.join(' ')}`);
  };

  await assert.rejects(() => runCli(['create', 'partial'], root, () => undefined), UnconfirmedProcessReapError);
  const showRefIndex = calls.findIndex(({ args }) => args[0] === 'show-ref' && args.at(-1) === 'refs/heads/main');
  const lsTreeIndex = calls.findIndex(({ args }) => args[0] === 'ls-tree');
  assert.equal(lsTreeIndex, showRefIndex + 1, 'the config validation Git calls remain adjacent');
  const validation = [calls[showRefIndex], calls[lsTreeIndex]];
  assert.ok(validation.every(({ kind, signal }) => kind === 'lifecycle' && signal), 'both validation Git commands use the create lock signal');
  assert.equal(validation[0]?.signal, validation[1]?.signal);
  assert.deepEqual(calls.at(-1)?.args, ['worktree', 'add', '--relative-paths', '-b', 'agent-containers/partial', join(root, 'worktrees', 'partial'), 'refs/heads/main']);
  assert.equal((await loadManualRecovery(stateDir, 'partial'))?.reason, 'local-process-reap-unconfirmed');
});

test('init and implicit validation resolve the repository root from a subdirectory', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-containers-cli-root-')));
  const nested = join(root, 'nested', 'deeper');
  await mkdir(nested, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-b', 'main'], { cwd: root }).status, 0);
  const messages: string[] = [];
  assert.equal(await runCli(['init'], nested, (message) => messages.push(message)), 0);
  assert.match(messages[0], new RegExp(`Wrote ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.agent-containers\\.yml`));
  assert.match(await readFile(join(root, '.agent-containers.yml'), 'utf8'), /"version": 2/);
  await writeFile(join(root, '.agent-containers.yml'), 'version: 1\n');
  await mkdir(join(root, '.devcontainer'), { recursive: true });
  await writeFile(join(root, '.devcontainer', 'devcontainer.json'), '{}\n');
  assert.equal(spawnSync('git', ['add', '.agent-containers.yml', '.devcontainer/devcontainer.json'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'config'], { cwd: root }).status, 0);
  assert.equal(await runCli(['validate'], nested, () => undefined), 0);
});

test('Codespaces setup commands are unavailable without the explicit experimental gate', async () => {
  const messages: string[] = [];
  const previous = process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES;
  delete process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES;
  try {
    assert.equal(await runCli(['init', '--backends', 'codespaces'], process.cwd(), (message) => messages.push(message)), 1);
  } finally {
    if (previous === undefined) delete process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES;
    else process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES = previous;
  }
  assert.match(messages.at(-1) ?? '', /AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES=1/);
});

test('doctor resolves a v1 local configuration before applying the Codespaces experimental gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-containers-cli-doctor-local-'));
  assert.equal(spawnSync('git', ['init', '-b', 'main'], { cwd: root }).status, 0);
  await writeFile(join(root, '.agent-containers.yml'), 'version: 1\n');
  const previous = process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES;
  delete process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES;
  const messages: string[] = [];
  try {
    await runCli(['doctor', '--json'], root, (message) => messages.push(message));
  } finally {
    if (previous === undefined) delete process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES;
    else process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES = previous;
  }
  assert.doesNotMatch(messages.at(-1) ?? '', /experimental/i);
  assert.match(messages.at(-1) ?? '', /"local"/);
});

test('local create fails closed when schema v2 disables the local backend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-containers-cli-local-disabled-'));
  assert.equal(spawnSync('git', ['init', '-b', 'main'], { cwd: root }).status, 0);
  await writeFile(join(root, '.agent-containers.yml'), JSON.stringify({ version: 2, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, project: { repository: 'owner/repo', ref: 'refs/heads/main', expectedOid: '0123456789012345678901234567890123456789' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' }, backends: { enabled: ['codespaces'], default: 'codespaces', local: {}, codespaces: { enabled: true, machine: null, geo: 'auto', idleTimeoutMinutes: 30, retentionPeriodMinutes: 1, maxTotal: 1, maxRunning: 1, maxCreating: 1, maxParallelCommandsPerWorkspace: 1, readiness: { providerTimeoutSeconds: 1, sshTimeoutSeconds: 1, command: [], commandTimeoutSeconds: 1 }, transport: { reconnectWindowSeconds: 1, cancelGraceSeconds: 1, remoteLogBytesPerStream: 1, remoteLogRetentionHours: 1 }, ports: { allowVisibilityChanges: false, allowPublic: false }, secrets: { allowedRemoteSecretNames: [], allowCodespaceGitCredential: false } } } }));
  await assert.rejects(() => runCli(['create', 'blocked'], root, () => undefined), /local is disabled/);
});

test('create and exec fail closed when schema v2 selects Codespaces as the default backend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-containers-cli-codespaces-default-'));
  assert.equal(spawnSync('git', ['init', '-b', 'main'], { cwd: root }).status, 0);
  const source = JSON.stringify({ version: 2, workspace: { worktreeRoot: 'worktrees', baseBranch: 'main' }, project: { repository: 'owner/repo', ref: 'refs/heads/main', expectedOid: '0123456789012345678901234567890123456789' }, environment: { devcontainerPath: '.devcontainer/devcontainer.json', devcontainerBlobOid: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' }, backends: { enabled: ['local', 'codespaces'], default: 'codespaces', local: {}, codespaces: { enabled: true, machine: null, geo: 'auto', idleTimeoutMinutes: 30, retentionPeriodMinutes: 1, maxTotal: 1, maxRunning: 1, maxCreating: 1, maxParallelCommandsPerWorkspace: 1, readiness: { providerTimeoutSeconds: 1, sshTimeoutSeconds: 1, command: [], commandTimeoutSeconds: 1 }, transport: { reconnectWindowSeconds: 1, cancelGraceSeconds: 1, remoteLogBytesPerStream: 1, remoteLogRetentionHours: 1 }, ports: { allowVisibilityChanges: false, allowPublic: false }, secrets: { allowedRemoteSecretNames: [], allowCodespaceGitCredential: false } } } });
  await writeFile(join(root, '.agent-containers.yml'), source);
  await assert.rejects(() => runCli(['create', 'blocked'], root, () => undefined), /Codespaces is selected/);
});

test('exec dispatches a recorded local workspace without reading mutable checkout configuration', async (t) => {
  const stateHome = await mkdtemp(join(tmpdir(), 'agent-containers-cli-recorded-local-'));
  const stateDir = join(stateHome, 'agent-containers');
  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  t.after(async () => { if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previousStateHome; await rm(stateHome, { recursive: true, force: true }); });
  const { saveMetadata, setStateDurabilityAdapterForTesting } = await import('../src/state.js');
  setStateDurabilityAdapterForTesting({ publicationMode: async () => 'strict', assertStateWriteSupport: async () => undefined, syncFile: async () => undefined, syncDirectory: async () => undefined, moveFileWriteThrough: async () => undefined });
  try {
    await saveMetadata(stateDir, { version: 1, name: 'recorded', repoRoot: '/repo', worktree: '/repo/worktrees/recorded', branch: 'agent-containers/recorded', baseRef: 'refs/heads/main', devcontainerPath: '.devcontainer/devcontainer.json', createdAt: '2026-01-01T00:00:00.000Z' });
    const messages: string[] = [];
    assert.equal(await runCli(['exec', 'recorded', '--', 'true'], tmpdir(), (message) => messages.push(message)), 1);
    assert.doesNotMatch(messages.at(-1) ?? '', /Configuration not found|Codespaces is selected/);
  } finally { setStateDurabilityAdapterForTesting(undefined); }
});
