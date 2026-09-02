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

Legacy v1 metadata remains local-compatible. New local records are schema v2 and persist `backend: local` with a discriminated local handle. Persisted Codespaces handles fail closed because their lifecycle backend is not implemented. Local lifecycle operations use a per-name atomically-created lock.

## Non-goals

Agent Containers is not an agent scheduler, authorization layer, or container sandbox. It does not inspect agent output, select an agent, alter target Dev Container security settings, or mount Docker sockets, credentials, or host homes.

## Codespaces setup boundary

Schema v2 has a strict backend selection and a provider adapter boundary. The adapter invokes `gh api` with fixed argument arrays and strictly parses documented Codespaces defaults and machine inventory fields. Configure snapshots the current configuration before prompting, resolves immutable source evidence before previewing the exact final candidate, and revalidates it after confirmation. Expected-generation replacement serializes cooperating Agent Containers writers in both strict POSIX and recoverable Windows modes and detects independent changes before its final replacement observation. Neither mode can prevent an arbitrary external replacement after that observation; expected-absence first publication remains a durable no-replace boundary. `doctor` is bounded and read-only and does not claim provisioned-runtime coverage without an implemented recorded-handle check. These paths do not create/start/stop/delete Codespaces, generate SSH keys, upload helpers, modify ports or secrets, or adopt an existing Codespace.

The local harness remains the orchestrator and retains provider credentials and its agent loop. Any future Codespaces execution backend must send a framed argv protocol to a package-owned helper over a verified exact Codespace identity; it must not forward host files, environment, credentials, or use a shell command string.
