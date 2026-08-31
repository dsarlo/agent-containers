# Agent Containers

[![CI](https://github.com/dsarlo/agent-containers/actions/workflows/ci.yml/badge.svg)](https://github.com/dsarlo/agent-containers/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Agent Containers gives every coding task an isolated Git worktree and Dev Container runtime. It is deliberately agent-harness-agnostic: use it with Claude Code, Codex, OpenCode, a shell script, or plain test commands.

## Status

**v0.1 is source-installable but is not published to npm and no release has been published.** The package metadata reserves `@dsarlo/agent-containers`; do not expect `npm install @dsarlo/agent-containers` to work until a public package is announced.

## Prerequisites

- Node.js 20.19 or newer
- Git whose `git worktree add -h` lists `--relative-paths` or `--[no-]relative-paths`
- Docker and the Dev Containers CLI (`npm install -g @devcontainers/cli`) for `exec` and `run`
- A repository with a simple image-based Dev Container configuration

## Install from source

```sh
git clone https://github.com/dsarlo/agent-containers.git
cd agent-containers
npm ci
npm run build
npm link
```

The provided executable names are `agent-containers` and the short alias `ac`.

## Agent skill

The package also includes an agent-facing usage skill at [`skills/agent-containers/SKILL.md`](skills/agent-containers/SKILL.md). Agents can load or copy that definition to follow the supported lifecycle, isolation, and recovery contract rather than inferring command behavior.

## Quick start

Run these from a Git repository:

```sh
ac init
# Edit .agent-containers.yml if your default branch or Dev Container path differs.
ac validate
ac create search-page
ac run search-page -- npm test
ac status search-page
ac remove search-page --yes
```

`create` creates `agent-containers/<name>` and an isolated worktree without modifying tracked files in the source checkout. `run` starts the worktree's Dev Container and executes the argument vector in it.

## Configuration

`ac init` writes a commented `.agent-containers.yml`. All path values are relative to the source repository unless absolute.

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

The defaults are `version: 1`, `workspace.worktreeRoot: ../.agent-containers-worktrees`, `workspace.baseBranch: main`, and `environment.devcontainerPath: .devcontainer/devcontainer.json`. `commands` is descriptive only; Agent Containers never evaluates these command strings. See the [configuration reference](docs/configuration.md).

## Lifecycle commands

```text
agent-containers init [--force]
agent-containers validate [--config path]
agent-containers create <name> [--base branch]
agent-containers exec <name> -- <command...>
agent-containers run <name> -- <agent command...>
agent-containers recover <name> --yes --remote-command-stopped
agent-containers unlock <name> --yes
agent-containers status [name]
agent-containers remove <name> --yes [--skip-container-cleanup]
```

- `init --force` atomically replaces only the configuration path; it refuses symlinks and cannot overwrite a hard-link peer.
- `exec` and `run` persist and fsync an operation-may-be-active guard **before** dispatching Dev Containers. They pass each argument directly to Dev Containers without host-shell interpolation and inherit the invoking terminal for interactive tools. The guard is cleared only after a confirmed successful remote command; a state-write failure refuses dispatch or retains the guard. Ctrl-C/SIGTERM is forwarded to the **local** Dev Containers CLI, but that cannot prove an in-container command stopped. After the local CLI is reaped, Agent Containers promotes/retains the durable manual-recovery block and refuses `create`, `exec`, `run`, and `remove` for that workspace.
- `recover <name> --yes --remote-command-stopped` is an explicit operator acknowledgement, not remote cleanup: first inspect the container (and its logs/processes) yourself and stop or wait for the in-container command as appropriate; then use this command to clear the block. It neither stops nor removes a container. `unlock` never clears manual recovery, even after the original PID has died.
- If `devcontainer up` is interrupted, exits nonzero, throws, or lacks a trustworthy terminal container ID, Agent Containers runs `docker ps --all --quiet --filter label=devcontainer.local_folder=<recorded-worktree>` and independently verifies each candidate's exact label. It records one exact match as the workspace container, but **every** untrustworthy-start result—including zero matches, multiple candidates, or Docker inspection failure—blocks for manual recovery because provisioning may still continue. It never deletes a discovered resource.
- `status` reads local metadata and works without Docker or Dev Containers.
- Lifecycle-lock publication fsyncs the owner record and staging directory before its atomic rename, then fsyncs the lock directory. Lock, recovery-marker, and metadata removals are followed by a parent-directory fsync so a completed lifecycle does not rely on an unpersisted directory entry.
- `unlock <name> --yes` releases only a normal lock whose complete, valid owner record names a local PID that has exited. It refuses active locks. It also deliberately preserves a malformed published lock: its owner identity cannot be reconstructed safely, so `unlock` cannot prove it abandoned. After independently verifying no Agent Containers process can still own the workspace, repair it manually by removing `<state-dir>/locks/<name>.lock` (where `<state-dir>` is `$XDG_STATE_HOME/agent-containers` or `~/.local/state/agent-containers`), then retry `unlock`. Never delete a malformed lock merely because it is old.
- `remove` requires `--yes`, verifies recorded resource identity and ownership, and checkpoints completed cleanup stages for safe retries.

## v0.1 limitations and recovery

To preserve isolated-worktree cleanup, v0.1 rejects Dev Container configurations containing `dockerComposeFile`, `workspaceMount`, or `workspaceFolder`. Use a simple image-based `devcontainer.json` or run those configurations without Agent Containers.

Metadata is stored in `$XDG_STATE_HOME/agent-containers` (or `~/.local/state/agent-containers`). If a cleanup command fails, metadata remains so retrying `ac remove <name> --yes` is safe. If Docker cannot reach a recorded container that you deliberately handled, retry with `--skip-container-cleanup`. If the branch is unmerged, merge it into its recorded base before removal. If state storage fails after `create`, recover the intact worktree with `git worktree list` and its recorded `agent-containers/<name>` branch.

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
