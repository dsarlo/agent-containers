import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { assertDevcontainerPathCommittedOnBaseBranch, configurationDiff, hashConfig, initConfig, initConfigV2, loadConfig, parseCodespacesDraft, parseConfig, saveConfigAtomic } from './config.js';
import { doctor, validateCodespacesSetup } from './setup.js';
import type { CodespacesAgentContainersConfig } from './types.js';
import { acknowledgeUnconfirmedProcessReap, clearManualRecoveryIfCurrent, defaultStateDir, deleteMetadata, listMetadata, loadManualRecovery, loadMetadata, recordManualRecovery, releaseStaleWorkspaceLock, saveMetadata, withWorkspaceLock } from './state.js';
import { execNamedWorkspaceLifecycle } from './runtime.js';
import { createWorkspace, findGitRoot, nodeProcessRunner, removeWorkspace } from './workspaces.js';

export interface CliIo { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; isTTY: boolean }
const processIo: CliIo = { input: process.stdin, output: process.stdout, isTTY: Boolean(process.stdin.isTTY) };

export async function runCli(args: string[], cwd = process.cwd(), write: (message: string) => void = console.log, io: CliIo = processIo): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    write(usage());
    return 0;
  }
  try {
    const [command, ...rest] = args;
    const stateDir = defaultStateDir();
    switch (command) {
      case 'init': {
        if (rest.includes('--force')) {
          ensureOnly(rest, ['--force']);
          const root = await findGitRoot(cwd, nodeProcessRunner);
          await initConfig(root, true);
          write(`Wrote ${join(root, '.agent-containers.yml')}`);
          return 0;
        }
        ensureOptions(rest, ['--backends', '--default-backend', '--interactive', '--non-interactive', '--from', '--stdin'], ['--interactive', '--non-interactive', '--stdin']);
        const root = await findGitRoot(cwd, nodeProcessRunner);
        const selection = optionValue(rest, '--backends');
        if (selection === 'codespaces' || selection === 'both') requireCodespacesExperimental();
        const source = optionValue(rest, '--from');
        const stdin = rest.includes('--stdin');
        const nonInteractive = rest.includes('--non-interactive');
        if ((source || stdin) && !nonInteractive) throw new UsageError('Noninteractive init imports require --non-interactive.');
        if (source && stdin) throw new UsageError('Use only one of --from FILE or --stdin.');
        if (rest.includes('--interactive')) {
          if (nonInteractive || source || stdin) throw new UsageError('Interactive init cannot be combined with noninteractive input.');
          if (!io.isTTY) throw new UsageError('Interactive configuration requires a TTY; use --non-interactive --stdin for unattended setup.');
          const next = await interactiveConfig(io, root);
          await initConfigV2(root, next);
        } else if (source || stdin) {
          const next = await loadConfigFromSource(source ? resolve(cwd, source) : undefined, stdin);
          if (next.version !== 2) throw new Error('Noninteractive init accepts strict schema-v2 nonsecret configuration only.');
          if (next.backends.enabled.includes('codespaces')) requireCodespacesExperimental();
          const validated = await withSetupEvidence(next, root);
          write(configurationDiff(null, validated));
          await initConfigV2(root, validated);
        } else if (!selection) await initConfigV2(root, setupConfig('local'));
        else await initConfigV2(root, setupConfig(selection, optionValue(rest, '--default-backend')));
        write(`Wrote ${join(root, '.agent-containers.yml')}`);
        return 0;
      }
      case 'configure': {
        ensureOptions(rest, ['--non-interactive', '--interactive', '--from', '--stdin'], ['--non-interactive', '--interactive', '--stdin']);
        const interactive = rest.includes('--interactive');
        const stdin = rest.includes('--stdin');
        if (interactive === stdin && !optionValue(rest, '--from')) throw new UsageError('Use exactly one of --interactive, --from FILE, or --stdin.');
        if (interactive && !io.isTTY) throw new UsageError('Interactive configuration requires a TTY; use --non-interactive --stdin for unattended setup.');
        if (!interactive && !rest.includes('--non-interactive')) throw new UsageError('Noninteractive configuration requires --non-interactive.');
        const source = optionValue(rest, '--from');
        const root = await findGitRoot(cwd, nodeProcessRunner);
        const next = interactive ? await interactiveConfig(io, root) : await loadConfigFromSource(source ? resolve(cwd, source) : undefined, stdin);
        if (next.version !== 2) throw new Error('ac configure accepts strict schema-v2 nonsecret configuration only.');
        if (next.backends.enabled.includes('codespaces')) requireCodespacesExperimental();
        const path = join(root, '.agent-containers.yml');
        let current = null;
        let expectedCurrentHash: string | undefined;
        try {
          const currentSource = await readFile(path, 'utf8');
          current = parseConfig(currentSource);
          expectedCurrentHash = hashConfig(currentSource);
        } catch (error: unknown) {
          if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        const validated = interactive ? next : await withSetupEvidence(next, root);
        write(configurationDiff(current, validated));
        write((await saveConfigAtomic(path, validated, expectedCurrentHash)) === 'saved' ? `Saved ${path}` : 'No configuration changes.');
        return 0;
      }
      case 'doctor': {
        ensureOptions(rest, ['--backend', '--json'], ['--json']);
        const requestedBackend = optionValue(rest, '--backend') ?? 'all';
        if (requestedBackend !== 'local' && requestedBackend !== 'codespaces' && requestedBackend !== 'all') throw new UsageError('--backend must be local, codespaces, or all.');
        const root = await findGitRoot(cwd, nodeProcessRunner);
        const config = await loadConfig(join(root, '.agent-containers.yml'));
        const backend = requestedBackend === 'all' ? (config.version === 1 ? 'local' : 'both') : requestedBackend;
        if (backend === 'codespaces' || (backend === 'both' && config.version === 2 && config.backends.enabled.includes('codespaces'))) requireCodespacesExperimental();
        const report = await doctor(config, backend, nodeProcessRunner, root);
        if (rest.includes('--json')) write(JSON.stringify(report, null, 2));
        else write(renderDoctor(report));
        return report.overall === 'ready' ? 0 : 1;
      }
      case 'validate': {
        ensureOptions(rest, ['--config']);
        const explicitConfig = optionValue(rest, '--config');
        const root = await findGitRoot(cwd, nodeProcessRunner);
        const configPath = explicitConfig ?? join(root, '.agent-containers.yml');
        const config = await loadConfig(resolve(cwd, configPath));
        await assertDevcontainerPathCommittedOnBaseBranch(config, root, nodeProcessRunner);
        write(`Configuration is valid: ${resolve(cwd, configPath)}`);
        return 0;
      }
      case 'create': {
        const name = requiredPositional(rest, 'workspace name');
        ensureOptions(rest.slice(1), ['--base', '--backend']);
        let recoveryWorktree = cwd;
        return withWorkspaceLock(stateDir, name, async (signal) => {
          const root = await findGitRoot(cwd, nodeProcessRunner, signal, 'lifecycle');
          const config = await loadConfig(join(root, '.agent-containers.yml'));
          recoveryWorktree = resolve(root, config.workspace.worktreeRoot, name);
          const requestedBackend = optionValue(rest.slice(1), '--backend');
          if (requestedBackend !== undefined && requestedBackend !== 'local' && requestedBackend !== 'codespaces') throw new UsageError('--backend must be local or codespaces.');
          assertLocalBackendEnabled(config, requestedBackend);
          const baseBranch = optionValue(rest.slice(1), '--base');
          await assertDevcontainerPathCommittedOnBaseBranch(config, root, nodeProcessRunner, undefined, 'lifecycle', signal);
          if (baseBranch && baseBranch !== config.workspace.baseBranch) {
            await assertDevcontainerPathCommittedOnBaseBranch(config, root, nodeProcessRunner, baseBranch, 'lifecycle', signal);
          }
          const workspace = await createWorkspace({ cwd, name, config, stateDir, runner: nodeProcessRunner, baseBranch, signal });
          write(`Created ${workspace.name} at ${workspace.worktree}`);
          return 0;
        }, { onUnconfirmedProcessReap: () => recordManualRecovery(stateDir, name, { reason: 'local-process-reap-unconfirmed', containerIds: [], worktree: recoveryWorktree }) });
      }
      case 'exec':
      case 'run': {
        const separator = rest.indexOf('--');
        if (separator !== 1) throw new UsageError(`Usage: agent-containers ${command} <name> -- <command...>`);
        const name = rest[0];
        // Workspace records created by this release are local-only. Dispatch
        // from that durable identity so a later checkout/config change cannot
        // strand an existing local workspace or select an unimplemented remote
        // backend. Unknown future metadata is rejected by loadMetadata.
        await execNamedWorkspaceLifecycle(name, rest.slice(separator + 1), nodeProcessRunner, stateDir);
        return 0;
      }
      case 'recover': {
        const name = requiredPositional(rest, 'workspace name');
        ensureOnly(rest.slice(1), ['--yes', '--remote-command-stopped']);
        if (!rest.includes('--yes') || !rest.includes('--remote-command-stopped')) {
          throw new UsageError('Usage: agent-containers recover <name> --yes --remote-command-stopped');
        }
        // Bind this acknowledgement to the exact barrier visible before waiting
        // behind another lifecycle. A later lifecycle must never be cleared by it.
        const acknowledged = await loadManualRecovery(stateDir, name);
        await acknowledgeUnconfirmedProcessReap(stateDir, name);
        if (acknowledged) {
          await withWorkspaceLock(stateDir, name, async () => {
            await clearManualRecoveryIfCurrent(stateDir, name, acknowledged.generation);
          }, { allowManualRecovery: true });
        }
        write(`Acknowledged recovery for ${name}; this acknowledgement did not stop or remove any remote container.`);
        return 0;
      }
      case 'unlock': {
        const name = requiredPositional(rest, 'workspace name');
        ensureOnly(rest.slice(1), ['--yes']);
        if (!rest.includes('--yes')) throw new UsageError('Usage: agent-containers unlock <name> --yes');
        await releaseStaleWorkspaceLock(stateDir, name);
        write(`Released stale lifecycle lock for ${name}`);
        return 0;
      }
      case 'status': {
        if (rest.length > 1) throw new UsageError('Usage: agent-containers status [name]');
        const entries = rest[0] ? [await loadMetadata(stateDir, rest[0])] : await listMetadata(stateDir);
        if (entries.some((entry) => !entry)) throw new Error(`No Agent Containers workspace named "${rest[0]}".`);
        write(JSON.stringify(entries, null, 2));
        return 0;
      }
      case 'remove': {
        const name = requiredPositional(rest, 'workspace name');
        ensureOnly(rest.slice(1), ['--yes', '--skip-container-cleanup', '--force-worktree']);
        if (!rest.includes('--yes')) throw new UsageError('Usage: agent-containers remove <name> --yes [--skip-container-cleanup] [--force-worktree]');
        let recoveryWorktree = cwd;
        let recoveryContainerIds: string[] = [];
        await withWorkspaceLock(stateDir, name, async (signal) => {
          const metadata = await loadMetadata(stateDir, name);
          if (!metadata) throw new Error(`No Agent Containers workspace named "${name}".`);
          recoveryWorktree = metadata.worktree;
          recoveryContainerIds = metadata.containerId ? [metadata.containerId] : [];
          await removeWorkspace(metadata, { confirmed: true, forceWorktree: rest.includes('--force-worktree'), skipContainerCleanup: rest.includes('--skip-container-cleanup'), signal }, nodeProcessRunner, (next) => saveMetadata(stateDir, next), () => deleteMetadata(stateDir, name));
        }, { onUnconfirmedProcessReap: () => recordManualRecovery(stateDir, name, { reason: 'local-process-reap-unconfirmed', containerIds: recoveryContainerIds, worktree: recoveryWorktree }) });
        write(`Removed ${name}`);
        return 0;
      }
      default:
        throw new UsageError(usage());
    }
  } catch (error: unknown) {
    write(`agent-containers: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof UsageError ? 2 : exitCodeForError(error) ?? 1;
  }
}

export function exitCodeForError(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'exitCode' in error && typeof error.exitCode === 'number' && error.exitCode >= 1 && error.exitCode <= 255) return error.exitCode;
  return undefined;
}

class UsageError extends Error {}

function requiredPositional(args: string[], label: string): string {
  if (!args[0] || args[0].startsWith('-')) throw new UsageError(`A ${label} is required.`);
  return args[0];
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('-')) throw new UsageError(`${option} requires a value.`);
  return args[index + 1];
}

function ensureOnly(args: string[], allowed: string[]): void {
  if (args.some((arg) => !allowed.includes(arg))) throw new UsageError(usage());
}

function ensureOptions(args: string[], allowed: string[], flags: string[] = []): void {
  for (let index = 0; index < args.length; index += 1) {
    if (!allowed.includes(args[index])) throw new UsageError(usage());
    if (flags.includes(args[index])) continue;
    index += 1;
    if (!args[index]) throw new UsageError(`${args[index - 1]} requires a value.`);
  }
}

function usage(): string {
  return 'Usage: agent-containers <init|configure|doctor|validate|create|exec|run|recover|unlock|status|remove> [options]\n  init [--interactive] [--backends local] [--non-interactive (--from FILE|--stdin)]\n  configure --interactive | --non-interactive (--from FILE|--stdin)\n  doctor [--backend local|codespaces|all] [--json]';
}

function requireCodespacesExperimental(): void {
  if (process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES !== '1') throw new Error('Codespaces setup is experimental; set AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES=1 to enable it.');
}

function assertLocalBackendEnabled(config: import('./types.js').AgentContainersConfig, requestedBackend?: string): void {
  const backend = requestedBackend ?? (config.version === 1 ? 'local' : config.backends.default);
  if (config.version === 2 && !config.backends.enabled.includes('local')) throw new Error('Local execution is unavailable because local is disabled; Codespaces lifecycle is not implemented in this release.');
  if (backend === 'codespaces') throw new Error('Codespaces is selected but lifecycle is not implemented in this release. Select --backend local when local is enabled.');
}

function setupConfig(selection: string, defaultBackend?: string): CodespacesAgentContainersConfig {
  if (selection !== 'local' && selection !== 'codespaces' && selection !== 'both') throw new UsageError('--backends must be local, codespaces, or both.');
  const enabled: Array<'local' | 'codespaces'> = selection === 'both' ? ['local', 'codespaces'] : [selection];
  if (selection === 'both' && !defaultBackend) throw new UsageError('--default-backend is required when --backends both is selected.');
  const selectedDefault = defaultBackend ?? (selection === 'codespaces' ? 'codespaces' : 'local');
  if ((selectedDefault !== 'local' && selectedDefault !== 'codespaces') || !enabled.includes(selectedDefault)) throw new UsageError('--default-backend must be an enabled backend.');
  if (enabled.includes('codespaces')) throw new UsageError('Codespaces setup requires validated repository/ref/Dev Container evidence; use ac init --interactive or --non-interactive --from FILE.');
  return { version: 2, workspace: { worktreeRoot: '../.agent-containers-worktrees', baseBranch: 'main' }, project: {}, environment: { devcontainerPath: '.devcontainer/devcontainer.json' }, backends: { enabled: [...enabled], default: selectedDefault as 'local' | 'codespaces', local: {}, codespaces: { enabled: false, machine: null, geo: 'auto', idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080, maxTotal: 4, maxRunning: 2, maxCreating: 1, maxParallelCommandsPerWorkspace: 1, readiness: { providerTimeoutSeconds: 1200, sshTimeoutSeconds: 120, command: [], commandTimeoutSeconds: 600 }, transport: { reconnectWindowSeconds: 60, cancelGraceSeconds: 10, remoteLogBytesPerStream: 67108864, remoteLogRetentionHours: 168 }, ports: { allowVisibilityChanges: false, allowPublic: false }, secrets: { allowedRemoteSecretNames: [], allowCodespaceGitCredential: false } } } };
}

async function withSetupEvidence(next: CodespacesAgentContainersConfig, root: string): Promise<CodespacesAgentContainersConfig> {
  if (!next.backends.enabled.includes('codespaces')) return next;
  const evidence = await validateCodespacesSetup(next, root, nodeProcessRunner);
  return { ...next, project: { ...next.project, expectedOid: evidence.expectedOid }, environment: { ...next.environment, devcontainerBlobOid: evidence.devcontainerBlobOid } };
}

async function loadConfigFromSource(source: string | undefined, stdin: boolean): Promise<CodespacesAgentContainersConfig | import('./types.js').LocalAgentContainersConfig> {
  if (source) return parseCodespacesDraft(await readFile(source, 'utf8'));
  if (!stdin) throw new UsageError('Usage: agent-containers configure --non-interactive (--from FILE|--stdin)');
  return parseCodespacesDraft(await readStdin());
}

async function interactiveConfig(io: CliIo, root: string): Promise<CodespacesAgentContainersConfig> {
  const prompt = createInterface({ input: io.input, output: io.output, terminal: io.isTTY });
  try {
    io.output.write('Agent Containers Codespaces setup. Enter cancel at any prompt to leave configuration unchanged. Do not enter tokens, keys, or secret values.\n');
    const worktreeRoot = await ask(prompt, 'Worktree root [../.agent-containers-worktrees]: ', '../.agent-containers-worktrees');
    const baseBranch = await ask(prompt, 'Base branch [main]: ', 'main');
    const backend = await ask(prompt, 'Backend [local|codespaces|both] (local): ', 'local');
    if (backend !== 'local' && backend !== 'codespaces' && backend !== 'both') throw new Error('Backend must be local, codespaces, or both.');
    if (backend !== 'local') requireCodespacesExperimental();
    const defaultBackend = backend === 'both' ? await ask(prompt, 'Default backend [local|codespaces]: ') : backend;
    if (defaultBackend !== 'local' && defaultBackend !== 'codespaces') throw new Error('Default backend must be local or codespaces.');
    const devcontainerPath = await ask(prompt, 'Committed Dev Container path [.devcontainer/devcontainer.json]: ', '.devcontainer/devcontainer.json');
    const repository = backend === 'local' ? undefined : await ask(prompt, 'Repository [OWNER/REPOSITORY]: ');
    const ref = backend === 'local' ? undefined : await ask(prompt, 'Remote ref [refs/heads/main]: ', 'refs/heads/main');
    const candidate = setupConfigTemplate(backend, defaultBackend as 'local' | 'codespaces', repository, ref, devcontainerPath);
    candidate.workspace = { worktreeRoot, baseBranch };
    if (backend !== 'local') {
      const settings = candidate.backends.codespaces;
      settings.machine = (await ask(prompt, 'Machine (leave blank for action-required): ', '')) || null;
      settings.geo = await ask(prompt, 'Geo [auto]: ', 'auto');
      for (const [key, label, fallback] of [['idleTimeoutMinutes', 'Idle timeout minutes', '30'], ['retentionPeriodMinutes', 'Retention minutes', '10080'], ['maxTotal', 'Maximum total workspaces', '4'], ['maxRunning', 'Maximum running workspaces', '2'], ['maxCreating', 'Maximum creating workspaces', '1'], ['maxParallelCommandsPerWorkspace', 'Maximum parallel commands', '1']] as const) settings[key] = numberPrompt(await ask(prompt, `${label} [${fallback}]: `, fallback), label);
      settings.readiness.command = listPrompt(await ask(prompt, 'Readiness argv (comma-separated, blank for none): ', ''));
      for (const [section, key, label, fallback] of [['readiness', 'providerTimeoutSeconds', 'Provider readiness timeout seconds', '1200'], ['readiness', 'sshTimeoutSeconds', 'SSH readiness timeout seconds', '120'], ['readiness', 'commandTimeoutSeconds', 'Readiness command timeout seconds', '600'], ['transport', 'reconnectWindowSeconds', 'Transport reconnect window seconds', '60'], ['transport', 'cancelGraceSeconds', 'Transport cancel grace seconds', '10'], ['transport', 'remoteLogBytesPerStream', 'Remote log bytes per stream', '67108864'], ['transport', 'remoteLogRetentionHours', 'Remote log retention hours', '168']] as const) (settings[section] as Record<string, number>)[key] = numberPrompt(await ask(prompt, `${label} [${fallback}]: `, fallback), label);
      settings.ports.allowVisibilityChanges = booleanPrompt(await ask(prompt, 'Allow port visibility changes [no]: ', 'no'), 'Allow port visibility changes');
      settings.ports.allowPublic = booleanPrompt(await ask(prompt, 'Allow public ports [no]: ', 'no'), 'Allow public ports');
      settings.secrets.allowedRemoteSecretNames = listPrompt(await ask(prompt, 'Allowed remote secret names (names only, comma-separated): ', ''));
      settings.secrets.allowCodespaceGitCredential = booleanPrompt(await ask(prompt, 'Allow Codespaces Git credential [no]: ', 'no'), 'Allow Codespaces Git credential');
    }
    let validated = parseCodespacesDraft(JSON.stringify(candidate));
    if (validated.backends.enabled.includes('codespaces')) validated = await withSetupEvidence(validated, root);
    io.output.write(configurationDiff(null, validated) + '\nNo workspace, key, secret, or GitHub setting will be created or changed.\n');
    if ((await ask(prompt, 'Save this nonsecret configuration? [yes/no]: ', 'no')).toLowerCase() !== 'yes') throw new Error('Configuration cancelled; no changes were made.');
    return validated;
  } finally { prompt.close(); }
}

async function ask(prompt: ReturnType<typeof createInterface>, label: string, fallback?: string): Promise<string> {
  const entered = (await prompt.question(label)).trim();
  if (entered.toLowerCase() === 'cancel') throw new Error('Configuration cancelled; no changes were made.');
  const value = entered || fallback;
  if (value === undefined) throw new Error('Configuration cancelled; no changes were made.');
  return value;
}
function numberPrompt(value: string, label: string): number { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`); return parsed; }
function booleanPrompt(value: string, label: string): boolean { if (value === 'yes') return true; if (value === 'no') return false; throw new Error(`${label} must be yes or no.`); }
function listPrompt(value: string): string[] { return value ? value.split(',').map((entry) => entry.trim()) : []; }

function setupConfigTemplate(selection: string, defaultBackend: 'local' | 'codespaces', repository: string | undefined, ref: string | undefined, devcontainerPath: string): CodespacesAgentContainersConfig {
  const enabled: Array<'local' | 'codespaces'> = selection === 'both' ? ['local', 'codespaces'] : [selection as 'local' | 'codespaces'];
  return { version: 2, workspace: { worktreeRoot: '../.agent-containers-worktrees', baseBranch: 'main' }, project: repository && ref ? { repository, ref } : {}, environment: { devcontainerPath }, backends: { enabled, default: defaultBackend, local: {}, codespaces: { enabled: enabled.includes('codespaces'), machine: null, geo: 'auto', idleTimeoutMinutes: 30, retentionPeriodMinutes: 10080, maxTotal: 4, maxRunning: 2, maxCreating: 1, maxParallelCommandsPerWorkspace: 1, readiness: { providerTimeoutSeconds: 1200, sshTimeoutSeconds: 120, command: [], commandTimeoutSeconds: 600 }, transport: { reconnectWindowSeconds: 60, cancelGraceSeconds: 10, remoteLogBytesPerStream: 67108864, remoteLogRetentionHours: 168 }, ports: { allowVisibilityChanges: false, allowPublic: false }, secrets: { allowedRemoteSecretNames: [], allowCodespaceGitCredential: false } } } };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function renderDoctor(report: import('./types.js').DoctorReport): string {
  return report.checks.map((check) => `${check.backend}/${check.phase} ${check.state} ${check.id}: ${check.summary}${check.remediation.length ? `\n  ${check.remediation.join('\n  ')}` : ''}`).join('\n');
}
