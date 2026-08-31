import { resolve } from 'node:path';
import type { ProcessResult, ProcessRunner } from './types.js';
import type { WorkspaceMetadata } from './state.js';

export type { ProcessRunner } from './types.js';

export async function execWorkspace(metadata: WorkspaceMetadata, command: string[], runner: ProcessRunner, save: (metadata: WorkspaceMetadata) => Promise<void>): Promise<ProcessResult> {
  if (command.length === 0) throw new Error('A command is required after --.');
  const configPath = resolve(metadata.worktree, metadata.devcontainerPath);
  const up = await runner.run('devcontainer', ['up', '--workspace-folder', metadata.worktree, '--config', configPath, '--log-format', 'json', '--mount-git-worktree-common-dir']);
  if (up.code !== 0) throw commandError('devcontainer up', up);
  const containerId = containerIdFromOutput(up.stdout);
  if (!containerId) throw new Error('devcontainer up did not report a current containerId in its terminal JSON output.');
  await save({ ...metadata, containerId });
  const result = await runner.run('devcontainer', ['exec', '--workspace-folder', metadata.worktree, '--config', configPath, '--container-id', containerId, ...command], { stdio: 'inherit' });
  if (result.code !== 0) throw commandError('devcontainer exec', result);
  return result;
}

function containerIdFromOutput(output: string): string | undefined {
  for (const line of output.trim().split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line) as { containerId?: unknown };
      return typeof parsed.containerId === 'string' && parsed.containerId.length > 0 ? parsed.containerId : undefined;
    } catch {
      // The CLI may emit human-readable log lines before terminal JSON.
    }
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

function commandError(command: string, result: ProcessResult): CommandError {
  return new CommandError(command, result);
}
