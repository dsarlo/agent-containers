import { GhCodespacesProvider } from './codespaces.js';
import { parseConfig } from './config.js';
import { loadMetadata } from './state.js';
import type { AgentContainersConfig, BackendKind, BackendSelection, DoctorCheck, DoctorReport, ProcessResult, ProcessRunner, SetupState } from './types.js';

export interface CodespacesSetupEvidence { repository: string; requestedRef: string; expectedOid: string; devcontainerPath: string; devcontainerBlobOid: string }
export interface DoctorOptions { abortSignal?: AbortSignal; timeoutMs?: number; stateDir?: string; workspaceName?: string }
export interface DiscoveredProjectSetup { repository: string; ref: string; devcontainerPath: string }

/** Discover only immutable Git-tree inputs suitable for first-project setup. */
export async function discoverProjectSetup(root: string, runner: ProcessRunner): Promise<DiscoveredProjectSetup> {
  const remote = await runner.run('git', ['remote', 'get-url', 'origin'], { cwd: root });
  const repository = remote.code === 0 ? canonicalGithubRepository(remote.stdout.trim()) : undefined;
  if (!repository) throw new Error('A canonical github.com origin remote is required for Codespaces discovery.');
  const head = await runner.run('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: root });
  const branch = head.code === 0 ? /^origin\/([A-Za-z0-9._/-]+)$/.exec(head.stdout.trim())?.[1] : undefined;
  if (!branch || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) throw new Error('A safe origin default branch is required for Codespaces discovery.');
  const ref = `refs/heads/${branch}`;
  const tree = await runner.run('git', ['ls-tree', '-r', '-z', ref], { cwd: root });
  if (tree.code !== 0) throw new Error(`Could not read committed Git tree for ${ref}.`);
  const candidates = tree.stdout.split('\0').flatMap((entry) => {
    const match = /^(100644|100755) blob [0-9a-f]{40,64}\t(.+)$/.exec(entry);
    if (!match || !isDevcontainerCandidate(match[2])) return [];
    return [match[2]];
  });
  if (candidates.length !== 1) throw new Error(candidates.length ? 'Codespaces discovery requires exactly one committed regular Dev Container candidate.' : 'Codespaces discovery found no committed regular Dev Container candidate.');
  return { repository, ref, devcontainerPath: candidates[0] };
}

function isDevcontainerCandidate(path: string): boolean {
  return path === '.devcontainer.json' || path === '.devcontainer/devcontainer.json' || /^\.devcontainer\/[^/]+\.json$/.test(path);
}

/** Read-only repository discovery used by init, configure, and doctor. */
export async function validateCodespacesSetup(config: AgentContainersConfig, root: string, runner: ProcessRunner): Promise<CodespacesSetupEvidence> {
  if (config.version !== 2 || !config.backends.enabled.includes('codespaces') || !config.project.repository || !config.project.ref) throw new Error('Codespaces requires an explicit repository and remotely resolvable ref.');
  const remote = await runner.run('git', ['remote', 'get-url', 'origin'], { cwd: root });
  if (remote.code !== 0) throw new Error('No origin remote is configured; explicitly configure the GitHub repository before enabling Codespaces.');
  const discovered = canonicalGithubRepository(remote.stdout.trim());
  if (!discovered || discovered.toLowerCase() !== config.project.repository.toLowerCase()) throw new Error('Configured repository does not match a canonical github.com origin.');
  const provider = new GhCodespacesProvider(runner);
  let expectedOid: string;
  try { expectedOid = await provider.resolveRef(config.project.repository, config.project.ref); }
  catch { throw new Error(`Requested ref ${config.project.ref} is not available to Codespaces; push it to ${config.project.repository} or select a remote ref.`); }
  const devcontainerBlobOid = await provider.committedDevcontainerBlob(config.project.repository, expectedOid, config.environment.devcontainerPath);
  return { repository: config.project.repository, requestedRef: config.project.ref, expectedOid, devcontainerPath: config.environment.devcontainerPath, devcontainerBlobOid };
}

function canonicalGithubRepository(remote: string): string | undefined {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote)?.[1];
}

/** A bounded, shell-free diagnostic report. Every runner failure becomes a check result. */
export async function doctor(config: AgentContainersConfig, selection: BackendSelection, runner: ProcessRunner, root = process.cwd(), options: DoctorOptions = {}): Promise<DoctorReport> {
  let validated: AgentContainersConfig;
  try {
    // Doctor is an observational boundary. Validate even embedding-provided
    // objects so malformed data cannot prevent a useful diagnostic report.
    validated = parseConfig(JSON.stringify(config));
  } catch {
    return { schemaVersion: 1, selectedBackends: [], overall: 'action-required', checks: [configurationAction()] };
  }
  let selectedBackends: BackendKind[];
  try {
    selectedBackends = select(validated, selection);
  } catch {
    return { schemaVersion: 1, selectedBackends: [], overall: 'action-required', checks: [configurationAction()] };
  }
  const safeRunner = boundedRunner(runner, options);
  const checks: DoctorCheck[] = [];
  for (const backend of selectedBackends) checks.push(...(backend === 'local' ? await localChecks(validated, safeRunner, root, options) : await codespacesChecks(validated, safeRunner, root)));
  return { schemaVersion: 1, selectedBackends, overall: overall(checks), checks };
}
function configurationAction(): DoctorCheck {
  return { id: 'configuration', backend: 'local', phase: 'pre-provision', state: 'action-required', summary: 'Configuration is missing, malformed, or inconsistent; no runtime probes were attempted.', remediation: ['Correct the strict Agent Containers configuration.', 'Run ac doctor again.'] };
}
function select(config: AgentContainersConfig, selection: BackendSelection): BackendKind[] {
  const enabled: BackendKind[] = config.version === 1 ? ['local'] : config.backends.enabled;
  if (selection === 'both') return enabled;
  if (!enabled.includes(selection)) throw new Error(`Backend ${selection} is not enabled by this configuration.`);
  return [selection];
}
async function localChecks(config: AgentContainersConfig, runner: ProcessRunner, root: string, options: DoctorOptions): Promise<DoctorCheck[]> {
  const git = await attempt(runner, 'git', ['--version'], root);
  const repository = await attempt(runner, 'git', ['rev-parse', '--is-inside-work-tree'], root);
  const worktree = await attempt(runner, 'git', ['worktree', 'add', '-h'], root);
  const docker = await attempt(runner, 'docker', ['--version'], root);
  const devcontainer = await attempt(runner, 'devcontainer', ['--version'], root);
  const configured = config.version === 1 || config.backends.enabled.includes('local');
  const workspaceChecks: DoctorCheck[] = [];
  if (options.workspaceName && options.stateDir) {
    const metadata = await attemptValue(() => loadMetadata(options.stateDir!, options.workspaceName!));
    if (!metadata) workspaceChecks.push(action('local.workspace.metadata', `No local workspace metadata exists for ${options.workspaceName}.`, 'provisioned-runtime'));
    else if (!('repoRoot' in metadata)) workspaceChecks.push(action('local.workspace.metadata', `Workspace ${options.workspaceName} belongs to the phase-gated Codespaces backend.`, 'provisioned-runtime'));
    else {
      workspaceChecks.push({ ...ready('local.workspace.metadata', `Local workspace metadata for ${options.workspaceName} is valid.`), phase: 'provisioned-runtime' });
      if (!metadata.containerId) workspaceChecks.push(action('local.workspace.runtime', 'Local workspace is stopped; no recorded Dev Container is running.', 'provisioned-runtime'));
      else {
        const inspected = await attempt(runner, 'docker', ['inspect', '--format', '{{.State.Running}}', metadata.containerId], root);
        workspaceChecks.push(inspected?.code === 0 && inspected.stdout.trim() === 'true'
          ? { ...ready('local.workspace.runtime', `Recorded Dev Container ${metadata.containerId} is running.`), phase: 'provisioned-runtime' }
          : action('local.workspace.runtime', `Recorded Dev Container ${metadata.containerId} is stopped or cannot be inspected.`, 'provisioned-runtime'));
      }
    }
  }
  return [
    result('local.os', process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux', 'Host OS is supported.', 'Host OS is unsupported.'),
    result('local.git', git?.code === 0, 'Git is available.', 'Git is unavailable.'),
    result('local.repository', repository?.code === 0 && repository.stdout.trim() === 'true', 'Git repository is available.', 'Git repository cannot be verified.'),
    result('local.worktree', Boolean(worktree && (worktree.code === 0 || worktree.code === 129) && /relative-paths/.test(`${worktree.stdout}${worktree.stderr}`)), 'Git worktree relative paths are supported.', 'Git worktree relative paths are unsupported.'),
    result('local.docker', docker?.code === 0, 'Docker is available.', 'Docker is unavailable.'),
    result('local.devcontainers', devcontainer?.code === 0, 'Dev Containers CLI is available.', 'Dev Containers CLI is unavailable.'),
    result('local.config', configured, 'Local backend is enabled by configuration.', 'Local backend is disabled by configuration.'),
    { id: 'local.state.durability', backend: 'local', phase: 'pre-provision', state: 'action-required', summary: 'Durability is verified at lifecycle publication time; doctor does not write state.', remediation: ['Run a lifecycle command with the packaged native durability addon.'] },
    ...workspaceChecks,
  ];
}
async function codespacesChecks(config: AgentContainersConfig, runner: ProcessRunner, root: string): Promise<DoctorCheck[]> {
  const v2 = config.version === 2 ? config : undefined;
  const gh = await attempt(runner, 'gh', ['--version'], root);
  const ghReady = gh?.code === 0;
  const provider = new GhCodespacesProvider(runner);
  const actor = ghReady ? await attemptValue(() => provider.actor()) : undefined;
  const source = ghReady && v2 ? await attemptValue(() => validateCodespacesSetup(config, root, runner)) : undefined;
  const machines = ghReady && v2?.project.repository && v2.project.ref ? await attemptValue(() => provider.machines(v2.project.repository!, v2.project.ref!)) : undefined;
  const defaults = ghReady && v2?.project.repository && v2.project.ref ? await attemptValue(() => provider.defaults(v2.project.repository!, v2.project.ref!)) : undefined;
  const selected = v2?.backends.codespaces.machine;
  const selectedMachine = machines?.machines.find((machine) => machine.name === selected);
  const geoEligible = !v2 || v2.backends.codespaces.geo === 'auto'
    ? Boolean(selectedMachine && defaults?.location)
    : Boolean(selectedMachine && await attemptValue(async () => (await provider.machines(v2.project.repository!, v2.project.ref!, v2.backends.codespaces.geo)).machines.some((machine) => machine.name === selected)));
  return [
    result('codespaces.experimental', process.env.AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES === '1', 'Experimental Codespaces gate is enabled.', 'Set AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES=1.'),
    result('codespaces.gh', ghReady, 'GitHub CLI is available.', 'GitHub CLI is unavailable.'),
    actor ? { ...ready('codespaces.actor', 'Authenticated GitHub actor was read successfully.'), evidence: { actorId: actor.id, actorLogin: actor.login } } : action('codespaces.actor', 'GitHub actor cannot be read through the read-only API.'),
    source ? { ...ready('codespaces.repository', `GitHub repository ${source.repository} was verified from origin.`), evidence: { repository: source.repository } } : action('codespaces.repository', 'GitHub repository identity is not verified from the configured origin.'),
    source && source.expectedOid === v2?.project.expectedOid ? { ...ready('codespaces.ref', `Remote ref resolves to immutable ${source.expectedOid}.`), evidence: { expectedOid: source.expectedOid } } : action('codespaces.ref', source ? 'Configured expected OID has drifted; review and save fresh immutable source evidence.' : 'No remotely resolvable Git ref/OID evidence is available.'),
    source && source.devcontainerBlobOid === v2?.environment.devcontainerBlobOid ? { ...ready('codespaces.devcontainer', 'Committed regular Dev Container blob was verified.'), evidence: { devcontainerBlobOid: source.devcontainerBlobOid } } : action('codespaces.devcontainer', source ? 'Configured Dev Container blob has drifted; review and save fresh source evidence.' : 'Dev Container path is not verified as a committed regular file.'),
    defaults ? { ...ready('codespaces.owner-billing', 'Documented default billable owner and location were read.'), evidence: { billableOwner: defaults.billableOwner.login, defaultLocation: defaults.location, defaultDevcontainerPath: defaults.devcontainerPath } } : action('codespaces.owner-billing', 'Documented default billable owner and location could not be read.'),
    result('codespaces.machine', Boolean(selectedMachine), 'Configured machine appears in provider inventory.', 'Configured machine is absent from provider inventory.'),
    result('codespaces.geo', Boolean(geoEligible), v2?.backends.codespaces.geo === 'auto' ? 'geo:auto uses the documented default location.' : 'Configured geo is eligible for selected machine.', 'Configured geo is not eligible for selected machine.'),
    action('codespaces.ports', 'Port policy is unavailable because no documented read-only endpoint proves it.'),
    action('codespaces.secrets', 'Secret policy is unavailable because no documented read-only endpoint proves it.'),
    action('codespaces.ssh-key', 'A pre-existing SSH key/config is required later and was not inspected.'),
  ];
}
function boundedRunner(runner: ProcessRunner, options: DoctorOptions): ProcessRunner {
  return { run: async (command, args, runOptions) => {
    if (options.abortSignal?.aborted) throw new Error('Doctor operation aborted.');
    const controller = new AbortController();
    const relay = () => controller.abort();
    let timer: NodeJS.Timeout | undefined;
    options.abortSignal?.addEventListener('abort', relay, { once: true });
    try {
      const operation = runner.run(command, args, { ...runOptions, signal: controller.signal });
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Doctor operation timed out.')); }, options.timeoutMs ?? 5_000); });
       return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      options.abortSignal?.removeEventListener('abort', relay);
    }
  } };
}
async function attempt(runner: ProcessRunner, command: string, args: string[], cwd: string): Promise<ProcessResult | undefined> { try { return await runner.run(command, args, { cwd }); } catch { return undefined; } }
async function attemptValue<T>(operation: () => Promise<T>): Promise<T | undefined> { try { return await operation(); } catch { return undefined; } }
function result(id: string, ok: boolean, yes: string, no: string): DoctorCheck { return ok ? ready(id, yes) : action(id, no); }
function ready(id: string, summary: string): DoctorCheck { return { id, backend: id.startsWith('local.') ? 'local' : 'codespaces', phase: 'pre-provision', state: 'ready', summary, remediation: [] }; }
function action(id: string, summary: string, phase: 'pre-provision' | 'provisioned-runtime' = 'pre-provision'): DoctorCheck { return { id, backend: id.startsWith('local.') ? 'local' : 'codespaces', phase, state: 'action-required', summary, remediation: [`Correct ${id} prerequisite.`, `Run ac doctor --backend ${id.startsWith('local.') ? 'local' : 'codespaces'} again.`] }; }
function overall(checks: readonly DoctorCheck[]): SetupState { return checks.some((check) => check.state === 'unsupported') ? 'unsupported' : checks.some((check) => check.state === 'action-required') ? 'action-required' : 'ready'; }
