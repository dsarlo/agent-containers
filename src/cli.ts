import { join, resolve } from 'node:path';
import { initConfig, loadConfig } from './config.js';
import { defaultStateDir, deleteMetadata, listMetadata, loadMetadata, saveMetadata } from './state.js';
import { execWorkspace } from './runtime.js';
import { createWorkspace, nodeProcessRunner, removeWorkspace } from './workspaces.js';

export async function runCli(args: string[], cwd = process.cwd(), write: (message: string) => void = console.log): Promise<number> {
  try {
    const [command, ...rest] = args;
    const stateDir = defaultStateDir();
    switch (command) {
      case 'init':
        ensureOnly(rest, ['--force']);
        await initConfig(cwd, rest.includes('--force'));
        write(`Wrote ${join(cwd, '.arachne.yml')}`);
        return 0;
      case 'validate': {
        const configPath = optionValue(rest, '--config') ?? join(cwd, '.arachne.yml');
        ensureOptions(rest, ['--config']);
        await loadConfig(resolve(cwd, configPath));
        write(`Configuration is valid: ${resolve(cwd, configPath)}`);
        return 0;
      }
      case 'create': {
        const name = requiredPositional(rest, 'workspace name');
        ensureOptions(rest.slice(1), ['--base']);
        const config = await loadConfig(join(cwd, '.arachne.yml'));
        const workspace = await createWorkspace({ cwd, name, config, stateDir, runner: nodeProcessRunner, baseBranch: optionValue(rest.slice(1), '--base') });
        write(`Created ${workspace.name} at ${workspace.worktree}`);
        return 0;
      }
      case 'exec':
      case 'run': {
        const separator = rest.indexOf('--');
        if (separator !== 1) throw new UsageError(`Usage: arachne ${command} <name> -- <command...>`);
        const name = rest[0];
        const metadata = await loadMetadata(stateDir, name);
        if (!metadata) throw new Error(`No Arachne workspace named "${name}".`);
        await execWorkspace(metadata, rest.slice(separator + 1), nodeProcessRunner, (next) => saveMetadata(stateDir, next));
        return 0;
      }
      case 'status': {
        if (rest.length > 1) throw new UsageError('Usage: arachne status [name]');
        const entries = rest[0] ? [await loadMetadata(stateDir, rest[0])] : await listMetadata(stateDir);
        if (entries.some((entry) => !entry)) throw new Error(`No Arachne workspace named "${rest[0]}".`);
        write(JSON.stringify(entries, null, 2));
        return 0;
      }
      case 'remove': {
        const name = requiredPositional(rest, 'workspace name');
        ensureOnly(rest.slice(1), ['--yes', '--skip-container-cleanup']);
        if (!rest.includes('--yes')) throw new UsageError('Usage: arachne remove <name> --yes [--skip-container-cleanup]');
        const metadata = await loadMetadata(stateDir, name);
        if (!metadata) throw new Error(`No Arachne workspace named "${name}".`);
        await removeWorkspace(metadata, { confirmed: true, skipContainerCleanup: rest.includes('--skip-container-cleanup') }, nodeProcessRunner, (next) => saveMetadata(stateDir, next), () => deleteMetadata(stateDir, name));
        write(`Removed ${name}`);
        return 0;
      }
      default:
        throw new UsageError(usage());
    }
  } catch (error: unknown) {
    write(`arachne: ${error instanceof Error ? error.message : String(error)}`);
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
  return 'Usage: arachne <init|validate|create|exec|run|status|remove> [options]';
}
