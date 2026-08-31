import { readFile } from 'node:fs/promises';
import { parse, type ParseError } from 'jsonc-parser';
import { resolve } from 'node:path';
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from './types.js';
import type { WorkspaceMetadata } from './state.js';

export type { ProcessRunner } from './types.js';

type DevcontainerConfig = Record<string, unknown>;

export async function execWorkspace(metadata: WorkspaceMetadata, command: string[], runner: ProcessRunner, save: (metadata: WorkspaceMetadata) => Promise<void>, readConfig: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'), signal?: AbortSignal): Promise<ProcessResult> {
  if (command.length === 0) throw new Error('A command is required after --.');
  const configPath = resolve(metadata.worktree, metadata.devcontainerPath);
  await assertSupportedDevcontainerConfig(configPath, readConfig);
  const up = await runner.run('devcontainer', ['up', '--workspace-folder', metadata.worktree, '--config', configPath, '--log-format', 'json', '--mount-git-worktree-common-dir'], withSignal(undefined, signal));
  if (up.code !== 0) throw commandError('devcontainer up', up);
  const containerId = containerIdFromOutput(up.stdout);
  if (!containerId) throw new Error('devcontainer up did not report a current containerId in its terminal JSON output.');
  try {
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
  // `devcontainer exec` only owns a local CLI; killing it cannot prove an in-container
  // command stopped. Keep the lifecycle lock until the CLI reports the remote command done.
  const result = await runner.run('devcontainer', ['exec', '--workspace-folder', metadata.worktree, '--config', configPath, '--container-id', containerId, ...command], { stdio: 'inherit' });
  if (result.code !== 0) throw commandError('devcontainer exec', result);
  return result;
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
