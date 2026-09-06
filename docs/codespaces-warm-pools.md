# Proposed Codespaces warm pools

> **Status: design only; not implemented in Codespaces v1.** The complete implementation contract is the post-review Codespaces warm-pool specification. Current v1 creates and records one exact provider identity, but later backend operations can resolve the wrong recorded workspace when a logical name collides with another record's workspace ID, remote name, or Codespace ID. v1 does not pre-create a pool, lease an idle resource, adopt an arbitrary Codespace, or reuse a prior task environment.

> **Hard gates:** Phase 1 is blocked on corrected all-field handle resolution, the complete all-retained-Git-data preservation proof, and a version-fenced resource-authoritative control registry. Phase 2 is blocked on successful Phase 1 live proof plus the complete owner/security-approved reset tuple and trusted primitive. Neither is implemented.

## Product outcome

A future named pool contains only app-created Codespaces that pass immutable source, provider identity, SSH/helper, private-port, and nonempty runtime-readiness proof. A task receives one exclusive lease to one already-ready resource. The local harness still owns agent selection and credentials.

Phase 1 is single-use. A task may edit, commit, create/switch branches, run commands, stop, and resume. Release discards the exact physical resource only after the new complete repository-preservation proof. The implementation baseline's porcelain/`[ahead]` preflight is insufficient and is a Phase 1 blocker, not an existing safe protocol. A task's environment is never returned to another task.

Phase 2 is separate and opt-in. Git proof preserves repository data; it does not sanitize processes, writable filesystems, caches, mounts, credentials, or secrets. Reset remains disabled unless the approved primitive proves the complete boundary and a new incarnation.

## Proposed Phase 1 UX

~~~sh
# Controlled in-place activation only. Complete launcher authority and actual
# zero active old/new clients are mandatory. There is no fresh-root fallback.
ac codespaces upgrade-control --yes

ac pool warm coding --count 2 --yes-cost
ac pool status coding
ac create fix-login --backend codespaces --pool coding
ac run fix-login -- opencode "Fix the login bug"
ac release fix-login --discard --yes --force-remote-data-loss
~~~

- `warm --count N` reaches N ready-idle resources and never shrinks.
- One nonzero warm owns a pool and serializes all actions.
- `create --pool` is immediate lease-only and performs no create/start/wait/fallback.
- Pools require nonempty readiness; `ready-without-setup-proof` is ineligible.
- Pool miss is `POOL_MISS`; stopped-only inventory is `POOL_STOPPED`.
- A stopped leased resource stays task-owned and only explicit `start TASK --yes` resumes it.
- Release requires all three discard acknowledgements and never replenishes.
- Stopped cleanup additionally requires `--yes-cost` and can only prove Git/delete that target.

## Phase 1 prerequisites

The current later backend resolver is OR-based across workspace ID, remote name, and Codespace ID. Before pools, select one registry authority by immutable key and AND-match every logical workspace/task, workspace ID, resource, incarnation, Codespace ID/name, environment, lease, and generation field. A collision/mismatch fails before provider, SSH, helper, or state effects.

Every writer under one state root must use `codespaces-control/v2` and one strict registry. In-place activation requires an external launcher that closes starts, enumerates and drains/terminates/reaps every issued client, proves zero clients before scan, and keeps launch closed through crash/resume. A missing/empty/new root does not bypass this prerequisite; no fresh-root bootstrap is specified.

The registry atomically owns resource, lease, globally unique command ID/slot, finite lifecycle operation, recovery, and capacity. Every pre-dispatch command checkpoint can generation-bound terminalize as `not-dispatched` with zero provider/SSH/helper calls. Every readiness, start, stop, release, and cleanup checkpoint has an exact read-only reconciliation row and typed exact-GET-404 terminal outcome.

Only typed HTTP 404 from GET of the exact recorded endpoint proves absence. Proof and immutable finalization bind source kind/checkpoint/owner, operation, resource, physical resource, incarnation, IDs/name/endpoint, and generations.

Before every live DELETE, fixed package probes prove exact root/origin, worktree/index, all refs, supported pseudorefs, every reflog OID, upstreams, advertised-origin refs, tags, and reachability. They independently recurse through every retained `$GIT_COMMON_DIR/modules` repository, including deinitialized and residual modules. Unknown/unmapped/unreadable module administration fails closed. Neither acknowledgement bypasses proof.

## Capacity and budget

Global `maxTotal`, `maxRunning`, `maxCreating`, pool `maxIdle`, and one command per resource remain authoritative. Create/start reserve `{total:1,running:1,creating:1}` before dispatch. Lease verification retains one idle-return reservation. Unknown/recovery remains conservative; only bound GET-404 tombstone is zero.

No lease expiry/stealing, daemon, timer, keepalive, startup warm, hidden retry, queued replacement, output replay, or automatic replenishment is permitted.

## Phase 2 reset/reincarnation

Phase 2 requires this complete immutable approval tuple. All first seven fields through `resetProofSchemaVersion` and both additional readback/cleanup schema-version fields are mandatory:

~~~ts
interface ApprovedResetContractV1 {
  threatModelId: string;
  threatModelVersion: string;
  boundaryId: string;
  boundaryVersion: string;
  resetPrimitiveId: string;
  resetPrimitiveImplementationVersion: string;
  resetProofSchemaVersion: 1;
  resetOperationReadbackSchemaVersion: 1;
  resetCleanupSchemaVersion: 1;
}
~~~

Before any destructive reset dispatch, a trusted out-of-task channel must hold prior-task quiescence and complete the same all-retained-Git-data proof. After proof, the writer must durably publish and revalidate `destructive-dispatched` before invoking the primitive. Reset success is a physical-outcome union: same-Codespace requires typed predecessor environment retirement; replacement requires the predecessor's own bound GET-404 tombstone. A replacement predecessor stays capacity-bearing until that absence finalizes.

Failed/partial reset cleanup uses one durable parent reservation and independently generated child operations for each physical target. Each exact target GET-404 immediately stores proof/finalization and tombstones that target, while the full parent idle/capacity floor remains until every target is terminal. A same-Codespace partial outcome without retirement can safely terminate by deleting one recognized shared physical target and proving its endpoint absent, covering both recorded possible incarnations.

By default, named-secret or Codespaces Git-credential-capable resources remain discard-only. Config alone cannot make Phase 1/migrated/provisional/recovery/quarantine resources reusable.

## Delivery order

1. **Phase 1 / critical:** #37, exact single-use warm leasing after all v1 safety prerequisites.
2. **Phase 2 / critical:** #38, hard-blocked reset/reincarnation after accepted Phase 1 live proof and reset approvals.
