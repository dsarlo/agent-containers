# Architecture

Agent Containers has two execution backends behind one CLI/configuration boundary:

1. The CLI loads and validates `.agent-containers.yml`.
2. Local `create` creates a Git worktree and local Dev Container record.
3. Codespaces `create` records durable intent, creates one GitHub Codespace only after explicit cost acknowledgement, and adopts it only after exact identity readback.
4. All metadata is atomically written beneath the user-local `agent-containers` state directory.
5. `exec` and `run` dispatch an argument vector to the recorded backend. `remove --yes` checkpoints destructive cleanup and preserves a tombstone for already-absent or deleted resources.

## Local backend

The local backend uses `git worktree`, the Dev Containers CLI, and exact container/worktree ownership checks. See [Dev Container worktree requirements](devcontainer-worktrees.md) for its v0.1 limitations.

## Codespaces v1 backend

Codespaces is experimental and requires `AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES=1`. Schema-v2 configuration pins the GitHub repository/ref to an immutable commit OID and pins the committed Dev Container blob. Provider operations use fixed argv-framed `gh api`/`gh codespace ssh` invocations; Agent Containers does not retrieve or manage GitHub credentials.

Create records durable intent before provider dispatch and verifies the authenticated actor, repository, requested name, IDs, and immutable source facts before a resource is accepted. Ambiguous responses, identity drift, capacity uncertainty, or persistence failure remain fail-closed rather than adopting a resource by name.

`wait --for ready` observes provider availability, exact identity, allowed port visibility, repository root/HEAD/origin over SSH, SSH reachability, and optional configured runtime readiness argv. It promotes a matching completed create checkpoint only after terminal `ready` or `ready-without-setup-proof`; failed, timed-out, or unrelated lifecycle checkpoints remain barriers.

After readiness, `exec`/`run` start a package-owned remote helper through `gh codespace ssh`. User argv is carried in framed stdin, not shell text. CLI commands receive connected stdout/stderr plus terminal status; backend integrations can select a merged PTY terminal stream. Durable command records retain status/cancellation only: they do not retain raw argv, output frames, request hashes, or command hashes. Later status recovery may report known state but never replays unavailable output. Unknown command or cancellation outcomes stay fail-closed.

`start`, `stop`, and `remove` verify the recorded actor and exact Codespace identity before mutation and read state back afterward. `reconcile` is read-only. Removal requires both `--yes` and `--force-remote-data-loss`, refuses an active/unknown command or interrupted lifecycle checkpoint, runs a checkout-root Git dirty/ahead preflight, deletes the exact resource, verifies absence, and writes a tombstone.

## Secret and process boundaries

The local harness remains the agent orchestrator and keeps provider authentication. The configuration contains only a named-secret allowlist, never values. The helper clears its environment and restores only `PATH` plus allowlisted variables present in the Codespace; it redacts matching values from connected output frames. Target Dev Container/Codespace configuration is still not a sandbox: Agent Containers does not constrain repository-declared mounts, capabilities, network access, Git permissions, or the agent executable.

## Non-goals

Agent Containers is not an agent scheduler, authorization layer, or general container sandbox. It does not select an agent, inspect agent intent, manage GitHub secrets or authentication, retain/replay remote command output, or coordinate Codespaces capacity across separate local state roots.

See [Codespaces v1](codespaces.md) for the operator workflow and recovery contract.
