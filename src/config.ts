import { lstat, link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, posix, win32 } from 'node:path';
import { parse } from 'yaml';
import type { AgentContainersConfig, CodespacesAgentContainersConfig, LocalAgentContainersConfig, ProcessResult, ProcessRunner, ProcessRunOptions } from './types.js';
import { getProductionStateDurabilityAdapter, type StateDurabilityAdapter } from './durability.js';
import { credentialOptionShaped, redactSecretDiagnostic, secretShaped } from './secrets.js';

let testDurabilityAdapter: StateDurabilityAdapter | undefined;
export function setConfigDurabilityAdapterForTesting(adapter: StateDurabilityAdapter | undefined): void { testDurabilityAdapter = adapter; }

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
    if (stats.nlink > 1) throw new Error(`${path} has multiple hard links; refusing to overwrite it.`);
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
export async function initConfigV2(directory: string, config: CodespacesAgentContainersConfig, force = false, expectedSnapshot?: string | null): Promise<void> {
  const path = join(directory, '.agent-containers.yml');
  let expected: string | null = expectedSnapshot ?? null;
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error(`${path} is a symlink; refusing to overwrite it.`);
    if (entry.nlink > 1) throw new Error(`${path} has multiple hard links; refusing to overwrite it.`);
    if (!force) throw new Error(`${path} already exists; use --force to overwrite it.`);
    // Legacy callers without an onboarding snapshot still bind this generation.
    if (expectedSnapshot === undefined) expected = hashConfig(await readFile(path, 'utf8'));
  } catch (error: unknown) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
  try {
    await saveConfigAtomic(path, config, force ? expected : null);
  }
  catch (error: unknown) {
    if (error instanceof Error && /changed concurrently/.test(error.message)) throw new Error('Configuration changed concurrently; it was created while onboarding was in progress.', { cause: error });
    throw error;
  }
}

export interface InitConfigSnapshot { current: AgentContainersConfig | null; expectedHash: string | null }

/** Capture the force target before onboarding so preview and publication share one generation. */
export async function snapshotInitConfig(directory: string, force: boolean): Promise<InitConfigSnapshot> {
  const path = join(directory, '.agent-containers.yml');
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error(`${path} is a symlink; refusing to overwrite it.`);
    if (entry.nlink > 1) throw new Error(`${path} has multiple hard links; refusing to overwrite it.`);
    if (!force) throw new Error(`${path} already exists; use --force to overwrite it.`);
    const source = await readFile(path, 'utf8');
    return { current: parseConfig(source), expectedHash: hashConfig(source) };
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return { current: null, expectedHash: null };
    throw error;
  }
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
  let raw: unknown;
  try { raw = parse(source); }
  catch (error: unknown) { throw syntaxError('Invalid configuration syntax', error); }
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

/** Parse a nonsecret v2 onboarding candidate before remote discovery supplies immutable evidence. */
export function parseCodespacesDraft(source: string): CodespacesAgentContainersConfig {
  let raw: unknown;
  try { raw = parse(source); }
  catch (error: unknown) { throw syntaxError('Invalid Codespaces setup draft syntax', error); }
  if (!isRecord(raw) || raw.version !== 2 || raw.backends === undefined) throw new Error('Invalid Codespaces setup draft: schema version 2 is required');
  return parseV2Config(raw, false);
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
    if (secretShaped(name)) errors.push('commands.[redacted] must not use a secret-shaped command name');
    else if (!nonEmptyString(command)) errors.push(`commands.${safeField(name)} must be a non-empty string`);
    else if (secretShaped(command)) errors.push(`commands.${safeField(name)} contains a secret-shaped value`);
  }
  return errors;
}

function parseV2Config(input: Record<string, unknown>, requireEvidence = true): CodespacesAgentContainersConfig {
  rejectUnknownKeys(input, ['version', 'workspace', 'project', 'environment', 'backends'], 'root');
  for (const key of ['workspace', 'project', 'environment', 'backends']) if (!isRecord(input[key])) throw new Error(`Invalid configuration: ${key} must be an object`);
  const workspace = input.workspace as Record<string, unknown>, project = input.project as Record<string, unknown>, environment = input.environment as Record<string, unknown>, backends = input.backends as Record<string, unknown>;
  rejectUnknownKeys(workspace, ['worktreeRoot', 'baseBranch'], 'workspace');
  rejectUnknownKeys(project, ['repository', 'ref', 'expectedOid'], 'project');
  rejectUnknownKeys(environment, ['devcontainerPath', 'devcontainerBlobOid'], 'environment');
  rejectUnknownKeys(backends, ['enabled', 'default', 'local', 'codespaces'], 'backends');
  if (!isRecord(backends.local) || !isRecord(backends.codespaces) || Object.keys(backends.local).length) throw new Error('Invalid configuration: backends.local and backends.codespaces must be strict objects');
  const enabled = backends.enabled;
  if (!Array.isArray(enabled) || !enabled.length || enabled.some((entry) => entry !== 'local' && entry !== 'codespaces') || new Set(enabled).size !== enabled.length) throw new Error('Invalid configuration: backends.enabled must be a nonempty duplicate-free set of local and/or codespaces');
  if ((backends.default !== 'local' && backends.default !== 'codespaces') || !enabled.includes(backends.default)) throw new Error('Invalid configuration: backends.default must be enabled');
  const codespaces = parseCodespaces(backends.codespaces);
  if (codespaces.enabled !== enabled.includes('codespaces')) throw new Error('Invalid configuration: codespaces.enabled must agree with backends.enabled');
  const config: CodespacesAgentContainersConfig = { version: 2, workspace: { worktreeRoot: requiredString(workspace.worktreeRoot, 'workspace.worktreeRoot'), baseBranch: requiredString(workspace.baseBranch, 'workspace.baseBranch') }, project: { repository: repository(project.repository), ref: optionalRef(project.ref, 'project.ref'), expectedOid: optionalOid(project.expectedOid, 'project.expectedOid') }, environment: { devcontainerPath: requiredString(environment.devcontainerPath, 'environment.devcontainerPath'), devcontainerBlobOid: optionalOid(environment.devcontainerBlobOid, 'environment.devcontainerBlobOid') }, backends: { enabled: [...enabled] as ('local' | 'codespaces')[], default: backends.default as 'local' | 'codespaces', local: {}, codespaces } };
  if (enabled.includes('codespaces') && !config.project.repository) throw new Error('Invalid configuration: project.repository is required when Codespaces is enabled');
  if (enabled.includes('codespaces') && !config.project.ref) throw new Error('Invalid configuration: project.ref is required when Codespaces is enabled');
  if (requireEvidence && enabled.includes('codespaces') && (!config.project.expectedOid || !config.environment.devcontainerBlobOid)) throw new Error('Invalid configuration: Codespaces requires validated project.expectedOid and environment.devcontainerBlobOid evidence');
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
  if (result.maxRunning > result.maxTotal || result.maxCreating > result.maxTotal || result.ports.allowPublic || result.ports.allowVisibilityChanges) throw new Error('Invalid configuration: capacity limits must not exceed maxTotal and public ports or visibility changes are unsupported');
  if (new Set(result.secrets.allowedRemoteSecretNames).size !== result.secrets.allowedRemoteSecretNames.length || result.secrets.allowedRemoteSecretNames.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || secretShaped(name))) throw new Error('Invalid configuration: remote secret capabilities must be unique nonsecret environment names');
  rejectCredentialArgv(result.readiness.command, 'backends.codespaces.readiness.command');
  return result;
}

export function configurationDiff(current: AgentContainersConfig | null, next: AgentContainersConfig): string {
  const cost = next.version === 2
    ? `machine: ${next.backends.codespaces.machine ?? 'null'}; idle timeout: ${next.backends.codespaces.idleTimeoutMinutes} minutes; retention: ${next.backends.codespaces.retentionPeriodMinutes} minutes; capacity: total ${next.backends.codespaces.maxTotal}, running ${next.backends.codespaces.maxRunning}, creating ${next.backends.codespaces.maxCreating}`
    : 'local-only configuration';
  return `Configuration preview (nonsecret; cost-sensitive settings): ${cost}\n- ${current ? JSON.stringify(redactConfig(current), null, 2) : '(no configuration)'}\n+ ${JSON.stringify(redactConfig(next), null, 2)}`;
}
export function hashConfig(source: string): string { return createHash('sha256').update(source).digest('hex'); }
export interface ConfigPublicationOptions {
  durabilityAdapter?: StateDurabilityAdapter;
  abortSignal?: AbortSignal;
  deadlineMs?: number;
  ownerAlive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Test seam immediately before the final generation check/publication boundary. */
  beforePublish?: () => Promise<void>;
  /** Test seam after validation and immediately before atomic publication. */
  afterCheckBeforePublish?: () => Promise<void>;
}
interface ConfigLockOwner { pid: number; operation: 'configuration-publication'; token: string; createdAt: string }

/**
 * Publishes only a schema-valid candidate with owner-aware durable serialization.
 * undefined is unconstrained, null requires absence, and a hash requires that exact source.
 */
export async function saveConfigAtomic(path: string, next: AgentContainersConfig, expectedCurrentHash?: string | null, options: ConfigPublicationOptions = {}): Promise<'saved' | 'no-change'> {
  // Reparse the serialized candidate at the publication boundary so callers
  // cannot bypass the strict schema by constructing an object directly.
  const source = canonicalConfigSource(next);
  // An unconstrained equivalent update is observably a no-op: do not require
  // write support or leave a lock artifact merely to report it.
  if (expectedCurrentHash === undefined) {
    try {
      if (canonicalConfigSource(parseConfig(await readFile(path, 'utf8'))) === source) return 'no-change';
    } catch (error: unknown) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
  }
  const adapter = options.durabilityAdapter ?? testDurabilityAdapter ?? getProductionStateDurabilityAdapter();
  await adapter.assertStateWriteSupport();
  const lock = `${path}.lock`;
  const release = await acquireConfigLock(lock, adapter, options);
  let publicationError: unknown;
  try {
    try {
      const current = await readFile(path, 'utf8');
      if (expectedCurrentHash === null || (expectedCurrentHash !== undefined && hashConfig(current) !== expectedCurrentHash)) throw new Error('Configuration changed concurrently; reload and review the new diff.');
      if (expectedCurrentHash === undefined && canonicalConfigSource(parseConfig(current)) === source) return 'no-change';
    } catch (error: unknown) {
      if (!isNodeError(error, 'ENOENT')) throw error;
      if (expectedCurrentHash !== undefined && expectedCurrentHash !== null) throw new Error('Configuration changed concurrently; it no longer exists.', { cause: error });
    }
    const directory = dirname(path);
    const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
    await writeFile(temporary, source, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      await adapter.syncFile(temporary);
      await options.beforePublish?.();
      // The lock coordinates Agent Containers writers; this detects independent
      // changes observed before the platform's final replacement boundary.
      const final = await readFile(path, 'utf8').catch((error: unknown) => {
        if (isNodeError(error, 'ENOENT')) return undefined;
        throw error;
      });
      if (expectedCurrentHash === null ? final !== undefined : expectedCurrentHash !== undefined && (final === undefined || hashConfig(final) !== expectedCurrentHash)) {
        throw new Error('Configuration changed concurrently; reload and review the new diff.');
      }
      await options.afterCheckBeforePublish?.();
      if (expectedCurrentHash !== undefined) {
        // The durable lock serializes cooperating Agent Containers writers.
        // No portable external content-CAS exists after the final observation.
        if (expectedCurrentHash === null && await adapter.publicationMode() === 'recoverable') {
          if (!adapter.moveFileNoReplaceWriteThrough) throw new Error('Native write-through no-replace publication is unavailable; refusing first configuration publication.');
          await adapter.moveFileNoReplaceWriteThrough(temporary, path);
        } else if (expectedCurrentHash === null) {
          await link(temporary, path);
          await rm(temporary, { force: false });
        } else if (await adapter.publicationMode() === 'strict') await rename(temporary, path);
        else await adapter.moveFileWriteThrough(temporary, path);
        if (await adapter.publicationMode() === 'strict') {
          try { await adapter.syncDirectory(directory); }
          catch (error: unknown) { throw new Error(`Configuration publication committed configuration is present but directory durability confirmation failed: ${error instanceof Error ? error.message : String(error)}. Reload and review the committed configuration before retrying.`, { cause: error }); }
        }
      } else if (await adapter.publicationMode() === 'strict') {
        await rename(temporary, path);
        try {
          await adapter.syncDirectory(directory);
        } catch (error: unknown) {
          // rename is already the visibility boundary. Never imply the old
          // generation survived a post-rename durability failure.
          const committed = await readFile(path, 'utf8').catch(() => undefined);
          if (committed === source) {
            throw new Error(`Configuration publication committed configuration is present but directory durability confirmation failed: ${error instanceof Error ? error.message : String(error)}. Reload and review the committed configuration before retrying.`, { cause: error });
          }
          throw error;
        }
      } else await adapter.moveFileWriteThrough(temporary, path);
    } catch (error: unknown) {
      await rm(temporary, { force: true });
      if (isNodeError(error, 'EEXIST')) throw new Error('Configuration changed concurrently; reload and review the new diff.', { cause: error });
      throw error;
    }
    return 'saved';
  } catch (error: unknown) {
    publicationError = error;
    throw error;
  } finally {
    try {
      await release();
    } catch (releaseError: unknown) {
      // A rename has already made this generation visible. Retain that
      // diagnostic rather than replacing it with a later lock-release sync.
      if (publicationError === undefined) {
        // eslint-disable-next-line no-unsafe-finally -- only thrown when publication itself succeeded.
        throw releaseError;
      }
    }
  }
}
function canonicalConfigSource(config: AgentContainersConfig): string {
  return `${JSON.stringify(parseConfig(JSON.stringify(config)), null, 2)}\n`;
}
async function acquireConfigLock(lock: string, adapter: StateDurabilityAdapter, options: ConfigPublicationOptions): Promise<() => Promise<void>> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.deadlineMs ?? 5_000);
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds)));
  const ownerAlive = options.ownerAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch (error: unknown) { return !isNodeError(error, 'ESRCH'); } });
  for (;;) {
    if (options.abortSignal?.aborted) throw new Error('Configuration publication was cancelled while waiting for the active owner.');
    let pending: string | undefined;
    try {
      const pendingPath = `${lock}.${randomUUID()}.pending`;
      pending = pendingPath;
      await mkdir(pendingPath, { mode: 0o700 });
      const owner: ConfigLockOwner = { pid: process.pid, operation: 'configuration-publication', token: randomUUID(), createdAt: new Date(now()).toISOString() };
      const ownerPath = join(pendingPath, 'owner.json');
      await writeFile(ownerPath, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await adapter.syncFile(ownerPath);
      if (await adapter.publicationMode() === 'strict') {
        await adapter.syncDirectory(pendingPath);
        await rename(pendingPath, lock);
        await adapter.syncDirectory(dirname(lock));
      } else await adapter.moveFileWriteThrough(pendingPath, lock);
      return async () => {
        // Rename our exact owner generation away from the acquisition name.
        // This prevents a delayed releaser from deleting a replacement lock.
        const observed = await readConfigLockOwner(lock);
        if (!observed || observed.token !== owner.token || observed.pid !== owner.pid) return;
        const released = `${lock}.${randomUUID()}.released`;
        if (await adapter.publicationMode() === 'strict') await rename(lock, released);
        else await adapter.moveFileWriteThrough(lock, released);
        const moved = await readConfigLockOwner(released);
        if (!moved || moved.token !== owner.token || moved.pid !== owner.pid) throw new Error('Configuration lock ownership changed during release; refusing to remove another owner.');
        await rm(released, { recursive: true, force: false });
        if (await adapter.publicationMode() === 'strict') await adapter.syncDirectory(dirname(lock));
      };
    }
    catch (error: unknown) {
      if (pending) await rm(pending, { recursive: true, force: true });
      if (!isLockContention(error)) throw error;
      const owner = await readConfigLockOwner(lock);
      if (owner && !ownerAlive(owner.pid)) {
        // Move the observed generation out of the acquisition name first.
        // A subsequent owner can publish a fresh lock without being removed by
        // this reclaimer; Windows sharing violations are handled as contention.
        const quarantine = `${lock}.${randomUUID()}.reclaiming`;
        try {
          if (await adapter.publicationMode() === 'strict') await rename(lock, quarantine);
          else await adapter.moveFileWriteThrough(lock, quarantine);
          const quarantinedOwner = await readConfigLockOwner(quarantine);
          if (!quarantinedOwner || quarantinedOwner.token !== owner.token || quarantinedOwner.pid !== owner.pid) {
            throw new Error('Configuration lock ownership changed during reclamation; retry without removing the new owner.', { cause: error });
          }
          await rm(quarantine, { recursive: true, force: false });
          if (await adapter.publicationMode() === 'strict') await adapter.syncDirectory(dirname(lock));
          continue;
        } catch (reclaimError: unknown) {
          if (!isLockContention(reclaimError)) throw reclaimError;
        }
      }
      if (now() >= deadline) throw new Error('Configuration is being updated by an active or unverifiable owner; retry after reviewing the latest configuration.', { cause: error });
      await sleep(10);
    }
  }
}
function isLockContention(error: unknown): boolean {
  return isNodeError(error, 'EEXIST') || isNodeError(error, 'ENOTEMPTY') || isNodeError(error, 'EPERM') || isNodeError(error, 'EACCES');
}
async function readConfigLockOwner(lock: string): Promise<ConfigLockOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
    if (isRecord(value) && typeof value.pid === 'number' && Number.isInteger(value.pid) && value.pid > 0 && value.operation === 'configuration-publication' && typeof value.token === 'string' && typeof value.createdAt === 'string') {
      return { pid: value.pid, operation: 'configuration-publication', token: value.token, createdAt: value.createdAt };
    }
  } catch { /* A malformed owner is never blindly removed. */ }
  return undefined;
}
function requiredString(value: unknown, label: string): string {
  if (!nonEmptyString(value)) throw new Error(`Invalid configuration: ${label} must be a non-empty string`);
  if (secretShaped(value)) throw new Error(`Invalid configuration: ${label} contains a secret-shaped value`);
  return value;
}
function optionalRef(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const ref = requiredString(value, label);
  if (!isStrictGitRef(ref)) throw new Error(`Invalid configuration: ${label} must be a strict Git ref`);
  return ref;
}
function optionalOid(value: unknown, label: string): string | undefined { if (value === undefined) return undefined; const oid = requiredString(value, label); if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid)) throw new Error(`Invalid configuration: ${label} must be a full Git object ID`); return oid; }
function repository(value: unknown): string | undefined { if (value === undefined) return undefined; const result = requiredString(value, 'project.repository'); if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result)) throw new Error('Invalid configuration: project.repository must be OWNER/REPOSITORY'); return result; }
function requiredBoolean(value: unknown, label: string): boolean { if (typeof value !== 'boolean') throw new Error(`Invalid configuration: ${label} must be boolean`); return value; }
function requiredInteger(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number { if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid configuration: ${label} must be an integer between ${minimum} and ${maximum}`); return value; }
function requiredStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !nonEmptyString(entry) || entry.includes('\0'))) throw new Error(`Invalid configuration: ${label} must be an array of non-empty safe strings`);
  if (label !== 'secrets.allowedRemoteSecretNames' && label !== 'readiness.command' && value.some(secretShaped)) throw new Error(`Invalid configuration: ${label} contains a secret-shaped value`);
  return value as string[];
}

function rejectCredentialArgv(argv: string[], label: string): void {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (credentialOptionShaped(value) || /^authorization$/i.test(value)) {
      throw new Error(`Invalid configuration: ${label} contains a credential option`);
    }
    // A value split from its credential flag is still a credential, even when it
    // does not independently resemble a provider token.
    if (index > 0 && credentialOptionShaped(argv[index - 1])) {
      throw new Error(`Invalid configuration: ${label} contains a credential option`);
    }
    // curl-style headers can split both the header option and Bearer value.
    if ((value === '-H' || value === '--header') && /^authorization\s*:/i.test(argv[index + 1] ?? '')) {
      throw new Error(`Invalid configuration: ${label} contains a credential header`);
    }
    if (secretShaped(value) && /^authorization\s*:/i.test(value)) throw new Error(`Invalid configuration: ${label} contains a secret-shaped value`);
    if (/^authorization\s*:/i.test(value) || (/^bearer$/i.test(value) && /^authorization\s*:/i.test(argv[index - 1] ?? ''))) {
      throw new Error(`Invalid configuration: ${label} contains a credential header`);
    }
    if (secretShaped(value)) throw new Error(`Invalid configuration: ${label} contains a secret-shaped value`);
  }
}

function safeField(value: string): string { return secretShaped(value) || /(?:token|password|secret|credential|key)/i.test(value) ? '[redacted]' : value; }
export function redactConfig<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactConfig) as T;
  if (!isRecord(value)) return typeof value === 'string' && secretShaped(value) ? '[redacted]' as T : value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const policyField = key === 'secrets' || key === 'allowedRemoteSecretNames' || key === 'allowCodespaceGitCredential';
    const credentialArgv = key === 'command' && Array.isArray(item) && item.some((entry) => typeof entry === 'string' && credentialOptionShaped(entry));
    return [policyField ? key : safeField(key), policyField ? redactConfig(item) : credentialArgv ? item.map(() => '[redacted]') : /(?:token|password|secret|credential|key)/i.test(key) ? '[redacted]' : redactConfig(item)];
  })) as T;
}

function syntaxError(prefix: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const location = /at line (\d+), column (\d+)/i.exec(message);
  return new Error(`${prefix}${location ? ` at line ${location[1]}, column ${location[2]}` : ''}.`, { cause: error });
}

/** Never render input-derived diagnostics verbatim at a command boundary. */
export function redactDiagnostic(value: string): string {
  return redactSecretDiagnostic(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function isStrictGitRef(value: string): boolean {
  return /^refs\/(?:heads|tags)\/(?:[A-Za-z0-9][A-Za-z0-9._-]*)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(value) &&
    !value.includes('..') && !value.split('/').some((part) => part.endsWith('.') || part.endsWith('.lock'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(input: Record<string, unknown>, allowed: string[], section: string): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Invalid configuration: ${section} contains unknown key${unknown.length === 1 ? '' : 's'} ${unknown.map(safeField).join(', ')}`);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
