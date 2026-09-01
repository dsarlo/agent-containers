import { join, resolve } from 'node:path';
import { assertDevcontainerPathCommittedOnBaseBranch, initConfig, loadConfig } from './config.js';
import { acknowledgeUnconfirmedProcessReap, clearManualRecovery, defaultStateDir, deleteMetadata, listMetadata, loadManualRecovery, loadMetadata, recordManualRecovery, releaseStaleWorkspaceLock, saveMetadata, withWorkspaceLock } from './state.js';
import { execNamedWorkspaceLifecycle } from './runtime.js';
import { createWorkspace, findGitRoot, nodeProcessRunner, removeWorkspace } from './workspaces.js';

export async function runCli(args: string[], cwd = process.cwd(), write: (message: string) => void = console.log): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    write(usage());
    return 0;
  }
  try {
    const [command, ...rest] = args;
    const stateDir = defaultStateDir();
    switch (command) {
      case 'init': {
        ensureOnly(rest, ['--force']);
        const root = await findGitRoot(cwd, nodeProcessRunner);
        await initConfig(root, rest.includes('--force'));
        write(`Wrote ${join(root, '.agent-containers.yml')}`);
        return 0;
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
        ensureOptions(rest.slice(1), ['--base']);
        let recoveryWorktree = cwd;
        return withWorkspaceLock(stateDir, name, async (signal) => {
          const root = await findGitRoot(cwd, nodeProcessRunner, signal, 'lifecycle');
          const config = await loadConfig(join(root, '.agent-containers.yml'));
          recoveryWorktree = resolve(root, config.workspace.worktreeRoot, name);
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
        await execNamedWorkspaceLifecycle(name, rest.slice(separator + 1), nodeProcessRunner, stateDir);
        return 0;
      }
      case 'recover': {
        const name = requiredPositional(rest, 'workspace name');
        ensureOnly(rest.slice(1), ['--yes', '--remote-command-stopped']);
        if (!rest.includes('--yes') || !rest.includes('--remote-command-stopped')) {
          throw new UsageError('Usage: agent-containers recover <name> --yes --remote-command-stopped');
        }
        await acknowledgeUnconfirmedProcessReap(stateDir, name);
        if (await loadManualRecovery(stateDir, name)) await withWorkspaceLock(stateDir, name, async () => clearManualRecovery(stateDir, name), { allowManualRecovery: true });
        write(`Cleared manual recovery block for ${name}; this acknowledgement did not stop or remove any remote container.`);
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
        await withWorkspaceLock(stateDir, name, async (signal) => {
          const metadata = await loadMetadata(stateDir, name);
          if (!metadata) throw new Error(`No Agent Containers workspace named "${name}".`);
          recoveryWorktree = metadata.worktree;
          await removeWorkspace(metadata, { confirmed: true, forceWorktree: rest.includes('--force-worktree'), skipContainerCleanup: rest.includes('--skip-container-cleanup'), signal }, nodeProcessRunner, (next) => saveMetadata(stateDir, next), () => deleteMetadata(stateDir, name));
        }, { onUnconfirmedProcessReap: () => recordManualRecovery(stateDir, name, { reason: 'local-process-reap-unconfirmed', containerIds: [], worktree: recoveryWorktree }) });
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

function ensureOptions(args: string[], allowed: string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    if (!allowed.includes(args[index])) throw new UsageError(usage());
    index += 1;
    if (!args[index]) throw new UsageError(`${args[index - 1]} requires a value.`);
  }
}

function usage(): string {
  return 'Usage: agent-containers <init|validate|create|exec|run|recover|unlock|status|remove> [options]';
}
