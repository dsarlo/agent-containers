import { GhCodespacesProvider } from './codespaces.js';
import type { AgentContainersConfig, BackendKind, BackendSelection, DoctorCheck, DoctorReport, ProcessRunner, SetupState } from './types.js';

export async function doctor(config: AgentContainersConfig, selection: BackendSelection, runner: ProcessRunner): Promise<DoctorReport> {
  const selectedBackends = select(config, selection);
  const checks: DoctorCheck[] = [];
  for (const backend of selectedBackends) {
    if (backend === 'local') checks.push(localCheck());
    else checks.push(...await codespacesChecks(config, runner));
  }
  return { schemaVersion: 1, selectedBackends, overall: overall(checks), checks };
}

function select(config: AgentContainersConfig, selection: BackendSelection): BackendKind[] {
  const enabled: BackendKind[] = config.version === 1 ? ['local'] : config.backends.enabled;
  if (selection === 'both') return enabled;
  if (!enabled.includes(selection)) throw new Error(`Backend ${selection} is not enabled by this configuration.`);
  return [selection];
}
function localCheck(): DoctorCheck { return { id: 'local.runtime.workspace', backend: 'local', phase: 'provisioned-runtime', state: 'action-required', summary: 'No exact recorded local workspace was supplied for runtime diagnosis.', remediation: ['Create or select a local workspace explicitly.', 'Run ac doctor --backend local again.'] }; }
async function codespacesChecks(config: AgentContainersConfig, runner: ProcessRunner): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const version = await runner.run('gh', ['--version']);
  checks.push(version.code === 0 ? ready('codespaces.gh', 'GitHub CLI is available.') : action('codespaces.gh', 'GitHub CLI is unavailable.', ['Install a supported gh CLI.', 'Run ac doctor --backend codespaces again.']));
  const v2 = config.version === 2 ? config : undefined;
  if (version.code === 0) {
    try { const actor = await new GhCodespacesProvider(runner).actor(); checks.push({ ...ready('codespaces.actor', 'Authenticated GitHub actor was read successfully.'), evidence: { actorId: actor.id, actorLogin: actor.login } }); }
    catch { checks.push(action('codespaces.actor', 'GitHub actor cannot be read through the read-only API.', ['Authenticate gh with Codespaces access.', 'Run ac doctor --backend codespaces again.'])); }
  } else checks.push(action('codespaces.actor', 'GitHub actor cannot be checked until gh is installed.', ['Install a supported gh CLI.', 'Run ac doctor --backend codespaces again.']));
  const repository = v2?.project.repository;
  const ref = v2?.project.ref;
  checks.push(repository ? ready('codespaces.repository', `GitHub repository ${repository} is explicitly configured.`) : action('codespaces.repository', 'No GitHub repository is configured.', ['Set project.repository to OWNER/REPOSITORY with ac configure.', 'Run ac doctor --backend codespaces again.']));
  checks.push(ref ? ready('codespaces.ref', `Remote ref ${ref} is explicitly configured.`) : action('codespaces.ref', 'No remotely resolvable Git ref is configured.', ['Set project.ref to a remote branch or commit with ac configure.', 'Run ac doctor --backend codespaces again.']));
  checks.push(v2 ? ready('codespaces.devcontainer', `Committed Dev Container path ${v2.environment.devcontainerPath} is configured.`) : action('codespaces.devcontainer', 'Schema v2 is required for Codespaces.', ['Run ac init --backends codespaces or ac configure with a schema-v2 file.', 'Run ac doctor --backend codespaces again.']));
  if (version.code === 0 && repository) {
    try {
      const preflight = await new GhCodespacesProvider(runner).preflight(repository, ref);
      if (!validPreflight(preflight)) throw new Error('preflight schema is incomplete');
      checks.push(ready('codespaces.preflight', 'GitHub Codespaces preflight is readable.'));
    } catch {
      checks.push(action('codespaces.preflight', 'GitHub Codespaces preflight could not be read.', ['Verify repository access and Codespaces policy with gh.', 'Run ac doctor --backend codespaces again.']));
    }
  } else checks.push(action('codespaces.preflight', 'GitHub Codespaces preflight requires gh and an explicit repository.', ['Configure gh and project.repository.', 'Run ac doctor --backend codespaces again.']));
  if (!v2?.backends.codespaces.machine) checks.push(action('codespaces.machine', 'No explicit Codespaces machine is configured.', ['Use ac configure to select a machine from provider preflight.', 'Run ac doctor --backend codespaces again.']));
  else checks.push(ready('codespaces.machine', `Explicit Codespaces machine ${v2.backends.codespaces.machine} is configured.`));
  checks.push(action('codespaces.ssh-key', 'A pre-existing SSH key/config is required later for Codespaces transport and was not inspected.', ['Provide a suitable existing SSH key/config before explicit transport.', 'Run ac doctor --backend codespaces again.']));
  checks.push({ id: 'codespaces.runtime.workspace', backend: 'codespaces', phase: 'provisioned-runtime', state: 'action-required', summary: 'No exact recorded running Codespace was supplied; runtime checks were not performed.', remediation: ['Codespaces lifecycle is not implemented in this release.', 'Run ac doctor --backend codespaces again after enabling a future lifecycle release.'] });
  const preflightReady = checks.some((check) => check.id === 'codespaces.preflight' && check.state === 'ready');
  for (const id of ['codespaces.repository', 'codespaces.ref', 'codespaces.devcontainer']) {
    const index = checks.findIndex((check) => check.id === id);
    if (index >= 0 && checks[index].state === 'ready' && !preflightReady) checks[index] = action(id, `${checks[index].summary} Provider validation is still required.`, ['Fix Codespaces preflight access and configuration.', 'Run ac doctor --backend codespaces again.']);
  }
  return checks;
}
function validPreflight(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    'billable_owner' in value && typeof (value as { billable_owner?: unknown }).billable_owner === 'object';
}
function ready(id: string, summary: string): DoctorCheck { return { id, backend: 'codespaces', phase: 'pre-provision', state: 'ready', summary, remediation: [] }; }
function action(id: string, summary: string, remediation: string[]): DoctorCheck { return { id, backend: 'codespaces', phase: 'pre-provision', state: 'action-required', summary, remediation }; }
function overall(checks: readonly DoctorCheck[]): SetupState { return checks.some((check) => check.state === 'unsupported') ? 'unsupported' : checks.some((check) => check.state === 'action-required') ? 'action-required' : 'ready'; }
