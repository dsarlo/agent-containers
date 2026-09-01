# Configuration reference

Agent Containers reads `.agent-containers.yml` from the current repository for `create`. Use `agent-containers validate` before creating workspaces; `agent-containers validate --config path` checks another file.

```yaml
version: 1
workspace:
  worktreeRoot: ../.agent-containers-worktrees
  baseBranch: main
environment:
  devcontainerPath: .devcontainer/devcontainer.json
commands:
  test: npm test
```

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `version` | No | `1` | Only version `1` is accepted. |
| `workspace.worktreeRoot` | No | `../.agent-containers-worktrees` | Parent for named worktrees; relative paths resolve from the Git root. |
| `workspace.baseBranch` | No | `main` | Base used by `agent-containers create` unless `--base` is supplied. |
| `environment.devcontainerPath` | No | `.devcontainer/devcontainer.json` | Safe repository-relative Dev Container **regular file**; Git symlinks are rejected and runtime refuses a resolved path outside the worktree. Both `validate` and `create` require it on `workspace.baseBranch`; `create --base` requires it on that effective local base too, all before any worktree side effect. |
| `commands` | No | `{}` | Optional named, non-empty strings for people and agents to discover; never executed by Agent Containers. |

Defaults are merged before validation. Supplied empty values, wrong types, unknown keys, or non-mapping root/section values are errors.

## Schema v2 Codespaces setup

Schema v1 remains local-only and unchanged. Schema v2 is experimental and requires `AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES=1`. Use `ac init --interactive` or `ac configure --interactive` for the field-oriented setup flow, or import a v2 onboarding draft with `--non-interactive --from FILE` / `--stdin`. Drafts omit only discovered OID/blob evidence; persisted v2 documents always contain it. It is a nonsecret policy document: unknown fields, public ports, invalid paths, and invalid limits are rejected before any side effect.

Interactive setup prompts for backend/default backend, repository, remote ref, Dev Container path, machine, and cost-sensitive timeouts. It shows the preview and requires `yes`; `cancel` or any other confirmation leaves no file write. It does not accept pasted configuration. Each Codespaces save validates the canonical GitHub origin, remote ref, immutable commit OID, and committed regular Dev Container blob through read-only `git`/`gh api GET` calls, then persists `project.expectedOid` and `environment.devcontainerBlobOid` as immutable source evidence. No configuration command accepts, displays, stores, or reads tokens, API keys, SSH keys, or secret values. Codespaces lifecycle is intentionally unavailable in this release.

```yaml
version: 2
workspace:
  worktreeRoot: ../.agent-containers-worktrees
  baseBranch: main
project:
  repository: OWNER/REPOSITORY
  ref: refs/heads/main
  expectedOid: '0123456789012345678901234567890123456789'
environment:
  devcontainerPath: .devcontainer/devcontainer.json
  devcontainerBlobOid: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd'
backends:
  enabled: [codespaces]
  default: codespaces
  local: {}
  codespaces:
    enabled: true
    machine: null # Required later before any paid create operation.
    geo: auto
    idleTimeoutMinutes: 30
    retentionPeriodMinutes: 10080
    maxTotal: 4
    maxRunning: 2
    maxCreating: 1
    maxParallelCommandsPerWorkspace: 1
    readiness: { providerTimeoutSeconds: 1200, sshTimeoutSeconds: 120, command: [], commandTimeoutSeconds: 600 }
    transport: { reconnectWindowSeconds: 60, cancelGraceSeconds: 10, remoteLogBytesPerStream: 67108864, remoteLogRetentionHours: 168 }
    ports: { allowVisibilityChanges: false, allowPublic: false }
    secrets: { allowedRemoteSecretNames: [], allowCodespaceGitCredential: false }
```

`ac doctor --backend local|codespaces|all [--json]` is noninteractive and read-only. Local-only configurations do not require the Codespaces gate; a selected Codespaces diagnostic requires `AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES=1`. Its Codespaces provider calls are pinned-version, machine-readable `gh api` GET requests only. Machine availability uses GitHub's documented repository machine inventory endpoint. Owner/billing, port, secret, and runtime facts are action-required when no documented read-only endpoint proves them. It never retrieves a token, alters authentication, creates an SSH key, changes a resource/configuration/secret/port, or starts a Codespace.

## v0.1 Dev Container compatibility

The referenced JSON/JSONC configuration must not define `dockerComposeFile`, `workspaceMount`, or `workspaceFolder`. These modes are intentionally unsupported in v0.1 because Agent Containers needs to control the worktree folder and mount for safe lifecycle cleanup. Comments and comment-like text inside JSON strings are accepted.

A `devcontainerPath` copied into a nested directory changes that configuration's relative base. In particular, `build.context` does not change how `build.dockerfile` resolves: point each field at the intended worktree-relative location, e.g. `"build": { "context": "..", "dockerfile": "../Dockerfile" }` for a configuration located one directory deeper than its Dockerfile.

Example one-off base:

```sh
ac create release-check --base release/next
```
