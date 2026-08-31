import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { parse } from 'yaml';
import type { AgentContainersConfig } from './types.js';

export const CONFIG_OUTLINE = `# Agent Containers workspace configuration (schema version 1).
# All paths are relative to the source repository unless absolute.
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
  return config;
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
