import { resolveDevcontainerInvocation, type DevcontainerInvocation } from './devcontainer.js';

export interface ProbeResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
}

export type CommandProbe = (command: string, args: string[]) => ProbeResult;

export interface LiveIntegrationDependencies {
  resolveDevcontainerInvocation?: () => DevcontainerInvocation;
}

export interface LiveIntegrationPrerequisites {
  gitAvailable: boolean;
  dockerAvailable: boolean;
  devcontainerAvailable: boolean;
  relativeWorktreeSupported: boolean;
}

export function isLiveIntegrationEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.AGENT_CONTAINERS_REQUIRE_LIVE_INTEGRATION === '1';
}

/** Probe host tools only for an explicitly requested live integration run. */
export function probeLiveIntegrationPrerequisites(environment: NodeJS.ProcessEnv = process.env, probe: CommandProbe, { resolveDevcontainerInvocation: resolveInvocation = resolveDevcontainerInvocation }: LiveIntegrationDependencies = {}): LiveIntegrationPrerequisites {
  const gitAvailable = probe('git', ['--version']).status === 0;
  const help = gitAvailable ? probe('git', ['worktree', 'add', '-h']) : undefined;
  const relativeWorktreeSupported = gitAvailable && /(?:^|\s)--(?:\[no-\])?relative-paths(?=\s|$)/m.test(`${help?.stdout ?? ''}${help?.stderr ?? ''}`);
  if (!isLiveIntegrationEnabled(environment)) {
    return { gitAvailable, dockerAvailable: false, devcontainerAvailable: false, relativeWorktreeSupported };
  }
  const dockerAvailable = probe('docker', ['version']).status === 0;
  const devcontainer = resolveInvocation();
  const devcontainerAvailable = probe(devcontainer.command, [...devcontainer.prefixArgs, '--version']).status === 0;
  return { gitAvailable, dockerAvailable, devcontainerAvailable, relativeWorktreeSupported };
}
