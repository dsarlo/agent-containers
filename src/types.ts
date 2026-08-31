export interface AgentContainersConfig {
  version: 1;
  workspace: {
    worktreeRoot: string;
    baseBranch: string;
  };
  environment: {
    devcontainerPath: string;
  };
  commands: Record<string, string>;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(command: string, args: string[], options?: { cwd?: string; stdio?: 'inherit' | 'pipe' }): Promise<ProcessResult>;
}
