import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, posix, win32 } from 'node:path';
import { parse } from 'yaml';
import type { AgentContainersConfig, CodespacesAgentContainersConfig, LocalAgentContainersConfig, ProcessResult, ProcessRunner, ProcessRunOptions } from './types.js';

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

const defaults: LocalAgentContainersConfig = {
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

/** Save a fully validated v2 candidate without silently replacing an existing configuration. */
export async function initConfigV2(directory: string, config: CodespacesAgentContainersConfig): Promise<void> {
  const path = join(directory, '.agent-containers.yml');
  try { await lstat(path); throw new Error(`${path} already exists; use ac configure to review and update it.`); }
  catch (error: unknown) { if (!isNodeError(error, 'ENOENT')) throw error; }
  await saveConfigAtomic(path, config);
}

export async function loadConfig(path: string): Promise<AgentContainersConfig> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) throw new Error(`Configuration not found at ${path}; run agent-containers init first.`, { cause: error });
    throw new Error(`Could not read configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return parseConfig(source);
}

/** Parse exactly the same nonsecret configuration grammar used for files and stdin. */
export function parseConfig(source: string): AgentContainersConfig {
  const raw = parse(source);
  if (!isRecord(raw)) throw new Error('Invalid configuration: root must be an object');
  // Preserve v1's useful validation for incomplete legacy-looking files while
  // recognizing v2 only once its discriminating backend section is present.
  if (raw.version === 2 && raw.backends !== undefined) return parseV2Config(raw);
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
  const config: LocalAgentContainersConfig = {
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
export async function assertDevcontainerPathCommittedOnBaseBranch(config: AgentContainersConfig, repoRoot: string, runner: ProcessRunner, baseBranch = config.workspace.baseBranch, kind: ProcessRunOptions['kind'] = 'readonly-probe', signal?: AbortSignal): Promise<void> {
  const path = safeRepositoryPath(config.environment.devcontainerPath);
  if (!path) throw new Error('environment.devcontainerPath must be a safe repository-relative path.');
  const baseRef = `refs/heads/${baseBranch}`;
  const options = signal ? { cwd: repoRoot, kind, signal } : { cwd: repoRoot, kind };
  const branch = await runner.run('git', ['show-ref', '--verify', '--quiet', baseRef], options);
  if (branch.code === 1) throw new Error(`Configured local base branch "${baseBranch}" does not exist.`);
  if (branch.code !== 0) throw gitCommandError('git show-ref', branch);
  const committed = await runner.run('git', ['ls-tree', '-z', baseRef, '--', path], options);
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

function validateConfig(config: LocalAgentContainersConfig): string[] {
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

function parseV2Config(input: Record<string, unknown>): CodespacesAgentContainersConfig {
  rejectUnknownKeys(input, ['version', 'workspace', 'project', 'environment', 'backends'], 'root');
  for (const key of ['workspace', 'project', 'environment', 'backends']) if (!isRecord(input[key])) throw new Error(`Invalid configuration: ${key} must be an object`);
  const workspace = input.workspace as Record<string, unknown>, project = input.project as Record<string, unknown>, environment = input.environment as Record<string, unknown>, backends = input.backends as Record<string, unknown>;
  rejectUnknownKeys(workspace, ['worktreeRoot', 'baseBranch'], 'workspace');
  rejectUnknownKeys(project, ['repository', 'ref'], 'project');
  rejectUnknownKeys(environment, ['devcontainerPath'], 'environment');
  rejectUnknownKeys(backends, ['enabled', 'default', 'local', 'codespaces'], 'backends');
  if (!isRecord(backends.local) || !isRecord(backends.codespaces) || Object.keys(backends.local).length) throw new Error('Invalid configuration: backends.local and backends.codespaces must be strict objects');
  const enabled = backends.enabled;
  if (!Array.isArray(enabled) || !enabled.length || enabled.some((entry) => entry !== 'local' && entry !== 'codespaces') || new Set(enabled).size !== enabled.length) throw new Error('Invalid configuration: backends.enabled must be a nonempty duplicate-free set of local and/or codespaces');
  if ((backends.default !== 'local' && backends.default !== 'codespaces') || !enabled.includes(backends.default)) throw new Error('Invalid configuration: backends.default must be enabled');
  const codespaces = parseCodespaces(backends.codespaces);
  if (codespaces.enabled !== enabled.includes('codespaces')) throw new Error('Invalid configuration: codespaces.enabled must agree with backends.enabled');
  const config: CodespacesAgentContainersConfig = { version: 2, workspace: { worktreeRoot: requiredString(workspace.worktreeRoot, 'workspace.worktreeRoot'), baseBranch: requiredString(workspace.baseBranch, 'workspace.baseBranch') }, project: { repository: repository(project.repository), ref: optionalString(project.ref, 'project.ref') }, environment: { devcontainerPath: requiredString(environment.devcontainerPath, 'environment.devcontainerPath') }, backends: { enabled: [...enabled] as ('local' | 'codespaces')[], default: backends.default as 'local' | 'codespaces', local: {}, codespaces } };
  const devcontainerPath = safeRepositoryPath(config.environment.devcontainerPath);
  if (!devcontainerPath) throw new Error('Invalid configuration: environment.devcontainerPath must be a safe repository-relative path.');
  config.environment.devcontainerPath = devcontainerPath;
  return config;
}

function parseCodespaces(input: Record<string, unknown>): CodespacesAgentContainersConfig['backends']['codespaces'] {
  const names = ['enabled', 'machine', 'geo', 'idleTimeoutMinutes', 'retentionPeriodMinutes', 'maxTotal', 'maxRunning', 'maxCreating', 'maxParallelCommandsPerWorkspace', 'readiness', 'transport', 'ports', 'secrets'];
  rejectUnknownKeys(input, names, 'backends.codespaces');
  for (const key of ['readiness', 'transport', 'ports', 'secrets']) if (!isRecord(input[key])) throw new Error(`Invalid configuration: backends.codespaces.${key} must be an object`);
  const readiness = input.readiness as Record<string, unknown>, transport = input.transport as Record<string, unknown>, ports = input.ports as Record<string, unknown>, secrets = input.secrets as Record<string, unknown>;
  rejectUnknownKeys(readiness, ['providerTimeoutSeconds', 'sshTimeoutSeconds', 'command', 'commandTimeoutSeconds'], 'backends.codespaces.readiness');
  rejectUnknownKeys(transport, ['reconnectWindowSeconds', 'cancelGraceSeconds', 'remoteLogBytesPerStream', 'remoteLogRetentionHours'], 'backends.codespaces.transport');
  rejectUnknownKeys(ports, ['allowVisibilityChanges', 'allowPublic'], 'backends.codespaces.ports');
  rejectUnknownKeys(secrets, ['allowedRemoteSecretNames', 'allowCodespaceGitCredential'], 'backends.codespaces.secrets');
  const result = { enabled: requiredBoolean(input.enabled, 'codespaces.enabled'), machine: input.machine === null ? null : requiredString(input.machine, 'codespaces.machine'), geo: requiredString(input.geo, 'codespaces.geo'), idleTimeoutMinutes: requiredInteger(input.idleTimeoutMinutes, 'idleTimeoutMinutes', 5, 240), retentionPeriodMinutes: requiredInteger(input.retentionPeriodMinutes, 'retentionPeriodMinutes', 1, 43200), maxTotal: requiredInteger(input.maxTotal, 'maxTotal', 1), maxRunning: requiredInteger(input.maxRunning, 'maxRunning', 1), maxCreating: requiredInteger(input.maxCreating, 'maxCreating', 1), maxParallelCommandsPerWorkspace: requiredInteger(input.maxParallelCommandsPerWorkspace, 'maxParallelCommandsPerWorkspace', 1), readiness: { providerTimeoutSeconds: requiredInteger(readiness.providerTimeoutSeconds, 'providerTimeoutSeconds', 1), sshTimeoutSeconds: requiredInteger(readiness.sshTimeoutSeconds, 'sshTimeoutSeconds', 1), command: requiredStrings(readiness.command, 'readiness.command'), commandTimeoutSeconds: requiredInteger(readiness.commandTimeoutSeconds, 'commandTimeoutSeconds', 1) }, transport: { reconnectWindowSeconds: requiredInteger(transport.reconnectWindowSeconds, 'reconnectWindowSeconds', 1), cancelGraceSeconds: requiredInteger(transport.cancelGraceSeconds, 'cancelGraceSeconds', 1), remoteLogBytesPerStream: requiredInteger(transport.remoteLogBytesPerStream, 'remoteLogBytesPerStream', 1), remoteLogRetentionHours: requiredInteger(transport.remoteLogRetentionHours, 'remoteLogRetentionHours', 1) }, ports: { allowVisibilityChanges: requiredBoolean(ports.allowVisibilityChanges, 'ports.allowVisibilityChanges'), allowPublic: requiredBoolean(ports.allowPublic, 'ports.allowPublic') }, secrets: { allowedRemoteSecretNames: requiredStrings(secrets.allowedRemoteSecretNames, 'secrets.allowedRemoteSecretNames'), allowCodespaceGitCredential: requiredBoolean(secrets.allowCodespaceGitCredential, 'secrets.allowCodespaceGitCredential') } };
  if (result.maxRunning > result.maxTotal || result.maxCreating > result.maxTotal || result.ports.allowPublic) throw new Error('Invalid configuration: capacity limits must not exceed maxTotal and public ports are unsupported');
  if (new Set(result.secrets.allowedRemoteSecretNames).size !== result.secrets.allowedRemoteSecretNames.length || result.secrets.allowedRemoteSecretNames.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error('Invalid configuration: remote secret capabilities must be unique environment names');
  return result;
}

export function configurationDiff(current: AgentContainersConfig | null, next: AgentContainersConfig): string {
  const cost = next.version === 2
    ? `machine: ${next.backends.codespaces.machine ?? 'null'}; idle timeout: ${next.backends.codespaces.idleTimeoutMinutes} minutes; retention: ${next.backends.codespaces.retentionPeriodMinutes} minutes; capacity: total ${next.backends.codespaces.maxTotal}, running ${next.backends.codespaces.maxRunning}, creating ${next.backends.codespaces.maxCreating}`
    : 'local-only configuration';
  return `Configuration preview (nonsecret; cost-sensitive settings): ${cost}\n- ${current ? JSON.stringify(current, null, 2) : '(no configuration)'}\n+ ${JSON.stringify(next, null, 2)}`;
}
export function hashConfig(source: string): string { return createHash('sha256').update(source).digest('hex'); }
export async function saveConfigAtomic(path: string, next: AgentContainersConfig, expectedCurrentHash?: string): Promise<'saved' | 'no-change'> {
  const source = `${JSON.stringify(next, null, 2)}\n`;
  try { const current = await readFile(path, 'utf8'); if (current === source) return 'no-change'; if (expectedCurrentHash && hashConfig(current) !== expectedCurrentHash) throw new Error('Configuration changed concurrently; reload and review the new diff.'); } catch (error: unknown) { if (!isNodeError(error, 'ENOENT')) throw error; if (expectedCurrentHash) throw new Error('Configuration changed concurrently; it no longer exists.', { cause: error }); }
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temporary, source, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
  return 'saved';
}
function requiredString(value: unknown, label: string): string { if (!nonEmptyString(value)) throw new Error(`Invalid configuration: ${label} must be a non-empty string`); return value; }
function optionalString(value: unknown, label: string): string | undefined { return value === undefined ? undefined : requiredString(value, label); }
function repository(value: unknown): string | undefined { if (value === undefined) return undefined; const result = requiredString(value, 'project.repository'); if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result)) throw new Error('Invalid configuration: project.repository must be OWNER/REPOSITORY'); return result; }
function requiredBoolean(value: unknown, label: string): boolean { if (typeof value !== 'boolean') throw new Error(`Invalid configuration: ${label} must be boolean`); return value; }
function requiredInteger(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number { if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid configuration: ${label} must be an integer between ${minimum} and ${maximum}`); return value; }
function requiredStrings(value: unknown, label: string): string[] { if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !nonEmptyString(entry) || entry.includes('\0'))) throw new Error(`Invalid configuration: ${label} must be an array of non-empty safe strings`); return value as string[]; }

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
