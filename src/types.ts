export interface LocalAgentContainersConfig {
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

export type BackendKind = 'local' | 'codespaces';
export type BackendSelection = BackendKind | 'both';
export type SetupState = 'ready' | 'action-required' | 'unsupported';
export type DoctorPhase = 'pre-provision' | 'provisioned-runtime';

/** Backend-neutral identities intentionally never overload local Docker fields. */
export type WorkspaceHandle =
  | { kind: 'local' }
  | { kind: 'codespaces'; id: string; name: string; environmentId: string };
export type WorkspaceObservation = { backend: BackendKind; state: string; observedAt: string };
export type CommandEvent =
  | { type: 'accepted' | 'started'; commandId: string }
  | { type: 'stdout' | 'stderr' | 'terminal'; commandId: string; offset: bigint; bytes: Uint8Array }
  | { type: 'exit'; commandId: string; code: number | null };
export interface ExecutionBackend {
  readonly kind: BackendKind;
  observe(handle: WorkspaceHandle, signal?: AbortSignal): Promise<WorkspaceObservation>;
  execute(handle: WorkspaceHandle, request: { commandId: string; argv: readonly [string, ...string[]] }, signal?: AbortSignal): AsyncIterable<CommandEvent>;
}

export interface CodespacesConfig {
  enabled: boolean;
  machine: string | null;
  geo: string;
  idleTimeoutMinutes: number;
  retentionPeriodMinutes: number;
  maxTotal: number;
  maxRunning: number;
  maxCreating: number;
  maxParallelCommandsPerWorkspace: number;
  readiness: { providerTimeoutSeconds: number; sshTimeoutSeconds: number; command: string[]; commandTimeoutSeconds: number };
  transport: { reconnectWindowSeconds: number; cancelGraceSeconds: number; remoteLogBytesPerStream: number; remoteLogRetentionHours: number };
  ports: { allowVisibilityChanges: boolean; allowPublic: boolean };
  secrets: { allowedRemoteSecretNames: string[]; allowCodespaceGitCredential: boolean };
}

export interface CodespacesAgentContainersConfig {
  version: 2;
  workspace: { worktreeRoot: string; baseBranch: string };
  project: { repository?: string; ref?: string; expectedOid?: string };
  environment: { devcontainerPath: string; devcontainerBlobOid?: string };
  backends: { enabled: BackendKind[]; default: BackendKind; local: Record<string, never>; codespaces: CodespacesConfig };
}

export type AgentContainersConfig = LocalAgentContainersConfig | CodespacesAgentContainersConfig;

export interface DoctorCheck {
  id: string;
  backend: BackendKind;
  phase: DoctorPhase;
  state: SetupState;
  summary: string;
  remediation: readonly string[];
  evidence?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DoctorReport {
  schemaVersion: 1;
  selectedBackends: readonly BackendKind[];
  overall: SetupState;
  checks: readonly DoctorCheck[];
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
