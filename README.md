# Agent Containers

[![CI](https://github.com/dsarlo/agent-containers/actions/workflows/ci.yml/badge.svg)](https://github.com/dsarlo/agent-containers/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Agent Containers gives every coding task an isolated Git worktree and Dev Container runtime. It is deliberately agent-harness-agnostic: use it with Claude Code, Codex, OpenCode, a shell script, or plain test commands.

## Status

**v0.1 is source-installable but is not published to npm and no release has been published.** The package metadata reserves `@dsarlo/agent-containers`; do not expect `npm install @dsarlo/agent-containers` to work until a public package is announced.

## Prerequisites

- Node.js 20.19 or newer
- A Node-API build toolchain for source installation: Python 3 and a C++ compiler/toolchain supported by `node-gyp` (for example, Xcode Command Line Tools on macOS or Visual Studio C++ Build Tools on Windows)
- Git whose `git worktree add -h` lists `--relative-paths` or `--[no-]relative-paths`
- Docker and the Dev Containers CLI (`npm install -g @devcontainers/cli`) for `exec` and `run`
- A repository with a simple image-based Dev Container configuration committed on the configured base branch

## Install from source

```sh
git clone https://github.com/dsarlo/agent-containers.git
cd agent-containers
npm ci
npm run build:native
npm run build
npm link
```

The provided executable names are `agent-containers` and the short alias `ac`. `npm link` registers those bins with the Node installation active at link time. In repositories using asdf, Volta, or another version manager, use a Node version satisfying Agent Containers' `>=20.19.0` engine and make it available to the target project's shell before invoking `ac`; otherwise that manager may reject the linked bin before Agent Containers runs.

## Agent skill

The package also includes an agent-facing usage skill at [`skills/agent-containers/SKILL.md`](skills/agent-containers/SKILL.md). Agents can load or copy that definition to follow the supported lifecycle, isolation, and recovery contract rather than inferring command behavior.

## Quick start

Run these from a Git repository:

```sh
ac init
# Commit the Dev Container configuration on the configured base branch, then edit .agent-containers.yml if needed.
ac validate
ac create search-page
ac run search-page -- npm test
ac status search-page
ac remove search-page --yes
```

`create` creates `agent-containers/<name>` and an isolated worktree without modifying tracked files in the source checkout. `run` starts the worktree's Dev Container and executes the argument vector in it.

## Configuration

Plain `ac init` writes a safe schema-v2 local-only `.agent-containers.yml`. Existing configuration is never overwritten by init; use `ac configure` to preview and atomically publish a reviewed update. `workspace.worktreeRoot` resolves from the source Git root. `environment.devcontainerPath` must be a safe repository-relative path because it is verified against, and resolved inside, each worktree.

```yaml
# Agent Containers workspace configuration, schema version 1
version: 1
workspace:
  worktreeRoot: ../.agent-containers-worktrees
  baseBranch: main
environment:
  devcontainerPath: .devcontainer/devcontainer.json
commands:
  test: npm test
  lint: npm run lint
```

The defaults are `version: 1`, `workspace.worktreeRoot: ../.agent-containers-worktrees`, `workspace.baseBranch: main`, and `environment.devcontainerPath: .devcontainer/devcontainer.json`. `commands` is descriptive only; Agent Containers never evaluates these command strings. `devcontainerPath` is a safe repository-relative **regular file** (symlinks are rejected): it resolves within each worktree, and both `validate` and `create` require it to be tracked on `baseBranch`. When `create --base <branch>` is used, the same file must also be tracked on that effective local base before any worktree side effect. An untracked configuration in the source checkout does not appear in a new worktree. `.agent-containers.yml` itself is read from the primary Git root and may remain untracked. If you place a copied `devcontainer.json` in a deeper directory, remember that `build.context` and `build.dockerfile` resolve independently relative to that config; for example use `"build": { "context": "..", "dockerfile": "../Dockerfile" }` when appropriate. See the [configuration reference](docs/configuration.md).

### Experimental Codespaces setup

Schema v2 introduces an experimental, opt-in Codespaces configuration surface without changing local v1 behavior. `ac init --interactive` can also create a local-only v2 configuration; selecting Codespaces or both requires `AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES=1`. The field-oriented flow collects all nonsecret setup policy and validates immutable Codespaces source evidence before it previews the exact object requiring confirmation. Noninteractive imports accept a legitimate v2 draft through `--non-interactive --from <file>` or `--stdin`, then derive the same evidence before persistence. No tokens, provider keys, SSH keys, secret values, or GitHub authentication are accepted, displayed, or persisted. Experimental Codespaces creation (`ac create --backend codespaces --yes-cost`) and readiness (`ac wait <name> --for ready`) are implemented; command transport and lifecycle mutations remain phase-gated.

`ac doctor --backend local|codespaces|all [--json]` is read-only. Codespaces diagnosis also requires `AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES=1`. It uses `gh --version` and machine-readable GET API identity/preflight checks with a pinned GitHub API version, never calls `gh auth token`, creates a key, prompts, creates or starts a Codespace, uploads a helper, or changes ports/secrets/configuration. It explicitly reports runtime checks as action-required until an exact recorded running workspace can be safely assessed.

Experimental Codespaces creation is implemented with a fail-closed, no-adoption contract: a durable create-intent journal precedes any provider call, an exact actor/repository/ref identity readback follows dispatch, and truncated, timed-out (before or after the single POST), or actor-changed responses quarantine the record for manual recovery instead of adopting an unverified resource. Capacity is conservative and durable: at most `maxCreating` creating, `maxRunning` running, and `maxTotal` total per state root, and a settled readiness observation persists back to the record so slots free up. `ac wait <name> --for ready [--timeout <duration>]` runs individually observable, bounded gates (repository identity, SSH probe, optional configured runtime argv, creation logs) and never starts or restores a stopped Codespace. All provider traffic uses argv-framed `gh api GET`/create calls with no token handling. Command transport (SSH execution, streaming, cancellation) is the next gated phase; remove/rebuild of live Codespaces and live E2E remain separately gated.

## Lifecycle commands

```text
agent-containers init [--backends local]
agent-containers configure --non-interactive --from <nonsecret-config-file>
agent-containers doctor [--backend local|codespaces|all] [--workspace NAME] [--json]
agent-containers validate [--config path]
agent-containers create <name> [--base branch] [--backend local|codespaces] [--machine MACHINE] [--geo GEO] (Codespaces requires --yes-cost)
agent-containers wait <name> --for ready [--timeout <duration>]
agent-containers exec <name> -- <command...>
agent-containers run <name> -- <agent command...>
agent-containers recover <name> --yes --remote-command-stopped
agent-containers unlock <name> --yes
agent-containers status [name]
agent-containers remove <name> --yes [--force-worktree] [--skip-container-cleanup]
```

- `init --force` atomically replaces only the configuration path; it refuses symlinks and cannot overwrite a hard-link peer.
`init --backends local --yes` is a noninteractive local setup route. Codespaces and both-backend setup require a strict nonsecret v2 draft plus immutable GitHub repository/ref/committed Dev Container evidence; `doctor --workspace NAME` adds read-only local metadata and recorded-container checks. Codespaces create/readiness ship behind the experimental gate; command transport and lifecycle mutations remain phase-gated.

- `exec` and `run` are explicit aliases: each starts or reuses the workspace's Dev Container and executes the provided argument vector. They persist a native-durability-synced operation-may-be-active guard **before** dispatching Dev Containers, pass each argument directly without host-shell interpolation, and retain the worktree-common-dir mount protocol for Git worktrees. They inherit the invoking terminal for interactive tools. During a cold `up`, compact structured Dev Containers stage/progress messages stream to stderr while the terminal JSON record remains captured for validation; failed builds lead with the final meaningful BuildKit/Dev Container error instead of replaying an entire JSON transcript. The guard is cleared only after a confirmed successful remote command; a state-write failure refuses dispatch or retains the guard. Ctrl-C/SIGTERM is forwarded to the **local** Dev Containers CLI, but that cannot prove an in-container command stopped. POSIX process groups cannot prove containment after a descendant calls `setsid`, and Windows `taskkill /T /F` cannot authoritatively prove arbitrary descendant containment. Therefore every cancelled lifecycle transport is durably blocked for explicit manual recovery even when its local root or group closes; readonly probes fail with a bounded error instead. On Windows, Agent Containers uses `taskkill.exe` only when its packaged native bridge obtains the Windows directory from the OS; if that bridge is unavailable it does not execute a path supplied by `SystemRoot` and instead fails closed through bounded recovery. It invokes the public `@devcontainers/cli/devcontainer.js` entry point through the active Node executable, never `cmd.exe`; its PATH-resolved regular `devcontainer.cmd` shim and the exact package entry beneath that shim's npm prefix are verified before invocation.
- `recover <name> --yes --remote-command-stopped` is an explicit operator acknowledgement, not remote cleanup: first inspect the container (and its logs/processes) yourself and stop or wait for the in-container command as appropriate; then use this command to clear the block. It neither stops nor removes a container. `unlock` never clears manual recovery, even after the original PID has died.
- If `devcontainer up` is interrupted, exits nonzero, throws, or lacks a trustworthy terminal container ID, Agent Containers performs three short bounded `docker ps --all --quiet --filter label=devcontainer.local_folder=<recorded-worktree>` probes and independently verifies each candidate's exact label. A matching label is retained only as a manual-recovery hint, never adopted as workspace metadata; **every** untrustworthy-start result—including zero matches, multiple candidates, or Docker inspection failure—blocks for manual recovery because provisioning may still continue. It never deletes a discovered resource.
- `status` reads local metadata and works without Docker or Dev Containers.
- Lifecycle-lock publication synchronizes the owner record and staging directory before its atomic rename, then synchronizes the lock directory where the platform supports it. The packaged N-API adapter ships prebuilds for Linux, macOS, and Windows on both x64 and ARM64; it fails closed before lifecycle side effects if its exact OS/architecture binary is absent or malformed. Linux uses `fsync`; macOS uses `F_FULLFSYNC` for regular recovery-journal records and reports directory synchronization independently, without claiming identical full-media directory semantics. Windows uses `FlushFileBuffers` for regular files and `MoveFileExW(MOVEFILE_WRITE_THROUGH)` for recoverable metadata publication; Windows does **not** claim a per-directory fsync. Instead, it uses a checksummed append-only per-workspace manual-recovery journal: after a crash it selects an old valid or new valid recovery state, never treats a truncated final entry as a cleared guard, and fails closed on middle corruption. Existing workspaces bootstrap that journal durably and require one retry before their first remote lifecycle dispatch. When a state root, `locks`, or `workspaces` directory is first created, Agent Containers creates each missing component progressively and synchronizes new/parent directory boundaries on strict platforms before Git, Docker, or Dev Containers side effects.
- Expected-generation configuration updates serialize cooperating Agent Containers writers on both POSIX and Windows and recheck the observed generation immediately before replacement. Neither platform has a portable/native content-CAS replacement primitive here, so an arbitrary independent external replacement after that final check cannot be prevented; first publication uses a durable no-replace boundary.
- `unlock <name> --yes` releases only a legacy normal lock whose complete, valid owner record names a local PID that has exited. Current lifecycle locks carry a fail-closed recovery guard and require the explicit `recover` acknowledgement if they survive a process failure. It also deliberately preserves a malformed published lock: its owner identity cannot be reconstructed safely, so `unlock` cannot prove it abandoned. After independently verifying no Agent Containers process can still own the workspace, repair it manually by removing `<state-dir>/locks/<name>.lock` (where `<state-dir>` is `$XDG_STATE_HOME/agent-containers` or `~/.local/state/agent-containers`), then retry the original lifecycle operation. Never delete a malformed lock merely because it is old.
- `remove` requires `--yes`, verifies recorded resource identity and ownership, and checkpoints completed cleanup stages for safe retries. Agent Containers persists only lowercase full 64-hex Docker IDs and fails closed on legacy IDs before Docker or destructive behavior. It refuses to discard a dirty worktree by default. After preserving desired changes, add the separate `--force-worktree` acknowledgement when you intentionally want Git to delete modified or untracked workspace files; it does not bypass container ownership checks or the unmerged-branch protection.

## v0.1 limitations and recovery

To preserve isolated-worktree cleanup, v0.1 rejects Dev Container configurations containing `dockerComposeFile`, `workspaceMount`, or `workspaceFolder`. Use a simple image-based `devcontainer.json` or run those configurations without Agent Containers.

Workspace metadata is stored in `$XDG_STATE_HOME/agent-containers` (or `~/.local/state/agent-containers`); interrupted lifecycle recovery stores only durable recovery hints and blocks, not authoritative cleanup metadata. If a cleanup command fails, metadata remains so retrying `ac remove <name> --yes` is safe. If Docker cannot reach a recorded container that you deliberately handled, retry with `--skip-container-cleanup`. If the branch is unmerged, merge it into its recorded base before removal. If state storage fails after `create`, recover the intact worktree with `git worktree list` and its recorded `agent-containers/<name>` branch.

Agent Containers validates names, uses argument arrays for Git, Docker, and Dev Containers, and never sends agent command text to a host shell. It is not a sandbox: review target Dev Container settings before running untrusted code. It does not add credentials, Docker socket mounts, or host-home mounts, but it also cannot constrain mounts, capabilities, features, network access, Git, Docker, or the agent executable declared by a target repository.

## Development and contributing

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Tests use Node's built-in runner. Docker/Dev Containers integration is a separate live check and is skipped locally when its prerequisites are unavailable. See [Dev Container worktree requirements](docs/devcontainer-worktrees.md), [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
