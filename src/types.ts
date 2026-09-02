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

/** Independently observable readiness gate as yielded by the Codespaces backend. */
export interface ReadinessGateResult {
  id: string;
  state: 'passed' | 'blocked' | 'timeout' | 'skipped';
  observedAt: string;
  detail: string;
  timeoutMs: number | null;
}
export interface ReadinessReport {
  terminal: string;
  workspaceId: string;
  name: string;
  gates: readonly ReadinessGateResult[];
  startedAt: string;
}
export interface ReadinessEvent { type: 'readiness'; report: ReadinessReport }

/** Backend-neutral identities intentionally never overload local Docker fields. */
export type WorkspaceHandle =
  | { kind: 'local' }
  | { kind: 'codespaces'; id: string; name: string; environmentId: string };
export type WorkspaceObservation = { backend: BackendKind; state: string; observedAt: string };
export type CommandEvent =
  | { type: 'accepted' | 'started'; commandId: string }
  | { type: 'stdout' | 'stderr' | 'terminal'; commandId: string; offset: bigint; bytes: Uint8Array }
  | { type: 'exit'; commandId: string; code: number | null }
  | { type: 'rejected'; commandId: string; reason: string }
  | { type: 'detached'; commandId: string; offsets: { stdout: bigint; stderr: bigint; terminal: bigint } }
  | { type: 'cancelled'; commandId: string }
  | { type: 'cancel-unknown'; commandId: string };

/** Remote command request surfaces for the Codespaces backend. */
export interface RemoteCommandRequest {
  commandId: string;
  argv: readonly [string, ...string[]];
  mode?: 'pipe' | 'pty';
  cwd?: string;
  stdin?: 'closed' | 'stream';
  cols?: number;
  rows?: number;
}

export interface ExecutionBackend {
  readonly kind: BackendKind;
  create(request: { name: string; backend: BackendKind }, signal?: AbortSignal): Promise<WorkspaceHandle>;
  observe(handle: WorkspaceHandle, signal?: AbortSignal): Promise<WorkspaceObservation>;
  waitReady(handle: WorkspaceHandle, signal?: AbortSignal): AsyncIterable<WorkspaceObservation | ReadinessEvent>;
  execute(handle: WorkspaceHandle, request: RemoteCommandRequest, signal?: AbortSignal): AsyncIterable<CommandEvent>;
  attach(handle: WorkspaceHandle, commandId: string, signal?: AbortSignal): AsyncIterable<CommandEvent>;
  cancel(handle: WorkspaceHandle, commandId: string, signal?: AbortSignal): Promise<void>;
  recover(handle: WorkspaceHandle, signal?: AbortSignal): Promise<void>;
  remove(handle: WorkspaceHandle, signal?: AbortSignal): Promise<void>;
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
  /** Raw binary input written to the child stdin before it is closed. */
  binaryInput?: Uint8Array | Buffer;
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
