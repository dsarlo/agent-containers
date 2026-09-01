import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

export interface DevcontainerInvocation {
  command: string;
  prefixArgs: string[];
}

export interface DevcontainerResolverDependencies {
  platform?: NodeJS.Platform;
  nodePath?: string;
  environment?: NodeJS.ProcessEnv;
  /** Resolve the command from PATH without invoking a command shell. */
  resolveCommand?: (command: string) => string | undefined;
  resolveModule?: (specifier: string, paths: string[]) => string;
}

/** Resolve the public Dev Containers CLI entry point without a command shell. */
export function resolveDevcontainerInvocation({
  platform = process.platform,
  nodePath = process.execPath,
  environment = process.env,
  resolveCommand = resolveWindowsCommandFromPath(environment),
  resolveModule = (specifier, paths) => createRequire(import.meta.url).resolve(specifier, { paths }),
}: DevcontainerResolverDependencies = {}): DevcontainerInvocation {
  if (platform !== 'win32') return { command: 'devcontainer', prefixArgs: [] };
  const commandPath = resolveCommand('devcontainer.cmd');
  if (!commandPath || !win32.isAbsolute(commandPath) || win32.basename(commandPath).toLowerCase() !== 'devcontainer.cmd') {
    throw new Error('Could not resolve devcontainer.cmd from PATH. Install @devcontainers/cli with the active npm prefix (or expose its devcontainer.cmd on PATH) before running Agent Containers.');
  }
  const commandPrefix = win32.dirname(commandPath);
  const paths = [win32.join(commandPrefix, 'node_modules')];
  let entryPoint: string;
  try {
    entryPoint = resolveModule('@devcontainers/cli/devcontainer.js', paths);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not locate @devcontainers/cli/devcontainer.js for the global npm Dev Containers installation: ${detail}`, { cause: error });
  }
  if (!isPublicDevcontainerEntry(entryPoint)) throw new Error(`Resolved Dev Containers entry is not the public @devcontainers/cli/devcontainer.js package entry: ${entryPoint}`);
  return { command: nodePath, prefixArgs: [entryPoint] };
}

function isPublicDevcontainerEntry(path: string): boolean {
  return win32.isAbsolute(path) && win32.normalize(path).toLowerCase().endsWith('\\@devcontainers\\cli\\devcontainer.js');
}

function resolveWindowsCommandFromPath(environment: NodeJS.ProcessEnv): (command: string) => string | undefined {
  return (command) => {
    const path = environment.Path ?? environment.PATH;
    if (!path) return undefined;
    for (const directory of path.split(';')) {
      if (!directory || !win32.isAbsolute(directory)) continue;
      const candidate = win32.join(directory, command);
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  };
}
