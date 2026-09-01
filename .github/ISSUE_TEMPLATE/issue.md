---
name: Issue
about: Report a bug, propose a capability, or request a design decision
labels: ''
assignees: ''
---

<!--
Thank you for improving Agent Containers.

Do not include credentials, access tokens, private repository URLs, hostnames,
IP addresses, device IDs, SSH material, Docker configuration, or raw diagnostic
transcripts. Redact them before filing.
-->

## Problem or opportunity

<!-- What user or operator outcome is missing, unsafe, confusing, or broken? -->

## Desired outcome

<!-- Describe observable behavior. For a bug, include expected vs actual behavior. -->

## Context and scope

- **Type:** <!-- bug | feature | security | design/spike | documentation -->
- **Affected command(s)/surface:**
- **Backend/runtime:** <!-- local Docker | Codespaces | remote SSH | Kubernetes | other -->
- **Platform(s):** <!-- Linux | macOS | Windows -->
- **Version/commit (if known):**
- **Reproducible:** <!-- always | intermittent | not yet -->

### Reproduction or proposed flow

<!--
For bugs, provide the smallest safe reproduction:
1. ...
2. ...
3. ...

For features/designs, show the intended command/API flow and the user-visible
result. Mark proposed syntax as proposed rather than current behavior.
-->

## Safety, ownership, and recovery

<!-- Complete every applicable item. -->

- **Resources created or changed:** <!-- worktree, container, branch, remote VM, Codespace, Kubernetes Job, none, etc. -->
- **Identity/ownership proof required:** <!-- exact recorded ID/UID/path/label; never name-only matching -->
- **Read-only diagnostics:** <!-- what list/status/doctor may inspect without mutation -->
- **Destructive operations:** <!-- stop/remove/delete/rebuild; required confirmation and exact identity check -->
- **Ambiguous/interrupted outcome:** <!-- recovery record/operator acknowledgement; never automatic cleanup by discovery -->
- **Credential, mount, network, or port impact:** <!-- defaults must remain least-privilege/private -->

## Acceptance criteria

- [ ]
- [ ]
- [ ]

## Validation plan

- [ ] Focused regression/contract tests cover the requested behavior and failure path.
- [ ] Linux, macOS, and Windows control-plane impact is specified or explicitly unsupported.
- [ ] Read-only, cancellation, recovery, ownership-mismatch, and no-adoption behavior are covered where applicable.
- [ ] Live/Docker/cloud E2E requirements, dedicated test environment, and budget/cleanup constraints are stated.
- [ ] Documentation is updated if user-visible behavior or safety boundaries change.

## Alternatives considered

<!-- Include why the proposed path is preferable and any compatibility trade-offs. -->

## Additional evidence

<!-- Link related issues/PRs, sanitized logs, screenshots, or relevant public documentation. -->
