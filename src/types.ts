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

export interface ProcessRunOptions {
  cwd?: string;
  stdio?: 'inherit' | 'pipe';
  /** Aborts the active process, which is reaped before run() settles. */
  signal?: AbortSignal;
}

export interface ProcessRunner {
  run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessResult>;
}
