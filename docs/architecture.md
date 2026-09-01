# Architecture

Agent Containers has a deliberately small boundary surface:

1. The CLI loads and validates `.agent-containers.yml`.
2. `create` discovers the Git root, validates a workspace name, and runs `git worktree add --relative-paths -b agent-containers/<name> <path> <base>`.
3. Metadata is atomically written beneath the user-local `agent-containers` state directory.
4. `exec` and `run` reject unsupported v0.1 Dev Container modes, run `devcontainer up --mount-git-worktree-common-dir`, require a terminal JSON `containerId`, save it, then call `devcontainer exec` with the original argument array.
5. `remove --yes` validates exact recorded worktree, branch, and container ownership; it checkpoints each completed destructive stage. A retry reconciles already-absent recorded resources instead of resurrecting stale metadata.

## Process boundary

Production uses Node `spawn` with `shell: false`. Captured stdout/stderr are bounded (with the terminal output retained) so Dev Containers terminal JSON parsing remains functional without unbounded memory growth. Interactive execution inherits stdio.

## Metadata and lifecycle boundary

Metadata records the name, canonical Git paths, `agent-containers/<name>` branch, base branch, Dev Container path, creation time, optional container ID, and cleanup checkpoints. Workspace lifecycle operations use a per-name atomically-created lock. A contender waits rather than concurrently saving stale metadata after another lifecycle operation has removed it; a lock is never automatically stolen.

## Non-goals

Agent Containers is not an agent scheduler, authorization layer, or container sandbox. It does not inspect agent output, select an agent, alter target Dev Container security settings, or mount Docker sockets, credentials, or host homes.
