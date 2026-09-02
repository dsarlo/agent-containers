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
  /** Set only by runners that observed child close before resolving the result. */
  terminal?: true;
}

export interface ProcessOutputEvent {
  stream: 'stdout' | 'stderr';
  /** Incrementally decoded UTF-8 text from a pipe-mode child stream. */
  text: string;
}

export interface ProcessRunOptions {
  cwd?: string;
  stdio?: 'inherit' | 'pipe';
  /** UTF-8 input written to the child stdin before it is closed. */
  input?: string;
  /** Receives bounded, incrementally decoded pipe output without retaining it. */
  onOutput?: (event: ProcessOutputEvent) => void;
  /** Aborts the active process, which is reaped before run() settles. */
  signal?: AbortSignal;
  /** Lifecycle transports require a durable recovery boundary if local reaping is unconfirmed. */
  kind?: 'lifecycle' | 'readonly-probe';
}

export interface ProcessRunner {
  run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessResult>;
}
