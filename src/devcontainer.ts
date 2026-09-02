import { createRequire } from 'node:module';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
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
  /** Confirm a resolved PATH command is an ordinary file rather than a directory or special object. */
  isRegularFile?: (path: string) => boolean;
  /** Resolve physical paths so junctions and links cannot escape the selected npm prefix. */
  realpath?: (path: string) => string;
  /** Inspect a path without following a link or reparse point. */
  lstat?: (path: string) => { isFile(): boolean; isSymbolicLink(): boolean };
  /** Read a Windows command shim without executing it. */
  readCommandShim?: (path: string) => string;
  resolveModule?: (specifier: string, paths: string[]) => string;
}

/** Resolve the public Dev Containers CLI entry point without a command shell. */
export function resolveDevcontainerInvocation({
  platform = process.platform,
  nodePath = process.execPath,
  environment = process.env,
  isRegularFile = isRegularWindowsFile,
  realpath = realpathSync,
  lstat = lstatSync,
  readCommandShim = (path) => readFileSync(path, 'utf8'),
  resolveCommand = resolveWindowsCommandFromPath(environment, isRegularFile),
  resolveModule = (specifier, paths) => createRequire(import.meta.url).resolve(specifier, { paths }),
}: DevcontainerResolverDependencies = {}): DevcontainerInvocation {
  if (platform !== 'win32') return { command: 'devcontainer', prefixArgs: [] };
  const commandPath = resolveCommand('devcontainer.cmd');
  if (!commandPath || !win32.isAbsolute(commandPath) || win32.basename(commandPath).toLowerCase() !== 'devcontainer.cmd') {
    throw new Error('Could not resolve devcontainer.cmd from PATH. Install @devcontainers/cli with the active npm prefix (or expose its devcontainer.cmd on PATH) before running Agent Containers.');
  }
  if (!isRegularFile(commandPath)) throw new Error(`Resolved devcontainer.cmd is not a regular command shim: ${commandPath}`);
  const commandPrefix = win32.dirname(commandPath);
  const expectedEntry = win32.join(commandPrefix, 'node_modules', '@devcontainers', 'cli', 'devcontainer.js');
  let shim: string;
  try {
    shim = readCommandShim(commandPath);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read the resolved devcontainer.cmd command shim: ${detail}`, { cause: error });
  }
  if (!referencesPublicDevcontainerEntry(shim)) {
    throw new Error(`Resolved devcontainer.cmd does not reference @devcontainers\\cli\\devcontainer.js: ${commandPath}`);
  }
  const paths = [win32.join(commandPrefix, 'node_modules')];
  let entryPoint: string;
  try {
    entryPoint = resolveModule('@devcontainers/cli/devcontainer.js', paths);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not locate @devcontainers/cli/devcontainer.js for the global npm Dev Containers installation: ${detail}`, { cause: error });
  }
  if (!sameWindowsPath(entryPoint, expectedEntry)) {
    throw new Error(`Resolved Dev Containers entry is not contained in the selected command shim npm prefix: ${entryPoint}`);
  }
  let physicalCommand: string;
  let physicalPrefix: string;
  let physicalEntry: string;
  try {
    if (!lstat(commandPath).isFile() || !lstat(entryPoint).isFile()) throw new Error('command shim or entry is not a regular file');
    physicalCommand = realpath(commandPath);
    physicalPrefix = realpath(commandPrefix);
    physicalEntry = realpath(entryPoint);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not physically resolve the selected Dev Containers command shim and entry: ${detail}`, { cause: error });
  }
  if (!isWindowsPathWithin(physicalCommand, physicalPrefix) || !isWindowsPathWithin(physicalEntry, physicalPrefix)) {
    throw new Error(`Resolved Dev Containers command shim or entry is not physically contained in the selected command shim npm prefix: ${entryPoint}`);
  }
  return { command: nodePath, prefixArgs: [entryPoint] };
}

function isRegularWindowsFile(path: string): boolean {
  try {
    const entry = lstatSync(path);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

function referencesPublicDevcontainerEntry(shim: string): boolean {
  return shim.replaceAll('/', '\\').toLowerCase().includes('node_modules\\@devcontainers\\cli\\devcontainer.js');
}

function sameWindowsPath(left: string, right: string): boolean {
  return win32.isAbsolute(left) && win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

function isWindowsPathWithin(path: string, prefix: string): boolean {
  const normalizedPath = win32.normalize(path).toLowerCase();
  const normalizedPrefix = win32.normalize(prefix).replace(/[\\/]+$/, '').toLowerCase();
  return normalizedPath.startsWith(`${normalizedPrefix}\\`);
}

function resolveWindowsCommandFromPath(environment: NodeJS.ProcessEnv, isRegularFile: (path: string) => boolean): (command: string) => string | undefined {
  return (command) => {
    const path = environment.Path ?? environment.PATH;
    if (!path) return undefined;
    for (const directory of path.split(';')) {
      if (!directory || !win32.isAbsolute(directory)) continue;
      const candidate = win32.join(directory, command);
      if (isRegularFile(candidate)) return candidate;
    }
    return undefined;
  };
}
