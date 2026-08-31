# Dev Container Worktrees

Arachne uses `git worktree add --relative-paths` when the installed Git supports it, then passes `--mount-git-worktree-common-dir` to `devcontainer up`. The Dev Containers CLI requires both conditions for Git operations in a linked worktree to see the shared Git directory.

## Prerequisites

- Git must list `--relative-paths` in `git worktree add -h`. Arachne refuses to create a workspace when the flag is absent, because a normal linked worktree cannot safely expose its shared Git directory inside the Dev Container.
- Install Docker and a Dev Containers CLI version that accepts `devcontainer up --mount-git-worktree-common-dir`.
- The Dev Container must mount the source checkout and its worktree-common Git directory from paths Docker can access. Remote Docker daemons and Docker Desktop file-sharing policies may need additional host path sharing.

## Docker Compose Limitation

The Dev Containers CLI supplies this mount to the Compose service selected by `service`. Other services in the same Compose project do not automatically receive the worktree-common Git directory. Configure an equivalent bind mount on any additional service that needs to run Git in the linked worktree.

## Verification

After `arachne create example`, run:

```sh
arachne exec example -- git rev-parse --git-common-dir
```

The command should print a reachable Git common-directory path from inside the container. Arachne's disposable integration test performs this check when Docker, the Dev Containers CLI, and relative-worktree Git support are present.
