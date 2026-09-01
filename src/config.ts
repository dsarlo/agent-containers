import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, posix, win32 } from 'node:path';
import { parse } from 'yaml';
import type { AgentContainersConfig, ProcessResult, ProcessRunner } from './types.js';

export const CONFIG_OUTLINE = `# Agent Containers workspace configuration (schema version 1).
# workspace.worktreeRoot is relative to the source repository unless absolute.
# environment.devcontainerPath must be a safe repository-relative regular file.
version: 1

workspace:
  # Directory containing isolated Git worktrees.
  worktreeRoot: ../.agent-containers-worktrees
  # Branch used when agent-containers create is not passed --base.
  baseBranch: main

environment:
  # Dev Container configuration used for every workspace.
  devcontainerPath: .devcontainer/devcontainer.json

# Optional named commands for people and agents to discover.
# commands:
#   test: npm test
#   lint: npm run lint
#   start: npm run dev
`;

const defaults: AgentContainersConfig = {
  version: 1,
  workspace: { worktreeRoot: '../.agent-containers-worktrees', baseBranch: 'main' },
  environment: { devcontainerPath: '.devcontainer/devcontainer.json' },
  commands: {},
};

export async function initConfig(directory: string, force = false): Promise<void> {
  const path = `${directory}/.agent-containers.yml`;
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new Error(`${path} is a symlink; refusing to overwrite it.`);
    if (!force) throw new Error(`${path} already exists; use --force to overwrite it.`);
  } catch (error: unknown) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
  if (force) {
    const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, CONFIG_OUTLINE, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, path);
    } catch (error: unknown) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  } else {
    try {
      await writeFile(path, CONFIG_OUTLINE, { encoding: 'utf8', flag: 'wx' });
    } catch (error: unknown) {
      if (isNodeError(error, 'EEXIST')) throw new Error(`${path} already exists; use --force to overwrite it.`, { cause: error });
      throw error;
    }
  }
}

export async function loadConfig(path: string): Promise<AgentContainersConfig> {
  let raw: unknown;
  try {
    raw = parse(await readFile(path, 'utf8'));
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) throw new Error(`Configuration not found at ${path}; run agent-containers init first.`, { cause: error });
    throw new Error(`Could not read configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!isRecord(raw)) throw new Error('Invalid configuration: root must be an object');
  const input = raw;
  rejectUnknownKeys(input, ['version', 'workspace', 'environment', 'commands'], 'root');
  if (input.workspace !== undefined && !isRecord(input.workspace)) throw new Error('Invalid configuration: workspace must be an object');
  if (input.environment !== undefined && !isRecord(input.environment)) throw new Error('Invalid configuration: environment must be an object');
  if (input.commands !== undefined && !isRecord(input.commands)) throw new Error('Invalid configuration: commands must be an object');
  const workspace = input.workspace ?? {};
  const environment = input.environment ?? {};
  const commands = input.commands ?? {};
  rejectUnknownKeys(workspace, ['worktreeRoot', 'baseBranch'], 'workspace');
  rejectUnknownKeys(environment, ['devcontainerPath'], 'environment');
  const config: AgentContainersConfig = {
    version: input.version === undefined ? defaults.version : input.version as 1,
    workspace: {
      worktreeRoot: workspace.worktreeRoot === undefined ? defaults.workspace.worktreeRoot : workspace.worktreeRoot as string,
      baseBranch: workspace.baseBranch === undefined ? defaults.workspace.baseBranch : workspace.baseBranch as string,
    },
    environment: {
      devcontainerPath: environment.devcontainerPath === undefined ? defaults.environment.devcontainerPath : environment.devcontainerPath as string,
    },
    commands: commands as Record<string, string>,
  };
  const errors = validateConfig(config);
  if (errors.length > 0) throw new Error(`Invalid configuration: ${errors.join('; ')}`);
  const devcontainerPath = safeRepositoryPath(config.environment.devcontainerPath);
  if (!devcontainerPath) throw new Error('Invalid configuration: environment.devcontainerPath must be a safe repository-relative path.');
  return { ...config, environment: { ...config.environment, devcontainerPath } };
}

/** Verify that every newly-created linked worktree receives the configured file. */
export async function assertDevcontainerPathCommittedOnBaseBranch(config: AgentContainersConfig, repoRoot: string, runner: ProcessRunner, baseBranch = config.workspace.baseBranch): Promise<void> {
  const path = safeRepositoryPath(config.environment.devcontainerPath);
  if (!path) throw new Error('environment.devcontainerPath must be a safe repository-relative path.');
  const baseRef = `refs/heads/${baseBranch}`;
  const branch = await runner.run('git', ['show-ref', '--verify', '--quiet', baseRef], { cwd: repoRoot });
  if (branch.code === 1) throw new Error(`Configured local base branch "${baseBranch}" does not exist.`);
  if (branch.code !== 0) throw gitCommandError('git show-ref', branch);
  const committed = await runner.run('git', ['ls-tree', '-z', baseRef, '--', path], { cwd: repoRoot });
  if (committed.code !== 0) throw gitCommandError('git ls-tree', committed);
  const entry = gitTreeEntry(committed.stdout, path);
  if (!entry) {
    throw new Error(`environment.devcontainerPath "${config.environment.devcontainerPath}" must be committed to configured local base branch "${baseBranch}" or copied into the worktree.`);
  }
  if (!entry.isRegularFile) {
    throw new Error(`environment.devcontainerPath "${config.environment.devcontainerPath}" must be committed as a regular non-symlink file to configured local base branch "${baseBranch}".`);
  }
}

function gitTreeEntry(output: string, path: string): { isRegularFile: boolean } | undefined {
  for (const record of output.split('\0')) {
    const separator = record.indexOf('\t');
    if (separator < 0 || record.slice(separator + 1) !== path) continue;
    const [mode, type] = record.slice(0, separator).split(' ');
    return { isRegularFile: (mode === '100644' || mode === '100755') && type === 'blob' };
  }
  return undefined;
}

function safeRepositoryPath(value: string): string | undefined {
  if (/[^\x20-\x7e]/.test(value) || value.includes('*') || value.includes('?') || value.includes('[') || value.startsWith(':') || isAbsolute(value) || posix.isAbsolute(value) || win32.isAbsolute(value)) return undefined;
  const components = value.split(/[\\/]/);
  if (components.length === 0 || components.some((component) => !component || component === '.' || component === '..')) return undefined;
  return components.join('/');
}

function gitCommandError(command: string, result: ProcessResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return new Error(`${command} failed: ${detail}`);
}

function validateConfig(config: AgentContainersConfig): string[] {
  const errors: string[] = [];
  if (config.version !== 1) errors.push('version must be 1');
  if (!nonEmptyString(config.workspace.worktreeRoot)) errors.push('workspace.worktreeRoot must be a non-empty string');
  if (!nonEmptyString(config.workspace.baseBranch)) errors.push('workspace.baseBranch must be a non-empty string');
  if (!nonEmptyString(config.environment.devcontainerPath)) errors.push('environment.devcontainerPath must be a non-empty string');
  for (const [name, command] of Object.entries(config.commands)) {
    if (!nonEmptyString(command)) errors.push(`commands.${name} must be a non-empty string`);
  }
  return errors;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(input: Record<string, unknown>, allowed: string[], section: string): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Invalid configuration: ${section} contains unknown key${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}`);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
