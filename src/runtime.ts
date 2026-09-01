import { readFile, realpath } from 'node:fs/promises';
import { parse, type ParseError } from 'jsonc-parser';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ProcessOutputEvent, ProcessResult, ProcessRunner, ProcessRunOptions } from './types.js';
import { bootstrapManualRecoveryJournal, clearManualRecovery, isCanonicalContainerId, loadMetadata, recordManualRecovery, saveMetadata, withWorkspaceLock, type WorkspaceMetadata } from './state.js';
import { resolveDevcontainerInvocation, type DevcontainerInvocation } from './devcontainer.js';
import { UnconfirmedProcessReapError } from './workspaces.js';

export type { ProcessRunner } from './types.js';

type DevcontainerConfig = Record<string, unknown>;

/** Durable state required before releasing a lifecycle after remote completion is unknown. */
export interface ManualRecovery {
  reason: 'operation-may-be-active' | 'remote-exec-interrupted' | 'devcontainer-up-ambiguous' | 'local-process-reap-unconfirmed';
  containerIds: string[];
  worktree: string;
}

type RecoveryRecorder = (recovery: ManualRecovery) => Promise<void>;
type RecoveryClearer = () => Promise<void>;
type ConfigReader = (path: string) => Promise<string>;
type PathResolver = (path: string) => Promise<string>;
const DEVCONTAINER_PROGRESS_LINE_LIMIT = 8 * 1024;
const DEVCONTAINER_FAILURE_DETAIL_LIMIT = 2 * 1024;
const readDevcontainerConfig: ConfigReader = (path) => readFile(path, 'utf8');
const resolveSyntheticPath: PathResolver = async (path) => path;

/** Run the remote lifecycle under its durable workspace lock and recovery guard. */
export async function execWorkspaceLifecycle(metadata: WorkspaceMetadata, command: string[], runner: ProcessRunner, _save: (metadata: WorkspaceMetadata) => Promise<void>, stateDir: string, readConfig: ConfigReader = readDevcontainerConfig): Promise<ProcessResult> {
  return withWorkspaceLock(stateDir, metadata.name, async (signal) => {
    const recorded = await loadMetadata(stateDir, metadata.name);
    if (!recorded) throw new Error(`No Agent Containers workspace named "${metadata.name}".`);
    await requireInitializedRecoveryJournal(stateDir, metadata.name);
    return execWorkspace(
      recorded,
      command,
      runner,
      (next) => saveMetadata(stateDir, next),
      readConfig,
      signal,
      (recovery) => recordManualRecovery(stateDir, recorded.name, recovery),
      () => clearManualRecovery(stateDir, recorded.name),
    );
  });
}

/** Load the current workspace record only after acquiring its lifecycle lock. */
export async function execNamedWorkspaceLifecycle(name: string, command: string[], runner: ProcessRunner, stateDir: string, readConfig: ConfigReader = readDevcontainerConfig): Promise<ProcessResult> {
  return withWorkspaceLock(stateDir, name, async (signal) => {
    const metadata = await loadMetadata(stateDir, name);
    if (!metadata) throw new Error(`No Agent Containers workspace named "${name}".`);
    await requireInitializedRecoveryJournal(stateDir, name);
    return execWorkspace(
      metadata,
      command,
      runner,
      (next) => saveMetadata(stateDir, next),
      readConfig,
      signal,
      (recovery) => recordManualRecovery(stateDir, metadata.name, recovery),
      () => clearManualRecovery(stateDir, metadata.name),
    );
  });
}

export async function execWorkspace(metadata: WorkspaceMetadata, command: string[], runner: ProcessRunner, save: (metadata: WorkspaceMetadata) => Promise<void>, readConfig: ConfigReader = readDevcontainerConfig, signal?: AbortSignal, recordRecovery: RecoveryRecorder = missingRecoveryRecorder, clearRecovery: RecoveryClearer = missingRecoveryClearer, resolvePath: PathResolver = readConfig === readDevcontainerConfig ? realpath : resolveSyntheticPath, devcontainer: DevcontainerInvocation = resolveDevcontainerInvocation()): Promise<ProcessResult> {
  if (command.length === 0) throw new Error('A command is required after --.');
  if (metadata.containerId !== undefined && !isCanonicalContainerId(metadata.containerId)) throw new Error(`Workspace ${metadata.name} has a legacy or non-canonical container ID. Verify the container manually, then clear or repair the recorded metadata before running lifecycle commands.`);
  const configPath = await resolveDevcontainerConfigPath(metadata.worktree, metadata.devcontainerPath, resolvePath);
  await assertSupportedDevcontainerConfig(configPath, readConfig);
  await recordRecovery({ reason: 'operation-may-be-active', containerIds: [], worktree: metadata.worktree });
  let up: ProcessResult;
  try {
    up = await runner.run(devcontainer.command, [...devcontainer.prefixArgs, 'up', '--workspace-folder', metadata.worktree, '--config', configPath, '--log-format', 'json', '--mount-git-worktree-common-dir'], withSignal({ kind: 'lifecycle', stdio: 'pipe', onOutput: createDevcontainerProgressReporter((message) => process.stderr.write(`${message}\n`)) }, signal));
  } catch (error: unknown) {
    if (error instanceof UnconfirmedProcessReapError) return unconfirmedReapRecovery(metadata, recordRecovery, error.message);
    return ambiguousUpRecovery(metadata, runner, save, recordRecovery, `devcontainer up did not return a trustworthy terminal outcome: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (up.code !== 0) return ambiguousUpRecovery(metadata, runner, save, recordRecovery, devcontainerUpFailureDetail(up));
  const containerId = containerIdFromOutput(up.stdout);
  if (!containerId) return ambiguousUpRecovery(metadata, runner, save, recordRecovery, 'devcontainer up completed without a trustworthy terminal containerId');
  let ownership: boolean;
  try {
    ownership = await inspectOwnedContainer(metadata, containerId, runner, signal);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return recordAmbiguousUp(recordRecovery, metadata, metadata.containerId === undefined ? [containerId] : [metadata.containerId, containerId], `Docker could not verify Dev Containers returned container ${containerId}: ${detail}`);
  }
  if (!ownership) return recordAmbiguousUp(recordRecovery, metadata, [], `Docker could not prove that Dev Containers returned container ${containerId} with the exact recorded worktree label`);
  if (metadata.containerId !== undefined && metadata.containerId !== containerId) {
    return recordAmbiguousUp(recordRecovery, metadata, [metadata.containerId, containerId], `Recorded container ${metadata.containerId} does not match Dev Containers returned container ${containerId}; an exact worktree label does not authorize replacing a recorded workspace resource`);
  }
  if (metadata.containerId === undefined) try {
    await save({ ...metadata, containerId });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    // A matching local-folder label associates a container with this worktree,
    // but does not prove this invocation created it. Preserve it as a hint only.
    return recordAmbiguousUp(recordRecovery, metadata, [containerId], `Could not persist container metadata (${detail}); preserved container ${containerId} without adopting or removing it`);
  }
  // The CLI can only terminate its local transport. If it was interrupted, it
  // cannot truthfully assert that the command inside the container stopped.
  let result: ProcessResult;
  try {
    result = await runner.run(devcontainer.command, [...devcontainer.prefixArgs, 'exec', '--workspace-folder', metadata.worktree, '--config', configPath, '--container-id', containerId, '--mount-git-worktree-common-dir', ...command], withSignal({ kind: 'lifecycle', stdio: 'inherit' }, signal));
  } catch (error: unknown) {
    if (error instanceof UnconfirmedProcessReapError) return unconfirmedReapRecovery(metadata, recordRecovery, error.message, [containerId]);
    throw error;
  }
  if (signal?.aborted) {
    await recordRecovery({ reason: 'remote-exec-interrupted', containerIds: [containerId], worktree: metadata.worktree });
    throw new Error(`The local Dev Containers CLI was interrupted; the remote command may still be active in container ${containerId}. Agent Containers recorded a manual-recovery block and will not run lifecycle commands for ${metadata.name} until an operator verifies the remote command is stopped and clears it.`);
  }
  if (result.code !== 0) throw commandError('devcontainer exec', result);
  await clearRecovery();
  return result;
}

/**
 * An aborted local `up` has no trustworthy terminal container ID. Query Docker
 * by the exact Dev Containers local-folder label, but never remove a result.
 */
async function ambiguousUpRecovery(metadata: WorkspaceMetadata, runner: ProcessRunner, _save: (metadata: WorkspaceMetadata) => Promise<void>, recordRecovery: RecoveryRecorder, outcome: string): Promise<never> {
  const inspectionSignal = AbortSignal.timeout(5_000);
  const zeroCandidatePolls = 3;
  let matching: string[] = [];
  for (let attempt = 0; attempt < zeroCandidatePolls; attempt += 1) {
    let candidates: string[];
    try {
        const listed = await runner.run('docker', ['ps', '--all', '--quiet', '--no-trunc', '--filter', `label=devcontainer.local_folder=${metadata.worktree}`], withSignal({ kind: 'readonly-probe' }, inspectionSignal));
      if (listed.code !== 0) return recordAmbiguousUp(recordRecovery, metadata, [], `Docker could not list candidate containers: ${commandDetail(listed)}`);
      candidates = listed.stdout.split(/\r?\n/).map((id) => id.trim()).filter(isDockerContainerId);
    } catch (error: unknown) {
      return recordAmbiguousUp(recordRecovery, metadata, [], `Docker could not list candidate containers: ${error instanceof Error ? error.message : String(error)}`);
    }

    matching = [];
    for (const candidate of candidates) {
      try {
        const inspected = await runner.run('docker', ['inspect', '--format', '{{.Id}}\n{{ index .Config.Labels "devcontainer.local_folder" }}', candidate], withSignal({ kind: 'readonly-probe' }, inspectionSignal));
        if (inspected.code !== 0) return recordAmbiguousUp(recordRecovery, metadata, candidates, `Docker could not verify candidate ${candidate}: ${commandDetail(inspected)}`);
        if (isOwnedContainerInspection(inspected.stdout, candidate, metadata.worktree)) matching.push(candidate);
      } catch (error: unknown) {
        return recordAmbiguousUp(recordRecovery, metadata, candidates, `Docker could not verify candidate ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (matching.length > 0 || attempt === zeroCandidatePolls - 1) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }

  if (matching.length === 0) {
    return recordAmbiguousUp(recordRecovery, metadata, [], `${outcome} and Docker found no container whose devcontainer.local_folder label exactly matches ${metadata.worktree}; provisioning may still be starting`);
  }
  return recordAmbiguousUp(recordRecovery, metadata, matching, matching.length === 1
    ? `${outcome}. Found container ${matching[0]} with the exact worktree label, but the terminal outcome is ambiguous and it was not adopted`
    : `${outcome}. Found ${matching.length} containers with the exact worktree label; ownership is ambiguous`);
}

async function recordAmbiguousUp(recordRecovery: RecoveryRecorder, metadata: WorkspaceMetadata, containerIds: string[], detail: string): Promise<never> {
  await recordRecovery({ reason: 'devcontainer-up-ambiguous', containerIds, worktree: metadata.worktree });
  throw new Error(`${detail}. Agent Containers did not remove any container and recorded a manual recovery block; verify Docker state before clearing it.`);
}

function isDockerContainerId(value: string): boolean { return isCanonicalContainerId(value); }

async function inspectOwnedContainer(metadata: WorkspaceMetadata, containerId: string, runner: ProcessRunner, signal?: AbortSignal): Promise<boolean> {
  const inspection = await runner.run('docker', ['inspect', '--format', '{{.Id}}\n{{ index .Config.Labels "devcontainer.local_folder" }}', containerId], withSignal({ kind: 'readonly-probe' }, signal));
  return inspection.code === 0 && isOwnedContainerInspection(inspection.stdout, containerId, metadata.worktree);
}

function isOwnedContainerInspection(output: string, containerId: string, worktree: string): boolean {
  const [id, label, ...extra] = output.replace(/\r/g, '').trimEnd().split('\n');
  return extra.length === 0 && id === containerId && label === worktree;
}

async function unconfirmedReapRecovery(metadata: WorkspaceMetadata, recordRecovery: RecoveryRecorder, detail: string, containerIds: string[] = []): Promise<never> {
  await recordRecovery({ reason: 'local-process-reap-unconfirmed', containerIds, worktree: metadata.worktree });
  throw new Error(`Local Dev Containers process reaping could not be confirmed: ${detail} Agent Containers recorded a manual-recovery block; verify the local process tree and remote container state, then explicitly acknowledge recovery before running another lifecycle operation.`);
}

function commandDetail(result: ProcessResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
}

async function resolveDevcontainerConfigPath(worktree: string, devcontainerPath: string, resolvePath: PathResolver): Promise<string> {
  const requestedConfigPath = resolve(worktree, devcontainerPath);
  const [canonicalWorktree, canonicalConfigPath] = await Promise.all([
    resolvePath(worktree),
    resolvePath(requestedConfigPath),
  ]);
  const configRelativePath = relative(canonicalWorktree, canonicalConfigPath);
  if (configRelativePath === '..' || configRelativePath.startsWith('../') || configRelativePath.startsWith('..\\') || isAbsolute(configRelativePath)) {
    throw new Error(`Dev Container configuration at ${canonicalConfigPath} resolves outside canonical worktree ${canonicalWorktree}.`);
  }
  return canonicalConfigPath;
}

/** Return a compact human-readable message from one structured Dev Containers log line. */
export function formatDevcontainerProgressLine(line: string): string | undefined {
  const parsed = parseDevcontainerLogLine(line);
  if (!parsed || 'outcome' in parsed) return undefined;
  const text = structuredLogText(parsed);
  if (!text) return undefined;
  return compactDevcontainerText(text, DEVCONTAINER_PROGRESS_LINE_LIMIT);
}

/** Frame streamed JSON log chunks so partial lines never reach the terminal. */
export function createDevcontainerProgressReporter(report: (message: string) => void): (event: ProcessOutputEvent) => void {
  let pending = '';
  return (event) => {
    pending += event.text;
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const message = formatDevcontainerProgressLine(line);
      if (message) report(message);
    }
    // Do not retain an unterminated huge transcript or ever print it raw.
    if (pending.length > DEVCONTAINER_PROGRESS_LINE_LIMIT) pending = '';
  };
}

/** Extract a bounded root cause from Dev Containers JSON logs without replaying the transcript. */
export function devcontainerUpFailureDetail(result: ProcessResult): string {
  const lines = `${result.stderr}\n${result.stdout}`.split(/\r?\n/)
    .map((line) => structuredLogText(parseDevcontainerLogLine(line)) ?? (line.trim().startsWith('{') ? undefined : line.trim()))
    .filter((line): line is string => Boolean(line))
    .map((line) => compactDevcontainerText(line, DEVCONTAINER_FAILURE_DETAIL_LIMIT));
  const cause = [...lines].reverse().find((line) => /(?:ERROR:|failed to solve|\bfatal\b|\berror\b)/i.test(line));
  return cause ?? lines.at(-1) ?? `exit code ${result.code}`;
}

function parseDevcontainerLogLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function structuredLogText(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  for (const key of ['text', 'message', 'msg', 'progress', 'data']) {
    if (typeof record[key] === 'string') return record[key];
  }
  return undefined;
}

function compactDevcontainerText(text: string, limit: number): string {
  const compact = text.replace(/^\[\d+(?:\.\d+)? ms\]\s*/, '').replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

export async function assertSupportedDevcontainerConfig(path: string, readConfig: (path: string) => Promise<string> = (configPath) => readFile(configPath, 'utf8')): Promise<void> {
  let config: DevcontainerConfig;
  try {
    config = parseJsoncObject(await readConfig(path));
  } catch (error: unknown) {
    throw new Error(`Could not parse Dev Container configuration at ${path} for Agent Containers safety checks: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const unsupported = ['dockerComposeFile', 'workspaceMount', 'workspaceFolder'].filter((field) => Object.prototype.hasOwnProperty.call(config, field));
  if (unsupported.length > 0) throw new Error(`Agent Containers v0.1 does not support Dev Container ${unsupported.join(', ')} configuration. Remove it or use a simple image-based devcontainer.json; custom mounts and Compose are rejected to preserve isolated-worktree cleanup.`);
}

function parseJsoncObject(source: string): DevcontainerConfig {
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) throw new Error(`invalid JSONC (${errors.map((error) => error.error).join(', ')})`);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Dev Container configuration must be a JSON object');
  return parsed as DevcontainerConfig;
}

function requireInitializedRecoveryJournal(stateDir: string, name: string): Promise<void> {
  return bootstrapManualRecoveryJournal(stateDir, name).then((created) => {
    if (created) throw new Error(`Initialized the durable manual-recovery journal for workspace "${name}". No Dev Containers command was dispatched; retry this invocation before remote work can begin.`);
  });
}

function missingRecoveryRecorder(): Promise<void> {
  return Promise.reject(new Error('Remote completion is unknown, but this execWorkspace caller did not provide durable recovery storage. Refusing to claim the command stopped.'));
}

function missingRecoveryClearer(): Promise<void> {
  return Promise.reject(new Error('Remote completion was confirmed, but this execWorkspace caller did not provide durable recovery storage to clear the operation guard. Refusing to release lifecycle protection.'));
}

function withSignal(options: Omit<ProcessRunOptions, 'signal'> | undefined, signal?: AbortSignal): ProcessRunOptions | undefined {
  return signal ? { ...options, signal } : options;
}

function containerIdFromOutput(output: string): string | undefined {
  for (const line of output.trim().split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line) as { outcome?: unknown; containerId?: unknown };
      return parsed.outcome === 'success' && typeof parsed.containerId === 'string' && isDockerContainerId(parsed.containerId)
        ? parsed.containerId
        : undefined;
    } catch { /* log lines may precede terminal JSON */ }
  }
  return undefined;
}

class CommandError extends Error {
  readonly exitCode: number | undefined;
  constructor(command: string, result: ProcessResult) {
    const detail = command === 'devcontainer up' ? devcontainerUpFailureDetail(result) : commandDetail(result);
    super(`${command} failed: ${detail}`);
    this.exitCode = result.code >= 1 && result.code <= 255 ? result.code : undefined;
  }
}
function commandError(command: string, result: ProcessResult): CommandError { return new CommandError(command, result); }
