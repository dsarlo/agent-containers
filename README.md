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
agent-containers status [name]
agent-containers remove <name> --yes [--skip-container-cleanup]
```

- `init --force` atomically replaces only the configuration path; it refuses symlinks and cannot overwrite a hard-link peer.
- `exec` and `run` pass each argument directly to Dev Containers without host-shell interpolation and inherit the invoking terminal for interactive tools.
- `status` reads local metadata and works without Docker or Dev Containers.
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
