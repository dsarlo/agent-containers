import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { assertDevcontainerPathCommittedOnBaseBranch, configurationDiff, hashConfig, initConfigV2, loadConfig, parseCodespacesDraft, parseConfig, redactDiagnostic, saveConfigAtomic, snapshotInitConfig } from './config.js';
import { discoverProjectSetup, doctor, validateCodespacesSetup } from './setup.js';
import type { CodespacesAgentContainersConfig } from './types.js';
import { acknowledgeUnconfirmedProcessReap, clearManualRecoveryIfCurrent, defaultStateDir, deleteMetadata, isLocalWorkspaceMetadata, listMetadata, loadManualRecovery, loadMetadata, recordManualRecovery, releaseStaleWorkspaceLock, saveMetadata, withWorkspaceLock } from './state.js';
import { execNamedWorkspaceLifecycle } from './runtime.js';
import { createWorkspace, findGitRoot, nodeProcessRunner, removeWorkspace } from './workspaces.js';
import { assertBackendAvailable, resolveExecutionBackend } from './backend.js';

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
        ensureOptions(rest, ['--backends', '--default-backend', '--interactive', '--non-interactive', '--from', '--stdin', '--yes', '--force'], ['--interactive', '--non-interactive', '--stdin', '--yes', '--force']);
        const root = await findGitRoot(cwd, nodeProcessRunner);
        const selection = optionValue(rest, '--backends');
        if (selection === 'codespaces' || selection === 'both') requireCodespacesExperimental();
        const source = optionValue(rest, '--from');
        const stdin = rest.includes('--stdin');
        const nonInteractive = rest.includes('--non-interactive');
        const force = rest.includes('--force');
        if ((source || stdin) && !nonInteractive) throw new UsageError('Noninteractive init imports require --non-interactive.');
        if (source && stdin) throw new UsageError('Use only one of --from FILE or --stdin.');
        if (rest.includes('--interactive')) {
          if (nonInteractive || source || stdin || rest.includes('--yes') || selection || optionValue(rest, '--default-backend')) throw new UsageError('Interactive init cannot be combined with setup mode, selection, or confirmation options.');
          if (!io.isTTY) throw new UsageError('Interactive configuration requires a TTY; use --non-interactive --stdin for unattended setup.');
          const snapshot = await snapshotInitConfig(root, force);
          const next = await interactiveConfig(io, root, snapshot.current);
          await assertEvidenceUnchanged(next, root);
          await initConfigV2(root, next, force, snapshot.expectedHash);
        } else if (source || stdin) {
          if (!rest.includes('--yes')) throw new UsageError('Noninteractive init previews configuration and requires --yes to publish it.');
          const snapshot = await snapshotInitConfig(root, force);
          const next = await loadConfigFromSource(source ? resolve(cwd, source) : undefined, stdin, io.input);
          if (next.version !== 2) throw new Error('Noninteractive init accepts strict schema-v2 nonsecret configuration only.');
          if (next.backends.enabled.includes('codespaces')) requireCodespacesExperimental();
          const validated = await withSetupEvidence(next, root);
          write(configurationDiff(snapshot.current, validated));
          await assertEvidenceUnchanged(validated, root);
          await initConfigV2(root, validated, force, snapshot.expectedHash);
        } else if (!selection) await initConfigV2(root, setupConfig('local'), force);
        else await initConfigV2(root, setupConfig(selection, optionValue(rest, '--default-backend')), force);
        write(`Wrote ${join(root, '.agent-containers.yml')}`);
        return 0;
      }
      case 'configure': {
        ensureOptions(rest, ['--non-interactive', '--interactive', '--from', '--stdin', '--yes'], ['--non-interactive', '--interactive', '--stdin', '--yes']);
        const interactive = rest.includes('--interactive');
        const stdin = rest.includes('--stdin');
        if (interactive === stdin && !optionValue(rest, '--from')) throw new UsageError('Use exactly one of --interactive, --from FILE, or --stdin.');
        if (optionValue(rest, '--from') && stdin) throw new UsageError('Use only one of --from FILE or --stdin.');
        if (interactive && (optionValue(rest, '--from') || rest.includes('--yes'))) throw new UsageError('Interactive configuration cannot be combined with input or confirmation options.');
        if (interactive && !io.isTTY) throw new UsageError('Interactive configuration requires a TTY; use --non-interactive --stdin for unattended setup.');
        if (!interactive && !rest.includes('--non-interactive')) throw new UsageError('Noninteractive configuration requires --non-interactive.');
        const source = optionValue(rest, '--from');
        const root = await findGitRoot(cwd, nodeProcessRunner);
        const path = join(root, '.agent-containers.yml');
        let current = null;
        let expectedCurrentHash: string | null = null;
        try {
          const currentSource = await readFile(path, 'utf8');
          current = parseConfig(currentSource);
          expectedCurrentHash = hashConfig(currentSource);
        } catch (error: unknown) {
          if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        const next = interactive ? await interactiveConfig(io, root, current) : await loadConfigFromSource(source ? resolve(cwd, source) : undefined, stdin, io.input);
        if (next.version !== 2) throw new Error('ac configure accepts strict schema-v2 nonsecret configuration only.');
        if (next.backends.enabled.includes('codespaces')) requireCodespacesExperimental();
        if (!interactive && !rest.includes('--yes')) {
          const preview = await withSetupEvidence(next, root);
          write(configurationDiff(current, preview));
          throw new UsageError('Noninteractive configure requires --yes after reviewing the preview; no changes were made.');
        }
        const validated = interactive ? next : await withSetupEvidence(next, root);
        write(configurationDiff(current, validated));
        await assertEvidenceUnchanged(validated, root);
        write((await saveConfigAtomic(path, validated, expectedCurrentHash)) === 'saved' ? `Saved ${path}` : 'No configuration changes.');
        return 0;
      }
      case 'doctor': {
        ensureOptions(rest, ['--backend', '--workspace', '--json'], ['--json']);
        const requestedBackend = optionValue(rest, '--backend') ?? 'all';
        if (requestedBackend !== 'local' && requestedBackend !== 'codespaces' && requestedBackend !== 'all') throw new UsageError('--backend must be local, codespaces, or all.');
        const root = await findGitRoot(cwd, nodeProcessRunner);
        let config: import('./types.js').AgentContainersConfig;
        try { config = await loadConfig(join(root, '.agent-containers.yml')); }
        catch {
          const report = await doctor({} as import('./types.js').AgentContainersConfig, 'local', nodeProcessRunner, root, { stateDir, workspaceName: optionValue(rest, '--workspace') });
          if (rest.includes('--json')) write(JSON.stringify(report, null, 2)); else write(renderDoctor(report));
          return 1;
        }
        const backend = requestedBackend === 'all' ? (config.version === 1 ? 'local' : 'both') : requestedBackend;
        if (backend === 'codespaces' || (backend === 'both' && config.version === 2 && config.backends.enabled.includes('codespaces'))) requireCodespacesExperimental();
        const report = await doctor(config, backend, nodeProcessRunner, root, { stateDir, workspaceName: optionValue(rest, '--workspace') });
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
        const root = await findGitRoot(cwd, nodeProcessRunner);
        const config = await loadConfig(join(root, '.agent-containers.yml'));
        const requestedBackend = optionValue(rest.slice(1), '--backend');
        if (requestedBackend !== undefined && requestedBackend !== 'local' && requestedBackend !== 'codespaces') throw new UsageError('--backend must be local or codespaces.');
        assertLocalBackendEnabled(config, requestedBackend);
        let recoveryWorktree = resolve(root, config.workspace.worktreeRoot, name);
        return withWorkspaceLock(stateDir, name, async (signal) => {
          recoveryWorktree = resolve(root, config.workspace.worktreeRoot, name);
          const baseBranch = optionValue(rest.slice(1), '--base');
          await assertDevcontainerPathCommittedOnBaseBranch(config, root, nodeProcessRunner, undefined, 'lifecycle', signal);
          if (baseBranch && baseBranch !== config.workspace.baseBranch) {
            await assertDevcontainerPathCommittedOnBaseBranch(config, root, nodeProcessRunner, baseBranch, 'lifecycle', signal);
          }
          let workspace: Awaited<ReturnType<typeof createWorkspace>> | undefined;
          const backend = resolveExecutionBackend('local', { create: async () => {
            workspace = await createWorkspace({ cwd, name, config, stateDir, runner: nodeProcessRunner, baseBranch, signal });
            return { kind: 'local' };
          } });
          await backend.create({ name, backend: 'local' }, signal);
          if (!workspace) throw new Error('Local workspace creation did not return metadata.');
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
        const recorded = await loadMetadata(stateDir, name);
        if (!recorded) throw new Error(`No Agent Containers workspace named "${name}".`);
        if (!('repoRoot' in recorded)) await resolveExecutionBackend('codespaces').execute({ kind: 'codespaces', id: recorded.workspaceId, name: recorded.name, environmentId: recorded.remote.environmentId }, { commandId: 'phase-gated', argv: [rest[separator + 1] ?? 'true', ...rest.slice(separator + 2)] });
        const backend = resolveExecutionBackend('local', { execute: async function* (_handle, request) {
          const result = await execNamedWorkspaceLifecycle(name, [...request.argv], nodeProcessRunner, stateDir);
          yield { type: 'exit', commandId: request.commandId, code: result.code };
        } });
        for await (const event of backend.execute({ kind: 'local' }, { commandId: `cli-${name}`, argv: [rest[separator + 1] ?? '', ...rest.slice(separator + 2)] })) { void event; }
        return 0;
      }
      case 'recover': {
        const name = requiredPositional(rest, 'workspace name');
        ensureOnly(rest.slice(1), ['--yes', '--remote-command-stopped']);
        if (!rest.includes('--yes') || !rest.includes('--remote-command-stopped')) {
          throw new UsageError('Usage: agent-containers recover <name> --yes --remote-command-stopped');
        }
        const recorded = await loadMetadata(stateDir, name);
        if (recorded && !isLocalWorkspaceMetadata(recorded)) throw new Error(`Workspace "${name}" records the Codespaces backend, which is phase-gated and cannot be recovered by local cleanup.`);
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
        const recorded = await loadMetadata(stateDir, name);
        if (recorded && !isLocalWorkspaceMetadata(recorded)) throw new Error(`Workspace "${name}" records the Codespaces backend, which is phase-gated and cannot be unlocked by local cleanup.`);
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
        // Inspect durable identity before acquiring local lifecycle state or issuing Git/Docker commands.
        const recorded = await loadMetadata(stateDir, name);
        if (!recorded) throw new Error(`No Agent Containers workspace named "${name}".`);
        if (!isLocalWorkspaceMetadata(recorded)) throw new Error(`Workspace "${name}" records the Codespaces backend, which is phase-gated and cannot be removed by local cleanup.`);
        await withWorkspaceLock(stateDir, name, async (signal) => {
          const metadata = await loadMetadata(stateDir, name);
          if (!metadata) throw new Error(`No Agent Containers workspace named "${name}".`);
          if (!isLocalWorkspaceMetadata(metadata)) throw new Error(`Workspace "${name}" records the Codespaces backend, which is phase-gated and cannot be removed by local cleanup.`);
          recoveryWorktree = metadata.worktree;
          recoveryContainerIds = metadata.containerId ? [metadata.containerId] : [];
          const backend = resolveExecutionBackend('local', { remove: async () => {
            await removeWorkspace(metadata, { confirmed: true, forceWorktree: rest.includes('--force-worktree'), skipContainerCleanup: rest.includes('--skip-container-cleanup'), signal }, nodeProcessRunner, (next) => saveMetadata(stateDir, next), () => deleteMetadata(stateDir, name));
          } });
          await backend.remove({ kind: 'local' }, signal);
        }, { onUnconfirmedProcessReap: () => recordManualRecovery(stateDir, name, { reason: 'local-process-reap-unconfirmed', containerIds: recoveryContainerIds, worktree: recoveryWorktree }) });
        write(`Removed ${name}`);
        return 0;
      }
      default:
        throw new UsageError(usage());
    }
  } catch (error: unknown) {
    if (args[0] === 'doctor' && args.includes('--json')) {
      write(JSON.stringify({ schemaVersion: 1, selectedBackends: [], overall: 'action-required', checks: [{ id: 'configuration', backend: 'local', phase: 'pre-provision', state: 'action-required', summary: 'Configuration or invocation prerequisites could not be verified; no runtime probes were attempted.', remediation: ['Correct the prerequisite.', 'Run ac doctor again.'] }] }, null, 2));
      return 1;
    }
    write(`agent-containers: ${redactDiagnostic(error instanceof Error ? error.message : String(error))}`);
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
  return 'Usage: agent-containers <init|configure|doctor|validate|create|exec|run|recover|unlock|status|remove> [options]\n  init [--interactive] [--backends local] [--non-interactive (--from FILE|--stdin)]\n  configure --interactive | --non-interactive (--from FILE|--stdin)\n  doctor [--backend local|codespaces|all] [--workspace NAME] [--json]';
}

function requireCodespacesExperimental(): void {
  if (process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES !== '1') throw new Error('Codespaces setup is experimental; set AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES=1 to enable it.');
}

function assertLocalBackendEnabled(config: import('./types.js').AgentContainersConfig, requestedBackend?: string): void {
  const backend = requestedBackend ?? (config.version === 1 ? 'local' : config.backends.default);
  if (backend === 'codespaces') {
    try { assertBackendAvailable('codespaces'); } catch { throw new Error('Codespaces is selected but lifecycle is phase-gated. Select --backend local when local is enabled.'); }
  }
  if (config.version === 2 && !config.backends.enabled.includes('local')) throw new Error('Local execution is unavailable because local is disabled; Codespaces lifecycle is not implemented in this release.');
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

async function assertEvidenceUnchanged(candidate: CodespacesAgentContainersConfig, root: string): Promise<void> {
  if (!candidate.backends.enabled.includes('codespaces')) return;
  const observed = await validateCodespacesSetup(candidate, root, nodeProcessRunner);
  if (observed.expectedOid !== candidate.project.expectedOid || observed.devcontainerBlobOid !== candidate.environment.devcontainerBlobOid) {
    throw new Error('Codespaces source evidence changed after preview; review a new candidate before saving.');
  }
}

async function loadConfigFromSource(source: string | undefined, stdin: boolean, input: NodeJS.ReadableStream): Promise<CodespacesAgentContainersConfig | import('./types.js').LocalAgentContainersConfig> {
  if (source) return parseCodespacesDraft(await readFile(source, 'utf8'));
  if (!stdin) throw new UsageError('Usage: agent-containers configure --non-interactive (--from FILE|--stdin)');
  return parseCodespacesDraft(await readStdin(input));
}

async function interactiveConfig(io: CliIo, root: string, current: import('./types.js').AgentContainersConfig | null = null): Promise<CodespacesAgentContainersConfig> {
  const prompt = createInterface({ input: io.input, output: io.output, terminal: io.isTTY });
  try {
    io.output.write('Agent Containers Codespaces setup. Enter cancel at any prompt to leave configuration unchanged. Do not enter tokens, keys, or secret values.\n');
    const prior = current?.version === 2 ? structuredClone(current) : undefined;
    const worktreeRoot = await ask(prompt, `Worktree root [${prior?.workspace.worktreeRoot ?? '../.agent-containers-worktrees'}]: `, prior?.workspace.worktreeRoot ?? '../.agent-containers-worktrees');
    const baseBranch = await ask(prompt, `Base branch [${prior?.workspace.baseBranch ?? 'main'}]: `, prior?.workspace.baseBranch ?? 'main');
    const backend = await ask(prompt, `Backend [local|codespaces|both] (${prior ? (prior.backends.enabled.length === 2 ? 'both' : prior.backends.enabled[0]) : 'local'}): `, prior ? (prior.backends.enabled.length === 2 ? 'both' : prior.backends.enabled[0]) : 'local');
    if (backend !== 'local' && backend !== 'codespaces' && backend !== 'both') throw new Error('Backend must be local, codespaces, or both.');
    if (backend !== 'local') requireCodespacesExperimental();
    // Discovery reads the immutable origin tracking tree, never a mutable local branch.
    const discovered = backend === 'local' ? undefined : await discoverProjectSetup(root, nodeProcessRunner);
    const defaultBackend = backend === 'both' ? await ask(prompt, `Default backend [local|codespaces] (${prior?.backends.default ?? 'local'}): `, prior?.backends.default ?? 'local') : backend;
    if (defaultBackend !== 'local' && defaultBackend !== 'codespaces') throw new Error('Default backend must be local or codespaces.');
    const devcontainerPath = await ask(prompt, `Committed Dev Container path [${prior?.environment.devcontainerPath ?? discovered?.devcontainerPath ?? '.devcontainer/devcontainer.json'}]: `, prior?.environment.devcontainerPath ?? discovered?.devcontainerPath ?? '.devcontainer/devcontainer.json');
    const repository = backend === 'local' ? undefined : await ask(prompt, 'Repository [OWNER/REPOSITORY]: ', prior?.project.repository ?? discovered?.repository);
    const ref = backend === 'local' ? undefined : await ask(prompt, `Remote ref [${prior?.project.ref ?? discovered?.ref ?? 'refs/heads/main'}]: `, prior?.project.ref ?? discovered?.ref ?? 'refs/heads/main');
    const candidate = setupConfigTemplate(backend, defaultBackend as 'local' | 'codespaces', repository, ref, devcontainerPath);
    candidate.workspace = { worktreeRoot, baseBranch };
    if (backend !== 'local') {
      if (prior) candidate.backends.codespaces = { ...prior.backends.codespaces, enabled: true };
      const settings = candidate.backends.codespaces;
      settings.machine = (await ask(prompt, 'Machine (leave blank for action-required): ', settings.machine ?? '')) || null;
      settings.geo = await ask(prompt, `Geo [${settings.geo}]: `, settings.geo);
      for (const [key, label] of [['idleTimeoutMinutes', 'Idle timeout minutes'], ['retentionPeriodMinutes', 'Retention minutes'], ['maxTotal', 'Maximum total workspaces'], ['maxRunning', 'Maximum running workspaces'], ['maxCreating', 'Maximum creating workspaces'], ['maxParallelCommandsPerWorkspace', 'Maximum parallel commands']] as const) settings[key] = numberPrompt(await ask(prompt, `${label} [${settings[key]}]: `, String(settings[key])), label);
      settings.readiness.command = listPrompt(await ask(prompt, `Readiness argv (comma-separated, blank for none) [${settings.readiness.command.join(',')}]: `, settings.readiness.command.join(',')));
      for (const [section, key, label] of [['readiness', 'providerTimeoutSeconds', 'Provider readiness timeout seconds'], ['readiness', 'sshTimeoutSeconds', 'SSH readiness timeout seconds'], ['readiness', 'commandTimeoutSeconds', 'Readiness command timeout seconds'], ['transport', 'reconnectWindowSeconds', 'Transport reconnect window seconds'], ['transport', 'cancelGraceSeconds', 'Transport cancel grace seconds'], ['transport', 'remoteLogBytesPerStream', 'Remote log bytes per stream'], ['transport', 'remoteLogRetentionHours', 'Remote log retention hours']] as const) {
        const currentValue = (settings[section] as Record<string, number>)[key];
        (settings[section] as Record<string, number>)[key] = numberPrompt(await ask(prompt, `${label} [${currentValue}]: `, String(currentValue)), label);
      }
      settings.ports.allowVisibilityChanges = booleanPrompt(await ask(prompt, `Allow port visibility changes [${settings.ports.allowVisibilityChanges ? 'yes' : 'no'}]: `, settings.ports.allowVisibilityChanges ? 'yes' : 'no'), 'Allow port visibility changes');
      settings.ports.allowPublic = booleanPrompt(await ask(prompt, `Allow public ports [${settings.ports.allowPublic ? 'yes' : 'no'}]: `, settings.ports.allowPublic ? 'yes' : 'no'), 'Allow public ports');
      settings.secrets.allowedRemoteSecretNames = listPrompt(await ask(prompt, `Allowed remote secret names (names only, comma-separated) [${settings.secrets.allowedRemoteSecretNames.join(',')}]: `, settings.secrets.allowedRemoteSecretNames.join(',')));
      settings.secrets.allowCodespaceGitCredential = booleanPrompt(await ask(prompt, `Allow Codespaces Git credential [${settings.secrets.allowCodespaceGitCredential ? 'yes' : 'no'}]: `, settings.secrets.allowCodespaceGitCredential ? 'yes' : 'no'), 'Allow Codespaces Git credential');
    }
    const drafted = parseCodespacesDraft(JSON.stringify(candidate));
    // Resolve the immutable source facts before rendering. The preview is the
    // exact candidate that may be persisted, never an evidence-free draft.
    const validated = await withSetupEvidence(drafted, root);
    io.output.write(configurationDiff(current, validated) + '\nNo workspace, key, secret, or GitHub setting will be created or changed.\n');
    if ((await ask(prompt, 'Save this nonsecret configuration? [yes/no]: ', 'no')).toLowerCase() !== 'yes') throw new Error('Configuration cancelled; no changes were made.');
    // Confirmation does not authorize a changed remote source. Revalidate at
    // the confirmation boundary before returning the exact previewed candidate.
    await assertEvidenceUnchanged(validated, root);
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

async function readStdin(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function renderDoctor(report: import('./types.js').DoctorReport): string {
  return report.checks.map((check) => `${check.backend}/${check.phase} ${check.state} ${check.id}: ${check.summary}${check.remediation.length ? `\n  ${check.remediation.join('\n  ')}` : ''}`).join('\n');
}
