---
name: agent-containers
description: Use Agent Containers safely for isolated coding work.
version: 0.1.0
author: Daniel Sarlo (dsarlo), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [coding-agents, git-worktrees, devcontainers, isolation]
---

# Agent Containers Skill

Use Agent Containers (`ac` or `agent-containers`) to give a coding task an isolated Git worktree and its repository-approved Dev Container. It forwards arbitrary command arguments to the Dev Containers CLI; it is not tied to Claude, Codex, or OpenCode, and it is not a security sandbox.

## When to Use

- An agent needs a task-specific Git worktree without modifying the source checkout.
- The repository has a simple image-based Dev Container and work should run inside it.
- The requested agent harness or test command must run in the workspace container.
- Use `terminal` to invoke `ac`; use `read_file` and `search_files` to inspect the target repository before changing it.

Do not use this skill when the repository's Dev Container uses Compose, `workspaceMount`, or `workspaceFolder`; Agent Containers v0.1 rejects those configurations. Do not use it as a substitute for reviewing a repository's container privileges, mounts, network access, or credentials.

## Prerequisites

Verify before creating a workspace:

1. From the target repository, use `terminal` to run `ac validate`.
2. Confirm Git supports linked worktree relative pointers:
   ```sh
   git worktree add -h
   ```
   The help output must list `--relative-paths` or `--[no-]relative-paths`.
3. For `exec` or `run`, confirm Docker and the Dev Containers CLI are available:
   ```sh
   docker --version
   devcontainer --version
   ```
4. Inspect `.devcontainer/devcontainer.json` (or the configured path) before running untrusted code. `devcontainerPath` resolves within the new worktree, so it must be committed to the configured base branch; `.agent-containers.yml` is separately read from the primary Git root and may remain local/untracked. Do not add broad host-home, credential, Docker-socket, cloud, Kubernetes, or SSH mounts just to make a task work.

## Quick Reference

```sh
ac init
ac validate
ac create <task-name>
ac exec <task-name> -- <command> [arguments...]
ac run <task-name> -- <agent-command> [arguments...]
ac status [task-name]
ac remove <task-name> --yes [--force-worktree]
```

Plain `ac init` creates safe schema-v2 local configuration. For experimental Codespaces configuration only, first set `AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES=1`, then use field-oriented `ac init --interactive` / `ac configure --interactive`, a noninteractive import, or `ac doctor --backend codespaces [--json]`. Configure snapshots current configuration before prompting, previews the exact final candidate, and requires `yes`; `cancel` writes nothing. A Codespaces save read-only verifies canonical origin, remote ref, immutable commit OID, and committed Dev Container blob, then persists those nonsecret source facts. These commands do not create a Codespace or transport an agent; Codespaces lifecycle is not implemented in this release. Do not enter API keys, tokens, SSH keys, or secret values: Agent Containers never owns those credentials, and the local harness remains the orchestrator.

`agent-containers` is the full executable name and is interchangeable with `ac`.

## Procedure

1. **Inspect and validate the repository.** Use `terminal` to run `ac validate` from the Git repository. Completion: the command reports that `.agent-containers.yml` is valid. If no configuration exists, run `ac init`, then inspect and adjust the generated file before continuing.
2. **Create an isolated task workspace.** Use `terminal` to run `ac create <task-name>`. Choose a lowercase, descriptive task name. Completion: the command prints the workspace path; do not edit the source checkout for task work.
3. **Run the agent or command in the container.** `run` is an explicit alias of `exec`; use either with an argument separator, for example:
   ```sh
   ac run auth-rework -- codex "Implement the authorization redesign"
   ac run auth-rework -- opencode "Implement the authorization redesign"
   ac exec auth-rework -- npm test
   ```
   Completion: inspect the command exit status and the worktree changes. During `up`, Agent Containers prints compact structured stage/progress messages to stderr; on a build failure, use the leading reported BuildKit/Dev Container cause before inspecting any retained diagnostics. Commands are passed as arguments, not through a host shell. Interrupting a lifecycle command only terminates the local Dev Containers CLI (POSIX process group; Windows shell-free `taskkill /T /F` process tree). If Windows `taskkill` errors or fails, Agent Containers makes one direct managed-root fallback; it normally awaits close, but a bounded reaping timeout reports an error while preserving manual recovery and never asserts the in-container command or descendants stopped.
4. **Inspect state before destructive cleanup.** Use `terminal` to run `ac status <task-name>`, then inspect the worktree's Git status and tests. Completion: the task output and intended branch state are understood.
5. **Remove only after the work is safely retained.** Merge, commit, or otherwise preserve desired changes first. Use `terminal` to run `ac remove <task-name> --yes`. If the worktree contains deliberately discardable modified or untracked files, add the distinct acknowledgement `--force-worktree`; it does not weaken container ownership or unmerged-branch checks. Completion: removal reports success. Do not use `--skip-container-cleanup` unless Docker state has been independently handled and you accept retaining the container.

## Interrupted Operations and Recovery

- Ctrl-C or SIGTERM stops the local Dev Containers CLI, but cannot prove that an in-container command stopped.
- Agent Containers records a durable manual-recovery block before remote lifecycle work. Do not bypass or delete its state files during ordinary operation.
- If `exec` or `run` reports manual recovery, inspect the recorded container, logs, and processes. Stop or wait for the remote command yourself.
- Only after remote work is confirmed stopped, acknowledge that fact with:
  ```sh
  ac recover <task-name> --yes --remote-command-stopped
  ```
  This acknowledgement does not stop or remove a container.
- `ac unlock <task-name> --yes` is only for a normal lifecycle lock whose owner process is proven dead. It never clears a manual-recovery block.
- Linux uses `fsync` state boundaries. macOS uses native `F_FULLFSYNC` for regular manual-recovery journal records and does not present ordinary directory sync as the same full-media guarantee. Windows uses `FlushFileBuffers` plus `MoveFileExW(MOVEFILE_WRITE_THROUGH)` and a checksummed append-only recovery journal: it selects an old valid or new valid guard after interruption, preserves an earlier guard over a truncated final entry, and fails closed on middle corruption. Windows does not claim per-directory fsync. An existing workspace may initialize this journal first and require a retry before its first remote lifecycle dispatch. The published N-API adapter requires an exact bundled prebuild; release tarballs contain Linux, macOS, and Windows x64 and ARM64 binaries, and fail closed before lifecycle side effects if an exact binary is absent or malformed.

## Pitfalls

- Always put `--` between the workspace name and the command. Without it, Agent Containers rejects the invocation.
- `run` and `exec` are lifecycle commands and may initialize or reuse the task container. They are not read-only commands.
- The worktree remains writable by the agent. Isolation protects the source checkout, not the task workspace from the command being run.
- `status` reads local metadata; it does not prove that Docker resources are healthy or that an in-container command has stopped.
- A malformed published lifecycle lock is deliberately not auto-unlocked because ownership cannot be proven. After independently confirming no Agent Containers process owns that workspace, remove `<state-dir>/locks/<task-name>.lock` manually and retry the original lifecycle operation; do not run `ac unlock` after the deletion because no lock remains for it to release.

## Verification

Before reporting a task complete:

1. Use `terminal` to run the repository's relevant test/build commands from the task worktree through `ac exec` when container execution is required.
2. Use `terminal` to run `ac status <task-name>` and inspect Git status in the task worktree.
3. Confirm every intended change is committed, preserved elsewhere, or deliberately discarded before `ac remove <task-name> --yes`.
4. If an interruption occurred, confirm the manual-recovery block was explicitly acknowledged only after remote state was checked.
