# Architecture

Arachne has a deliberately small boundary surface:

1. The CLI loads and validates `.arachne.yml`.
2. `create` discovers the current Git root, validates a workspace name, and invokes `git worktree add --relative-paths -b arachne/<name> <path> <base>` when Git supports relative worktree pointers.
3. A metadata record is atomically written to the user's local state directory under `workspaces/<name>.json`; a failed write triggers best-effort worktree and branch rollback.
4. `exec` and `run` resolve that record, call `devcontainer up --mount-git-worktree-common-dir`, require a `containerId` in the terminal JSON record, persist it, and call `devcontainer exec` with that ID and the original command argument array.
5. `status` reads metadata only. `remove --yes` verifies the recorded Git worktree/branch and Dev Container workspace label before cleanup, recording completed stages atomically so normal cleanup retries are safe.

## Process Boundary

The core receives a `ProcessRunner` interface. Production uses Node's `spawn` with `shell: false`; tests replace it with an in-memory recorder. This makes command construction testable without Git, Docker, or Dev Containers.

## Metadata Boundary

Metadata stores the name, canonical Git root/worktree paths, branch, base branch, Dev Container path, creation time, optional primary container ID, and completed cleanup stages. A name must pass the same strict validation before it is used to construct a metadata path, and the filename must match it. Removal additionally validates the branch convention `arachne/<name>` and never accepts arbitrary worktree metadata.

## Non-Goals

Arachne is not an agent scheduler, an authorization layer, or a container sandbox. It does not inspect agent output, choose an agent, alter repository Dev Container security settings, or mount Docker sockets, credentials, or host homes. Those concerns stay with the operator and target repository.
