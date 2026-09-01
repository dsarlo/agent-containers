---
name: Issue
about: Report a bug, propose a capability, security improvement, design decision, or documentation update
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
- **Credential, mount, network, or port impact:** <!-- describe current and requested privilege/visibility boundaries; state whether private-by-default and least-privilege behavior is required -->

## Acceptance criteria

- [ ]
- [ ]
- [ ]

## Validation plan

<!-- Complete applicable items. For documentation-only or design issues, mark implementation/E2E items N/A and state the accuracy, link, example, or rendering validation instead. -->

- [ ] Focused regression/contract tests cover the requested behavior and failure path, or N/A with an alternative validation stated.
- [ ] Linux, macOS, and Windows control-plane impact is specified, explicitly unsupported, or N/A.
- [ ] Read-only, cancellation, recovery, ownership-mismatch, and no-adoption behavior are covered where applicable.
- [ ] Live/Docker/cloud E2E requirements, dedicated test environment, and budget/cleanup constraints are stated where applicable.
- [ ] Documentation is updated when user-visible behavior or safety boundaries change; documentation-only work validates accuracy, links, examples, and rendering.

## Alternatives considered

<!-- Include why the proposed path is preferable and any compatibility trade-offs. -->

## Additional evidence

<!-- Link related issues/PRs, sanitized logs, screenshots, or relevant public documentation. -->
