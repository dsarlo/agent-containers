import { readFile } from 'node:fs/promises';
import { parse, type ParseError } from 'jsonc-parser';
import { resolve } from 'node:path';
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from './types.js';
import type { WorkspaceMetadata } from './state.js';

export type { ProcessRunner } from './types.js';

type DevcontainerConfig = Record<string, unknown>;

/** Durable state required before releasing a lifecycle after remote completion is unknown. */
export interface ManualRecovery {
  reason: 'remote-exec-interrupted' | 'devcontainer-up-ambiguous';
  containerIds: string[];
  worktree: string;
}

type RecoveryRecorder = (recovery: ManualRecovery) => Promise<void>;

export async function execWorkspace(metadata: WorkspaceMetadata, command: string[], runner: ProcessRunner, save: (metadata: WorkspaceMetadata) => Promise<void>, readConfig: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'), signal?: AbortSignal, recordRecovery: RecoveryRecorder = missingRecoveryRecorder): Promise<ProcessResult> {
  if (command.length === 0) throw new Error('A command is required after --.');
  const configPath = resolve(metadata.worktree, metadata.devcontainerPath);
  await assertSupportedDevcontainerConfig(configPath, readConfig);
  let up: ProcessResult;
  try {
    up = await runner.run('devcontainer', ['up', '--workspace-folder', metadata.worktree, '--config', configPath, '--log-format', 'json', '--mount-git-worktree-common-dir'], withSignal(undefined, signal));
  } catch (error: unknown) {
    if (!signal?.aborted) throw error;
    return ambiguousUpRecovery(metadata, runner, save, recordRecovery);
  }
  if (up.code !== 0) {
    if (signal?.aborted) return ambiguousUpRecovery(metadata, runner, save, recordRecovery);
    throw commandError('devcontainer up', up);
  }
  const containerId = containerIdFromOutput(up.stdout);
  if (!containerId) {
    if (signal?.aborted) return ambiguousUpRecovery(metadata, runner, save, recordRecovery);
    throw new Error('devcontainer up did not report a current containerId in its terminal JSON output.');
  }
  if (metadata.containerId !== containerId) try {
    await save({ ...metadata, containerId });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    let cleanup: ProcessResult;
    try {
      cleanup = await runner.run('docker', ['rm', '-f', containerId], withSignal(undefined, AbortSignal.timeout(5_000)));
    } catch (cleanupError: unknown) {
      const cleanupDetail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new Error(`Could not persist container metadata (${detail}) and could not remove untracked container ${containerId}: ${cleanupDetail}.`, { cause: cleanupError });
    }
    if (cleanup.code !== 0) {
      const cleanupDetail = cleanup.stderr.trim() || cleanup.stdout.trim() || `exit code ${cleanup.code}`;
      throw new Error(`Could not persist container metadata (${detail}) and could not remove untracked container ${containerId}: ${cleanupDetail}.`, { cause: error });
    }
    throw new Error(`Could not persist container metadata (${detail}); removed untracked container ${containerId}. Retry the command after fixing state storage.`, { cause: error });
  }
  // The CLI can only terminate its local transport. If it was interrupted, it
  // cannot truthfully assert that the command inside the container stopped.
  const result = await runner.run('devcontainer', ['exec', '--workspace-folder', metadata.worktree, '--config', configPath, '--container-id', containerId, ...command], withSignal({ stdio: 'inherit' }, signal));
  if (signal?.aborted) {
    await recordRecovery({ reason: 'remote-exec-interrupted', containerIds: [containerId], worktree: metadata.worktree });
    throw new Error(`The local Dev Containers CLI was interrupted; the remote command may still be active in container ${containerId}. Agent Containers recorded a manual-recovery block and will not run lifecycle commands for ${metadata.name} until an operator verifies the remote command is stopped and clears it.`);
  }
  if (result.code !== 0) throw commandError('devcontainer exec', result);
  return result;
}

/**
 * An aborted local `up` has no trustworthy terminal container ID. Query Docker
 * by the exact Dev Containers local-folder label, but never remove a result.
 */
async function ambiguousUpRecovery(metadata: WorkspaceMetadata, runner: ProcessRunner, save: (metadata: WorkspaceMetadata) => Promise<void>, recordRecovery: RecoveryRecorder): Promise<never> {
  const inspectionSignal = AbortSignal.timeout(5_000);
  let candidates: string[];
  try {
    const listed = await runner.run('docker', ['ps', '--all', '--quiet', '--filter', `label=devcontainer.local_folder=${metadata.worktree}`], withSignal(undefined, inspectionSignal));
    if (listed.code !== 0) return recordAmbiguousUp(recordRecovery, metadata, [], `Docker could not list candidate containers: ${commandDetail(listed)}`);
    candidates = listed.stdout.split(/\r?\n/).map((id) => id.trim()).filter(isDockerContainerId);
  } catch (error: unknown) {
    return recordAmbiguousUp(recordRecovery, metadata, [], `Docker could not list candidate containers: ${error instanceof Error ? error.message : String(error)}`);
  }

  const matching: string[] = [];
  for (const candidate of candidates) {
    try {
      const inspected = await runner.run('docker', ['inspect', '--format', '{{ index .Config.Labels "devcontainer.local_folder" }}', candidate], withSignal(undefined, inspectionSignal));
      if (inspected.code !== 0) return recordAmbiguousUp(recordRecovery, metadata, candidates, `Docker could not verify candidate ${candidate}: ${commandDetail(inspected)}`);
      if (inspected.stdout.trim() === metadata.worktree) matching.push(candidate);
    } catch (error: unknown) {
      return recordAmbiguousUp(recordRecovery, metadata, candidates, `Docker could not verify candidate ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (matching.length === 0) {
    return recordAmbiguousUp(recordRecovery, metadata, [], `devcontainer up was interrupted without a terminal containerId and Docker found no container whose devcontainer.local_folder label exactly matches ${metadata.worktree}; provisioning may still be starting`);
  }
  if (matching.length === 1) {
    try {
      if (metadata.containerId !== matching[0]) await save({ ...metadata, containerId: matching[0] });
    } catch (error: unknown) {
      return recordAmbiguousUp(recordRecovery, metadata, matching, `Found and preserved container ${matching[0]}, but could not persist its ID: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return recordAmbiguousUp(recordRecovery, metadata, matching, matching.length === 1
    ? `Found and recorded container ${matching[0]} with the exact worktree label, but interrupted provisioning may still be active`
    : `Found ${matching.length} containers with the exact worktree label; ownership is ambiguous`);
}

async function recordAmbiguousUp(recordRecovery: RecoveryRecorder, metadata: WorkspaceMetadata, containerIds: string[], detail: string): Promise<never> {
  await recordRecovery({ reason: 'devcontainer-up-ambiguous', containerIds, worktree: metadata.worktree });
  throw new Error(`${detail}. Agent Containers did not remove any container and recorded a manual recovery block; verify Docker state before clearing it.`);
}

function isDockerContainerId(value: string): boolean {
  return /^[a-f0-9]{12,64}$/i.test(value);
}

function commandDetail(result: ProcessResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
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

function missingRecoveryRecorder(): Promise<void> {
  return Promise.reject(new Error('Remote completion is unknown, but this execWorkspace caller did not provide durable recovery storage. Refusing to claim the command stopped.'));
}

function withSignal(options: Omit<ProcessRunOptions, 'signal'> | undefined, signal?: AbortSignal): ProcessRunOptions | undefined {
  return signal ? { ...options, signal } : options;
}

function containerIdFromOutput(output: string): string | undefined {
  for (const line of output.trim().split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line) as { containerId?: unknown };
      return typeof parsed.containerId === 'string' && parsed.containerId.length > 0 ? parsed.containerId : undefined;
    } catch { /* log lines may precede terminal JSON */ }
  }
  return undefined;
}

class CommandError extends Error {
  readonly exitCode: number | undefined;
  constructor(command: string, result: ProcessResult) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    super(`${command} failed: ${detail}`);
    this.exitCode = result.code >= 1 && result.code <= 255 ? result.code : undefined;
  }
}
function commandError(command: string, result: ProcessResult): CommandError { return new CommandError(command, result); }
