# Experimental Codespaces v1

Agent Containers can run a coding-agent session in a GitHub Codespace instead of a local Dev Container. This backend is opt-in and experimental: set `AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES=1` for every Codespaces setup, lifecycle, readiness, and command operation.

The local harness remains the orchestrator. It retains its existing `gh` authentication and starts the agent command; Agent Containers does not prompt for, store, print, or modify GitHub tokens, SSH keys, API keys, or secret values.

## Prerequisites

- Node.js `>=20.19.0` and Agent Containers installed from source or a locally built package.
- GitHub CLI authenticated for the intended account: `gh auth status`.
- A repository with a committed image-based Dev Container file. v0.1 still rejects `dockerComposeFile`, `workspaceMount`, and `workspaceFolder`.
- A GitHub Codespaces-enabled repository and a selected Codespaces machine. Codespaces billing and account limits remain GitHub's responsibility.

## Configure an immutable backend

Use the interactive flow to create or update schema-v2 configuration:

```sh
export AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES=1
ac configure --interactive
ac validate
```

The saved configuration pins the GitHub repository, ref, resolved commit OID, and Dev Container blob OID. It also records nonsecret capacity, readiness, port, and named-secret policy. A minimal persisted shape is:

```yaml
version: 2
workspace:
  worktreeRoot: ../.agent-containers-worktrees
  baseBranch: main
project:
  repository: OWNER/REPOSITORY
  ref: refs/heads/main
  expectedOid: <40-hex-commit-oid>
environment:
  devcontainerPath: .devcontainer/devcontainer.json
  devcontainerBlobOid: <40-hex-blob-oid>
backends:
  enabled: [codespaces]
  default: codespaces
  local: {}
  codespaces:
    enabled: true
    machine: basicLinux32gb
    geo: auto
    idleTimeoutMinutes: 30
    retentionPeriodMinutes: 10080
    maxTotal: 4
    maxRunning: 2
    maxCreating: 1
    maxParallelCommandsPerWorkspace: 1
    readiness:
      providerTimeoutSeconds: 1200
      sshTimeoutSeconds: 120
      command: []
      commandTimeoutSeconds: 600
    transport:
      reconnectWindowSeconds: 60
      cancelGraceSeconds: 10
    ports:
      allowVisibilityChanges: false
      allowPublic: false
    secrets:
      allowedRemoteSecretNames: []
      allowCodespaceGitCredential: false
```

Do not invent the OIDs: interactive setup discovers and verifies them. For automation, import a nonsecret draft through `ac configure --non-interactive --from FILE --yes` or `--stdin --yes`; the explicit `--yes` accepts the displayed configuration preview, after Agent Containers resolves immutable evidence.

After `ac validate` accepts the saved schema-v2 configuration, run the read-only Codespaces diagnostic before a paid create:

```sh
ac doctor --backend codespaces --json
```

`doctor` uses read-only GitHub API checks. It does not retrieve a token, create a resource, start a Codespace, change ports or secrets, or upload a helper.

## Create a Codespaces-backed agent session

```sh
export AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES=1
ac create feature-work --backend codespaces --machine basicLinux32gb --geo auto --yes-cost
ac wait feature-work --for ready --timeout 20m
ac run feature-work -- opencode "Implement the requested feature"
```

`create` writes durable intent before the provider request and records only an exact GitHub identity readback. It never adopts an ambiguous resource by name. `wait` checks provider availability, immutable identity, ports, repository root/HEAD/origin over SSH, SSH reachability, and an optional configured readiness argv. A workspace with no configured readiness command is deliberately reported as `ready-without-setup-proof`; it is still eligible for execution after the immutable checks pass.

`run` and `exec` are aliases. They send the supplied argument vector over framed stdin to a package-owned helper; user argv is not interpolated into a remote shell command. Output is **connected-only**: CLI commands stream stdout/stderr to the caller and return the remote exit status, while an integration-selected PTY transport emits one merged terminal stream; none of those bytes are durably retained. On a verified cancellation the CLI returns `130`. A disconnected or otherwise unknown outcome remains a durable recovery/status record; later status recovery reports known state but never replays missing output.

## Lifecycle and cleanup

```sh
ac status feature-work --probe
ac reconcile feature-work
ac stop feature-work --yes
ac start feature-work --yes
ac wait feature-work --for ready --timeout 20m
ac remove feature-work --yes --force-remote-data-loss
```

`reconcile` is read-only. `start`, `stop`, and `remove` verify the recorded authenticated actor and immutable Codespace identity before mutation and read state back afterward. Capacity is coordinated conservatively within the local state root. A stop is refused while a remote command may still be active or unknown.

Removal has two separate acknowledgements because it deletes remote data. Before deletion, Agent Containers runs a repository-root Git preflight over SSH and refuses a dirty or unpushed checkout. The Codespace must therefore be running and ready: if it was stopped, run `ac start NAME --yes` followed by `ac wait NAME --for ready` before removal. Preserve or resolve remote Git state first. A successful removal writes a tombstone and verifies the exact Codespace is absent; ambiguous lifecycle outcomes remain fail-closed for operator investigation.

## Named-secret policy and output boundary

`allowedRemoteSecretNames` is an allowlist of environment-variable **names**, not values. Configure any corresponding GitHub Codespaces secret outside Agent Containers. The helper starts child commands with a minimal environment (`PATH` plus only allowlisted variables that exist) and redacts matching secret values from connected output frames. Secret values, raw argv, stdout/stderr/terminal bytes, and request/command hashes are not retained in Agent Containers' durable command state.

Treat an allowlisted name as a capability grant. Keep the allowlist minimal, never place a secret value in `.agent-containers.yml`, a command argument, or a diagnostic, and verify GitHub's own secret-scoping behavior in your environment.

## Recovery and limits

- A provider/SSH timeout or identity mismatch is not success. The record remains fail-closed; inspect it with `ac doctor --backend codespaces --workspace NAME` and `ac status NAME --probe` before taking further action.
- A record with a Codespaces lifecycle recovery barrier is intentionally blocked from `start`, `stop`, `reconcile`, and `remove`. `ac recover` and `ac unlock` are local-Dev-Container commands and do not clear it. v1 has no supported in-tool clearance for this barrier: do not edit state files to bypass it; preserve the exact remote/state evidence and resolve the incident outside the CLI. If the record remains normalized `ready`, command execution can still be possible, but lifecycle mutation remains blocked.
- Creation-log collection is diagnostic-only. If GitHub CLI does not support the log option used by the installed package, immutable readiness can still pass through the authoritative provider and SSH checks.
- Codespaces capacity is local-state-root scoped. Separate hosts cannot share an exact quota.
- This is not a sandbox. Review the target repository's Dev Container configuration, mounts, network access, and GitHub permissions before running an agent.
