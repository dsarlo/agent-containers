# Dev Container worktrees

Agent Containers uses `git worktree add --relative-paths` and passes `--mount-git-worktree-common-dir` to both `devcontainer up` **and** `devcontainer exec`, so Git inside a linked worktree reaches the same shared Git directory and the container's configured working directory stays consistent across cold and warm execution.

## Prerequisites

- `git worktree add -h` must list `--relative-paths` or `--[no-]relative-paths`.
- Docker and a Dev Containers CLI that accepts `devcontainer up --mount-git-worktree-common-dir` are required.
- Docker must be able to access the source checkout and the worktree-common Git directory. Remote daemons and Docker Desktop may require additional path sharing.

## v0.1 limitation

Compose configurations and custom workspace mounts/folders are rejected: `dockerComposeFile`, `workspaceMount`, and `workspaceFolder` are not supported. Use a simple image-based configuration for Agent Containers v0.1.

## Verify

After `ac create example`, run:

```sh
ac exec example -- git rev-parse --git-common-dir
```

The command should print a reachable common Git directory. The dedicated live CI job runs this production lifecycle path when Docker, Dev Containers, and compatible Git are present.
