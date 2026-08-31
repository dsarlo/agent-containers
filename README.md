# Arachne

[![CI](https://github.com/dsarlo/arachne/actions/workflows/ci.yml/badge.svg)](https://github.com/dsarlo/arachne/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Arachne gives every coding task its own Git worktree and Dev Container runtime. It is deliberately agent-harness-agnostic: use it with Claude Code, Codex, OpenCode, a shell script, or plain test commands.

## Why Arachne?

Agents and parallel human work both need isolation. Arachne creates a branch named `arachne/<name>`, checks it out in a separate worktree, records only the minimum local metadata needed to find it again, and delegates the runtime to the [Dev Containers CLI](https://github.com/devcontainers/cli). The original checkout remains your source checkout; Arachne never runs agent text through a shell.

## Prerequisites

- Node.js 20.19 or newer
- Git with `git worktree add --relative-paths` support (run `git worktree add -h` and confirm the flag is listed)
- Docker and the Dev Containers CLI (`npm install -g @devcontainers/cli`) for `exec` and `run`
- A repository with a Dev Container configuration for container execution

## Installation

The npm package name is reserved as `@dsarlo/arachne`, but the first public npm release has not been published yet. Install from the public source repository:

```sh
git clone https://github.com/dsarlo/arachne.git
cd arachne
npm ci
npm run build
npm link
```

The executable remains `arachne`.

## Quick Start

Run these from a Git repository:

```sh
arachne init
# Edit .arachne.yml if your default branch or Dev Container path differs.
arachne validate
arachne create search-page
arachne run search-page -- npm test
arachne status search-page
arachne remove search-page --yes
```

`create` creates a new branch and worktree but does not modify tracked files in the source checkout. `run` first starts the worktree's Dev Container, then executes the argument vector in it.

## Configuration

`arachne init` writes a commented `.arachne.yml`. All path values are relative to the source repository unless absolute.

```yaml
# Arachne configuration, schema version 1
version: 1

workspace:
  worktreeRoot: ../.arachne-worktrees
  baseBranch: main

environment:
  devcontainerPath: .devcontainer/devcontainer.json

commands:
  test: npm test
  lint: npm run lint
  start: npm run dev
```

The effective defaults are `version: 1`, `workspace.worktreeRoot: ../.arachne-worktrees`, `workspace.baseBranch: main`, and `environment.devcontainerPath: .devcontainer/devcontainer.json`. `commands` is optional and is descriptive metadata for repository users and agents; Arachne does not evaluate command strings from it. See [the full configuration reference](docs/configuration.md).

## Lifecycle Commands

```text
arachne init [--force]
arachne validate [--config path]
arachne create <name> [--base branch]
arachne exec <name> -- <command...>
arachne run <name> -- <agent command...>
arachne status [name]
arachne remove <name> --yes [--skip-container-cleanup]
```

- `init` refuses to overwrite an existing configuration unless `--force` is explicit.
- `validate` reports configuration errors before workspace creation.
- `create` accepts lowercase names with numbers and single hyphens, rejects unsafe paths, and refuses workspace, path, and branch collisions.
- `exec` and `run` are equivalent. They pass each argument directly to the Dev Containers CLI, without shell interpolation, and inherit the invoking terminal's stdin/stdout/stderr so interactive agent harnesses work normally.
- `status` reads local Arachne metadata and remains useful when Docker or `devcontainer` is unavailable.
- `remove` requires `--yes`; it verifies the exact recorded Git worktree and branch, then verifies the recorded Dev Container workspace label before cleanup. It retains metadata if any required cleanup fails. `--skip-container-cleanup` is an explicit recovery option when the recorded container cannot be contacted.

## Harness Examples

All examples are identical at the isolation boundary. The executable after `--` is your choice.

```sh
# Claude Code
arachne run auth-flow -- claude "Implement the approved auth-flow plan"

# Codex
arachne run auth-flow -- codex exec "Implement the approved auth-flow plan"

# OpenCode
arachne run auth-flow -- opencode run "Implement the approved auth-flow plan"

# No agent: run the project's tests
arachne exec auth-flow -- npm test
```

## Security Model And Limits

Arachne validates workspace names, uses argument arrays for Git, Docker, and Dev Containers commands, and never sends command text to a host shell. It writes workspace metadata under the current user's state directory (`$XDG_STATE_HOME/arachne` or `~/.local/state/arachne`).

Arachne does not add credentials, Docker socket mounts, or host-home mounts. The Dev Container configuration belongs to the target repository and can still declare mounts, capabilities, features, or network access; review it before running untrusted code. Arachne does not sandbox Git, Docker, Dev Containers, or the agent executable itself.

## Cleanup

Use `arachne remove <name> --yes` to stop the recorded container, remove the recorded Git worktree, delete its merged branch, and remove local metadata. If Docker is unavailable for a recorded container, cleanup fails safely and leaves metadata in place; use `--skip-container-cleanup` only when the container has already been handled deliberately. If Git refuses to delete an unmerged branch, Arachne leaves metadata in place.

## Development

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Tests use Node's built-in test runner. Unit tests inject the process runner and do not invoke Git or Docker. Disposable Git and Dev Container integration tests skip with an explicit reason when required local tooling is unavailable. See [Dev Container worktree requirements](docs/devcontainer-worktrees.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md). Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
