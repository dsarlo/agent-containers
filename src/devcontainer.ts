import { createRequire } from 'node:module';
import { join } from 'node:path';

export interface DevcontainerInvocation {
  command: string;
  prefixArgs: string[];
}

export interface DevcontainerResolverDependencies {
  platform?: NodeJS.Platform;
  nodePath?: string;
  appData?: string;
  resolveModule?: (specifier: string, paths: string[]) => string;
}

/** Resolve the public Dev Containers CLI entry point without a command shell. */
export function resolveDevcontainerInvocation({
  platform = process.platform,
  nodePath = process.execPath,
  appData = process.env.APPDATA,
  resolveModule = (specifier, paths) => createRequire(import.meta.url).resolve(specifier, { paths }),
}: DevcontainerResolverDependencies = {}): DevcontainerInvocation {
  if (platform !== 'win32') return { command: 'devcontainer', prefixArgs: [] };
  const globalNodeModules = appData ? join(appData, 'npm', 'node_modules') : undefined;
  const paths = [globalNodeModules, join(nodePath, '..', 'node_modules')].filter((path): path is string => Boolean(path));
  let entryPoint: string;
  try {
    entryPoint = resolveModule('@devcontainers/cli/devcontainer.js', paths);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not locate @devcontainers/cli/devcontainer.js for the global npm Dev Containers installation: ${detail}`, { cause: error });
  }
  return { command: nodePath, prefixArgs: [entryPoint] };
}
