# Codespaces Warm Pools: Post-Review Standalone Implementation Specification

**Role:** Sol, principal architect for `dsarlo/agent-containers`
**Review target:** `9b62fbc11f287328c881bf762b0cc068882b8486`
**Implementation baseline:** `61767eab0de1210eb1b8233cd04d78a2c0f9c7a7`, the direct parent of the review target
**Review input:** `agent-containers-codespaces-warm-pools-sol-xhigh-publish-review.md`
**Delta classification:** The review target changes exactly `docs/codespaces-warm-pools-spec.md`, `docs/codespaces-warm-pools.md`, and `docs/codespaces.md`. Source, native, test, script, package, and workflow files are unchanged from the implementation baseline.
**Artifact status:** This is a post-review replacement contract based on the implementation baseline and the exact-head review of the review target. It is not contained in the review target and is not evidence that any described behavior is implemented, security-approved, or live-proven.
**Scope:** Issue #37 Phase 1 and issue #38 Phase 2
**Status:** Complete replacement implementation contract. Phase 1 is single-use and blocked on all prerequisites below. Phase 2 remains unavailable behind its hard gate.

## Evidence Discipline

- **VERIFIED** candidate-document facts are observations of the exact review target.
- **VERIFIED** source, test, and CI facts are observations of the implementation baseline and are inherited unchanged by the documentation-only review target.
- **RECOMMENDATION** is a normative implementation requirement, not current behavior.
- **ASSUMPTION** requires owner approval or separately authorized live evidence before use.
- Documentation citations establish proposal text or documented status only. They are not implementation evidence.
- No sibling or non-ancestor candidate is current reviewed evidence for this document.
- **ASSUMPTION:** No live Codespaces proof, provider reset guarantee, owner-approved reset threat model, independently approved reset primitive, or universal secret-redaction proof was supplied.

## 1. Executive Decision

Keep the two-issue split.

1. Issue #37 delivers named pools of exact, Agent-Containers-created, fully proven, single-use Codespaces and exclusive task leases. Release always discards the leased physical resource. A released task environment never returns to another task.
2. Issue #38 is a hard-dependent, opt-in reset/reincarnation follow-up. It changes the cross-task security boundary and cannot be implemented as ordinary Git cleanup, process enumeration, stop/start, or in-environment probing.

Issue #37 MUST NOT merge until all Codespaces writers use one resource-authoritative control transaction. Resource ownership, pool warm ownership, lease ownership, command-ID reservation, command admission and terminalization, lifecycle operations, create/start/reset reservations, release/delete, drain, capacity, and recovery ownership MUST linearize in one strict registry under one cross-process protocol.

The complete all-retained-Git-data preservation proof in section 7 is a Phase 1 prerequisite. The implementation baseline's porcelain status and `[ahead]` check is not this proof and MUST NOT authorize a Phase 1 DELETE.

Issue #38 implementation MUST NOT begin until all of the following are true:

1. Phase 1 is shipped and the exact production artifact passes a separately authorized live warm, lease, branch-continuity, command, complete-Git-preservation, discard, recovery, and capacity proof under a written budget.
2. The owner and an independent security reviewer approve the complete immutable reset contract tuple in section 11.
3. An independent security review accepts the exact package-owned reset primitive implementation, typed operation-readback contract, pre-destructive quiescence and Git preservation, cleanup addressability, proof schemas, and conservative capacity vector.

**VERIFIED:** Warm pools are design-only at the review target (`docs/codespaces-warm-pools.md:1-5`, `docs/codespaces.md:112-114`). The CLI contains no pool or control-upgrade route (`src/cli.ts:455-456`).

**VERIFIED:** The provider surface has actor lookup, exact GET, create, lifecycle PATCH, delete, probes, and controlled SSH, but no reset, rebuild, reincarnation, or sanitization primitive (`src/codespaces.ts:53-284`).

## 2. Exact Implementation Baseline

| Area | Verified implementation fact inherited from `61767ea...` | Normative consequence |
| --- | --- | --- |
| Experimental gate | Backend create/observe/wait/execute/attach/cancel check `AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES=1`; lower-level create/readiness/lifecycle exports do not self-gate (`src/backend.ts:71-77`, `src/backend.ts:96-143`, `src/codespaces-create.ts:116-128`, `src/codespaces-readiness.ts:58-69`, `src/codespaces-lifecycle.ts:27-90`). | Every new mutating pool, probe, lease, command, lifecycle, cleanup, migration, and recovery public entry point checks the gate. |
| Authentication | Provider authentication remains local `gh`; the adapter obtains the actor with `GET /user` (`src/codespaces.ts:53-64`, `src/codespaces.ts:276-283`). Doctor avoids SSH because `gh codespace ssh` can create local SSH material (`src/setup.ts:236-247`). | Keep local harness ownership and local `gh` auth. Never retrieve, migrate, print, or persist credential values. |
| Strict configuration | The strict Codespaces key set has no `pools`; `maxParallelCommandsPerWorkspace` accepts every integer at least one (`src/config.ts:252-265`, `src/config.ts:479-483`). | Add strict pool configuration and require the command limit to equal one before any pool state or provider effect. |
| Readiness | Empty `readiness.command` is accepted, maps to `ready-without-setup-proof`, and is executable (`src/config.ts:480-507`, `src/codespaces-readiness.ts:156-162`, `src/codespaces-readiness.ts:306-315`, `src/backend.ts:108-115`). | Pools require nonempty runtime readiness; only terminal `ready` is pristine proof. |
| Create identity | Create records one requested logical workspace and one exact provider response/readback. Candidate listing after ambiguity is diagnostic only (`src/codespaces-create.ts:91-109`, `src/codespaces-create.ts:130-231`, `src/codespaces-create.ts:253-280`). | Preserve exact create lineage and no adoption. |
| Later handle resolution | The CLI initially loads the requested logical name, but backend lookup scans logical-name-sorted metadata and accepts the first workspace-ID, remote-name, or Codespace-ID match (`src/cli.ts:206-218`, `src/backend.ts:160-166`, `src/state.ts:484-493`). | v1 does not guarantee exact later backend-handle resolution under cross-field collision. Before Phase 1, introduce one unambiguous registry key and AND-match all supplied handle fields against one authority. Merely changing `||` to `&&` is insufficient because current callers assign different meanings to `handle.name`. |
| Provider identity | Provider parsing permits null `environment_id`; create substitutes Codespace ID. Lifecycle/readiness identity omits environment ID (`src/codespaces.ts:344-374`, `src/codespaces-create.ts:307-317`, `src/codespaces-create.ts:400-416`). | Bind a real non-null environment identity before pool use. Changed environment ID creates a successor. |
| Repository owner identity | Provider parsing validates a repository owner ID but shipped state does not retain it (`src/codespaces.ts:348-365`, `src/state.ts:42-44`, `src/state.ts:531-533`). | Migrated live records remain identity-incomplete until exact one-time binding. |
| Command keying | Local command state is globally keyed only by command ID. Existing-ID attach does not compare owner fields (`src/codespaces-command.ts:25-55`, `src/codespaces-command.ts:74-98`, `src/codespaces-command.ts:161-167`, `src/codespaces-transport.ts:313-331`, `src/codespaces-transport.ts:475-493`). | Reserve IDs globally and bind registry/helper/secondary state to exact resource, incarnation, and lease identity. |
| Command data | Task argv is framed to a fixed helper; durable local/helper state retains structure but not argv/output; disconnected output is not replayed (`src/codespaces-transport.ts:18-39`, `src/codespaces-transport.ts:549-566`, `src/codespaces-transport.ts:608-688`, `native/helper/helper.c:519-546`, `native/helper/helper.c:1062-1080`). | Preserve framed transport, connected-only output, and all durable-data prohibitions. |
| Command/lifecycle race | Lifecycle scans command directories and publishes state separately from command admission (`src/codespaces-lifecycle.ts:37-45`, `src/codespaces-lifecycle.ts:65-70`, `src/codespaces-lifecycle.ts:125-165`, `src/codespaces-transport.ts:313-331`). | Resource command slot and lifecycle/release admission transition atomically. |
| Git deletion risk | Current preflight runs porcelain status and detects unpushed state only through `[ahead]` (`src/codespaces.ts:88-98`, `src/codespaces-lifecycle.ts:70-76`). | Replace it before Phase 1 with fixed dirty, ref, pseudoref, reflog, submodule-administration, advertised-origin, and reachability proof covering all retained Git data. |
| Provider absence | Provider failures are generic redacted errors; lifecycle uses broad message matching for absence (`src/codespaces.ts:276-295`, `src/codespaces-lifecycle.ts:77-89`, `src/codespaces-lifecycle.ts:184`). | Only typed HTTP 404 from exact GET of the recorded endpoint, captured in a schema-bound proof, finalizes absence and zero capacity. |
| Tombstones/capacity | Tombstones remain records, categorize as uncertain, and consume total capacity (`src/codespaces-lifecycle.ts:77-90`, `src/codespaces-capacity.ts:43-52`, `src/codespaces-capacity.ts:65-76`). | Migrated tombstones remain conservative until newly proven absent. |
| Lock/samplers | The owner-aware lock is `<stateDir>/codespaces/capacity/lock`; create and start use different samplers, and start skips ordinary metadata filenames and intents (`src/codespaces-capacity.ts:39-41`, `src/codespaces-capacity.ts:79-170`, `src/state.ts:126-132`, `src/codespaces-create.ts:360-375`, `src/codespaces-lifecycle.ts:168-181`). | Activate a versioned writer protocol, permanently fence newly started old writers, prove zero already-started writers, and use one canonical sampler. |
| CI | Hosted CI covers Ubuntu Node 20/22/24, Windows tests, six native targets, package smoke, static helper verification, and local-Docker Dev Container integration; it has no live Codespaces job (`.github/workflows/ci.yml:12-254`). | Add pool tests to hosted matrices; keep live proof separately owner-authorized. |

The v1 qualification is narrow: create-time exact response/readback and no-adoption remain valid. The defect is later backend operations using the OR-matched resolver, including affected observe, wait, run/exec, attach, and cancel calls. Direct lifecycle code that operates from one already selected logical record is not thereby proven defective.

## 3. Locked Product Scope

The following are non-negotiable:

1. Keep the existing experimental Codespaces gate on every new public pool/control operation.
2. Keep local `gh` authentication and local harness orchestration. Add no provider credential custody or agent scheduling.
3. Preserve exact app-create lineage, immutable provider identity, source proof, private-port proof, SSH/helper proof, and configured runtime readiness at preparation and lease activation.
4. Replace the current ambiguous later-handle resolver before pool use. Resolve one authority by immutable registry key, then AND-match logical task/workspace, workspace ID, resource, incarnation, Codespace ID/name, environment, lease, and generation fields supplied by that operation.
5. Preserve framed argv transport and connected-only output.
6. Persist no raw task argv, concatenated command, stdout/stderr/PTY bytes, replay buffer, request hash, command hash, argv hash, output hash, compatibility hash, config hash, token/secret-derived hash, credential value, named-secret value, provider response body, or raw provider error. Configured readiness argv remains only in strict user configuration.
7. Pool only exact resources created and recorded by this application. Provider listing remains diagnostic-only.
8. One physical resource has at most one nonterminal lease and one active, admitting, or unknown command.
9. A lease has no timeout and cannot be stolen by wall clock, process death, or provider state.
10. Phase 1 release discards only after both destructive acknowledgements and exact identity, command, complete Git-preservation, delete, and absence gates.
11. The complete Git proof is a prerequisite, not the baseline's existing protocol. No Phase 1 pool implementation may merge and no Phase 1 DELETE may dispatch while any path uses only porcelain/`[ahead]` evidence.
12. Global `maxTotal`, `maxRunning`, `maxCreating`, pool `maxIdle`, and one command per resource remain authoritative across pooled and non-pooled Codespaces under one state root.
13. Corruption, unsupported protocol/schema, stale generation, duplicate identity, command ambiguity, lifecycle ambiguity, identity ambiguity, or uncertain persistence fails closed.
14. Release, drain, recovery, and reset completion never replenishes capacity. `desiredReady` is inert outside an explicit warm invocation.
15. Add no daemon, scheduler, background timer, startup hook, queued replacement, hidden create/start, or keepalive.
16. Phase 2 defaults off and remains unavailable unless every threat-model, primitive-version, pre-destructive preservation, capacity, cleanup-addressability, and proof gate passes.
17. Git proof establishes repository preservation only. It is never process, writable-filesystem, cache, mount, credential, or secret sanitization proof.
18. Fresh-state-root bootstrap is not specified as an activation alternative. A deployment unable to establish the complete launcher authority and actual zero-client proof in section 5 cannot activate this protocol.

Explicit non-goals are arbitrary Codespace import/adoption; cross-host/state-root coordination; cross-actor/owner/billing/repository/source/machine/geo/port/secret-policy reuse; automatic target maintenance; output history; lease expiration/stealing; harness ownership changes; sandbox claims; arbitrary cleanup argv; and dormant Phase 2 code in Phase 1.

## 4. Terms, Configuration, and UX

| Term | Normative meaning |
| --- | --- |
| logical task | User-facing name plus immutable task UUID; never provider identity. |
| resource | One app-recorded Codespace incarnation and its control authority. |
| physical resource | One billed/provider Codespace, counted once except while reset's full parent floor conservatively reserves all possible contributors. |
| incarnation | Immutable record bound before use to one non-null provider environment identity. A changed environment ID creates a successor. |
| lease | Durable exclusive task-to-resource binding. |
| recorded ready-idle | Last-known pristine proof, not a current provider observation. |
| confirmed ready-idle | Ready-idle freshly proven by the one active warm invocation. |
| recovery-required | Exact named operation whose checkpoint, owner, and generations remain authoritative. |
| verified tombstone | Exact absence backed by a strictly bound typed proof and immutable finalization; ordinary contribution zero. |
| control transaction | Short critical section under the versioned lock that validates and atomically replaces the authoritative registry; never spans provider, Git, SSH, or readiness I/O. |

Canonical Phase 1 UX:

```sh
ac codespaces upgrade-control --yes
ac pool warm coding --count 2 --yes-cost
ac pool status coding
ac create fix-login --backend codespaces --pool coding
ac run fix-login -- opencode "Fix the login bug"
ac release fix-login --discard --yes --force-remote-data-loss
```

- `upgrade-control` is controlled in-place activation only. It has no fresh-root mode or fallback.
- `warm --count N` means reach ready-idle target N, not add N. Omission uses `desiredReady`; warm never shrinks.
- Exactly one nonzero warm invocation may own a pool. A concurrent warm returns `POOL_ACTIVE_OPERATION` immediately with zero probes and zero paid actions.
- `create --pool` is immediate lease-only. It performs no create, start, wait, fallback, keepalive, or arbitrary probe and rejects cost/machine/geo/wait/fallback options.
- Pool miss is exit `1`; stopped-only inventory returns `POOL_STOPPED`.
- An externally stopped leased resource remains task-owned. Explicit `ac start TASK --yes` may resume only that exact lease.
- Release requires `--discard`, `--yes`, and `--force-remote-data-loss`. Drain and recovery-discard require both destructive acknowledgements. Starting an exact stopped cleanup target additionally requires `--yes-cost`.
- No completion path automatically calls warm or signals later target maintenance.

Strict configuration adds:

```yaml
backends:
  codespaces:
    maxTotal: 4
    maxRunning: 2
    maxCreating: 1
    maxParallelCommandsPerWorkspace: 1
    pools:
      coding:
        desiredReady: 2
        maxIdle: 2
        releasePolicy: discard
```

`pools` defaults in memory to `{}` and never rewrites config. Pool names use the existing safe-name grammar. `desiredReady` is `0..maxIdle`, `maxIdle` is `1..maxTotal`, `desiredReady <= maxRunning`, Phase 1 policy is exactly `discard`, the command limit is exactly one, and every configured pool requires nonempty runtime readiness. Unknown keys fail before state/provider effects. Config load alone never creates or synchronizes a durable pool; the first explicit warm does.

## 5. Authorities and Writer-Protocol Fence

### 5.1 Authority Order

1. The versioned protocol marker determines whether a process may write the state root.
2. The strict registry solely owns resources, physical resources, pools, warm ownership, leases, command IDs/slots, lifecycle operations, recovery, reset parents/children, and capacity.
3. Exact provider readback proves remote facts for an already-recorded endpoint; it never creates ownership.
4. Metadata v3 preserves logical identity/history and projects registry state; it cannot admit mutation.
5. Secondary command files store transport details and exact owner binding; they never override registry authority.
6. Event journals are audit evidence, not transition authority.
7. Candidate lists are diagnostic-only.

### 5.2 Controlled In-Place Activation Only

Introduce:

```text
<stateDir>/codespaces/control/protocol.json
<stateDir>/codespaces/control/v2/lock
<stateDir>/codespaces/control/v2/registry.json
<stateDir>/codespaces/capacity/lock                 # permanent shipped-writer fence
```

`protocol.json` is strict, mode `0600`, and records protocol `codespaces-control/v2`, state, activation generation, minimum writer generation, and this audit shape:

```ts
interface ActivationQuiescenceV1 {
  proofVersion: 1;
  activationGeneration: string;
  stateRootId: string;
  maintenanceLeaseId: string;
  launcherEpoch: string;
  processAuthority: 'complete';
  startGate: 'closed';
  issuedClientCount: number;
  drainedAndReapedClientCount: number;
  activeClientCount: 0;
  startGateClosedAt: string;
  zeroClientsObservedAt: string;
  launcherAttestationId: string;
}
```

The record is audit data, not self-authenticating proof. Activation is allowed only when an external launcher/deployment authority provides a live, unforgeable maintenance capability and is the complete process authority for every process that can access this state root. Acquiring it MUST atomically:

1. Close the start gate to old and new Codespaces clients.
2. Enumerate every client previously issued access to the root.
3. Drain or terminate, wait for exit, and reap every such client, including a v1 process paused after metadata load or command admission.
4. Attest `activeClientCount: 0` for the same launcher epoch and state-root identity before the activation process performs its first state scan.
5. Prevent bypass launch through OS/container permissions for the entire activation and every crash/resume.

The activation process validates the live capability and attestation with the launcher. A caller-authored file, PID snapshot, CLI acknowledgement, prevention of new starts alone, an empty existing root, a random path under a principal shared with old clients, or a scan that merely finds no command receipt is insufficient. Shipped v1 writers cannot check a new epoch, so an epoch without actual drain is not allowed.

This contract deliberately does not offer a fresh-state-root bootstrap. If complete process authority, drain, reaping, or zero-client proof cannot be established, activation is unsupported. Selecting an empty or new path does not waive the prerequisite and ordinary operations cannot initialize it.

After zero-client proof, activation MUST:

1. Acquire the legacy capacity lock and strictly reject unreadable state, active lifecycle work, dispatch-possible create ambiguity, and active/unknown/request-only command state.
2. Durably publish `protocol.state: activating` with activation generation and `ActivationQuiescenceV1`.
3. Deterministically migrate every shipped record and intent without provider discovery or mutation.
4. Make metadata version 3 old-reader-incompatible.
5. While retaining the old lock, remove its owner and durably write the permanent ownerless fence. Shipped acquisition times out rather than reclaiming an unverifiable ownerless lock (`src/codespaces-capacity.ts:95-128`, `src/codespaces-capacity.ts:159-170`).
6. Publish `active` only after registry, metadata, no-dispatch finalizations, and fence are durable.
7. Use only the v2 control lock thereafter and never remove the old fence.

Activation resume requires the same activation generation, state-root ID, launcher epoch, maintenance lease, closed gate, and newly revalidated zero-active-client condition. A crash never reopens launch. Any mismatch fails before migration/fence writes. The permanent fence protects against old binaries launched later; actual zero-client proof protects against a writer that already loaded v1 authority.

Every ordinary mutating entry point reads and requires an active supported protocol before mutable authority. `upgrade-control --resume` is the sole exception and may mutate only the exact `activating` generation under the same live launcher capability and newly proven zero-client condition. Missing, activating, corrupt, or unsupported protocol otherwise returns a stable blocker before provider/SSH effects. Read-only status may report but never initialize or reconstruct from GitHub.

### 5.3 One Resource-Authoritative Transaction

Under the v2 lock, one atomic registry replacement linearizes:

- create/start/reset capacity reservation and finalization;
- pool-level warm ownership plus each warm action;
- lease reservation, activation, refusal, absence, and rollback-idle reservation;
- globally unique command-ID/slot admission, dispatch authorization, no-dispatch terminalization, terminalization, and unknown recovery;
- stop, release, every pre-delete rollback, delete, drain, and recovery cleanup;
- legacy binding, pre-dispatch cancellation, ordinary tombstone proof, and reset target tombstone proof;
- all canonical capacity sampling.

Provider, Git, SSH, helper, and readiness I/O never run while locked. Every external action is preceded by a durable operation UUID, finite checkpoint, operation kind, starting states, admitted resource generation, immutable owner epochs, mutable record generations, exact endpoint binding, mutation-dispatch flag, and absolute capacity reservation when needed. Finalizers require every field to match. Stale finalizers make no write. Every writer revalidates its operation/generation immediately before a remote mutation. Losing a generation race means zero remote mutations. Dead lock-owner reclamation never clears registry barriers.

## 6. Strict Phase 1 State Contract

### 6.1 Core Types

```ts
type PoolReasonCode =
  | 'POOL_MISS' | 'POOL_STOPPED' | 'POOL_NOT_READY' | 'POOL_POLICY_MISMATCH'
  | 'POOL_DRAINING' | 'POOL_RECOVERY_REQUIRED' | 'POOL_QUARANTINED'
  | 'POOL_ACTIVE_OPERATION' | 'POOL_COMMAND_ACTIVE' | 'POOL_COMMAND_UNKNOWN'
  | 'DUPLICATE_TASK' | 'STALE_GENERATION' | 'COMMAND_ID_CONFLICT'
  | 'COMMAND_OWNER_MISMATCH' | 'COMMAND_RESOURCE_ABSENT'
  | 'COMMAND_NOT_DISPATCHED' | 'RESOURCE_ABSENT'
  | 'IDENTITY_INCOMPLETE' | 'IDENTITY_MISMATCH' | 'PROVIDER_UNREACHABLE'
  | 'READINESS_FAILED' | 'READINESS_TIMEOUT'
  | 'REMOTE_GIT_DIRTY' | 'REMOTE_GIT_UNPUSHED' | 'REMOTE_GIT_NO_UPSTREAM'
  | 'REMOTE_GIT_DETACHED' | 'REMOTE_GIT_ORIGIN_MISMATCH'
  | 'REMOTE_GIT_UNPUBLISHED_REF' | 'REMOTE_GIT_PREFLIGHT_UNAVAILABLE'
  | 'CAPACITY_MAX_IDLE' | 'CAPACITY_MAX_TOTAL' | 'CAPACITY_MAX_RUNNING'
  | 'CAPACITY_MAX_CREATING' | 'STATE_CORRUPT' | 'STATE_WRITE_FAILED'
  | 'DELETE_UNCONFIRMED' | 'RECOVERY_TOKEN_MISMATCH'
  | 'RECOVERY_KIND_UNSUPPORTED' | 'RECOVERY_LIVE_RESOURCE'
  | 'LEGACY_ENVIRONMENT_UNPROVEN' | 'LEGACY_TOMBSTONE_UNVERIFIED'
  | 'CONTROL_PROTOCOL_UPGRADE_REQUIRED' | 'CONTROL_PROTOCOL_ACTIVATING'
  | 'RESET_RECOVERY_REQUIRED' | 'RESET_CLEANUP_UNPROVEN';

interface CapacityContributionV1 {
  total: 0 | 1;
  running: 0 | 1;
  creating: 0 | 1;
}

interface PoolRecordV1 {
  poolId: string;
  name: string;
  generation: string;
  state: 'active' | 'draining' | 'drained' | 'blocked';
  desiredReady: number;
  maxIdle: number;
  releasePolicy: 'discard';
  blockedReason: PoolReasonCode | null;
  activeWarm: null | {
    warmInvocationId: string;
    warmGeneration: string;
    target: number;
    state: 'planning' | 'observing' | 'paid-action' | 'recovery-required';
    currentOperationId: string | null;
    currentResourceId: string | null;
    startedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

interface CompatibilityRequestV1 {
  githubHost: 'github.com';
  actorId: string;
  repositoryId: string;
  repositoryOwnerId: string;
  repositoryOwner: string;
  repositoryName: string;
  requestedRef: string;
  expectedOid: string;
  expectedOrigin: string;
  devcontainerPath: string;
  devcontainerBlobOid: string;
  requestedMachine: string;
  requestedGeo: string;
  idleTimeoutMinutes: number;
  retentionPeriodMinutes: number;
  allowVisibilityChanges: false;
  allowPublic: false;
  allowedRemoteSecretNames: string[];
  allowCodespaceGitCredential: boolean;
}

interface CompatibilityTupleV1 extends CompatibilityRequestV1 {
  billingOwnerId: string;
  observedMachine: string;
  observedLocation: string;
}

interface ExactRemoteIdentityV1 {
  githubHost: 'github.com';
  codespaceId: string;
  name: string;
  environmentId: string | null;
  environmentIdProvenance: 'provider-observed' | 'legacy-synthesized-unproven';
  ownerId: string;
  ownerLogin: string;
  billingOwnerId: string;
  repositoryId: string;
  repositoryOwnerId: string | null;
  repositoryOwnerIdProvenance: 'provider-observed' | 'legacy-missing';
  repositoryOwner: string;
  repositoryName: string;
  machine: string;
  location: string;
  createdAt: string;
}

type AbsenceOperationKindV1 =
  | 'create-reconcile' | 'warm-observe' | 'readiness-reconcile'
  | 'lease-verify' | 'command-reconcile-absence'
  | 'start-reconcile' | 'stop-reconcile'
  | 'release-reconcile-pre-delete' | 'release-delete'
  | 'drain-reconcile-pre-delete' | 'drain-delete'
  | 'legacy-reconcile' | 'legacy-cleanup-pre-delete' | 'legacy-cleanup'
  | 'recovery-delete-pre-delete' | 'recovery-delete';

interface AbsenceProofV1 {
  proofVersion: 1;
  proofId: string;
  finalizationId: string;
  operationId: string;
  finalizerOperationId: string;
  operationKind: AbsenceOperationKindV1;
  sourceKind: NonCommandOperationV1['kind'] | 'command';
  sourceCheckpoint: string;
  sourceAuthorityGeneration: string;
  sourceOwnerEpoch: string | null;
  resourceId: string;
  physicalResourceId: string;
  incarnationId: string;
  githubHost: 'github.com';
  recordedCodespaceId: string;
  recordedCodespaceName: string;
  endpointKind: 'exact-recorded-codespace';
  endpoint: string;
  observedMethod: 'GET';
  typedHttpStatus: 404;
  classification: 'typed-http-404';
  admittedResourceGeneration: string;
  tombstoneResourceGeneration: string;
  observedAt: string;
}

interface FinalizedAbsenceOperationV1 {
  finalizationId: string;
  operationId: string;
  finalizerOperationId: string;
  operationKind: AbsenceOperationKindV1;
  sourceKind: AbsenceProofV1['sourceKind'];
  sourceCheckpoint: string;
  sourceAuthorityGeneration: string;
  sourceOwnerEpoch: string | null;
  resourceId: string;
  physicalResourceId: string;
  incarnationId: string;
  githubHost: 'github.com';
  recordedCodespaceId: string;
  recordedCodespaceName: string;
  exactEndpoint: string;
  admittedResourceGeneration: string;
  tombstoneResourceGeneration: string;
  result: 'typed-exact-get-404';
  finalizedAt: string;
}

interface OperationExecutionOwnerV1 {
  ownerEpoch: string;
  clientId: string;
  processId: number;
  processStartIdentity: string;
  acquiredAt: string;
}

interface OperationBaseV1 {
  operationId: string;
  fromResourceState: ResourceStateV1;
  fromLeaseState: PoolLeaseV1['state'] | null;
  admittedResourceGeneration: string;
  leaseGeneration: string | null;
  admittedLeaseRecordGeneration: string | null;
  exactEndpoint: string | null;
  capacityReservation: CapacityContributionV1 | null;
  warmInvocationId: string | null;
  warmGeneration: string | null;
  executionOwner: OperationExecutionOwnerV1;
  startedAt: string;
}

type NonCommandOperationV1 =
  | OperationBaseV1 & {
      kind: 'create';
      checkpoint: 'create-intent';
      mutationDispatchMayHaveOccurred: false;
    }
  | OperationBaseV1 & {
      kind: 'create';
      checkpoint: 'create-dispatched' | 'create-response-recorded';
      mutationDispatchMayHaveOccurred: true;
    }
  | OperationBaseV1 & {
      kind: 'warm-observe';
      checkpoint: 'observing';
      mutationDispatchMayHaveOccurred: false;
    }
  | OperationBaseV1 & {
      kind: 'readiness';
      checkpoint: 'readiness-verifying';
      mutationDispatchMayHaveOccurred: false;
      readinessContext: 'create' | 'warm' | 'start-pool-idle' | 'start-lease' | 'start-cleanup';
    }
  | OperationBaseV1 & {
      kind: 'lease-verify';
      checkpoint: 'lease-verifying';
      mutationDispatchMayHaveOccurred: false;
    }
  | OperationBaseV1 & {
      kind: 'start';
      checkpoint: 'start-admitted';
      mutationDispatchMayHaveOccurred: false;
      startContext: 'pool-idle' | 'leased-task' | 'cleanup-only';
    }
  | OperationBaseV1 & {
      kind: 'start';
      checkpoint: 'start-dispatched' | 'start-readback' | 'start-readiness-verifying';
      mutationDispatchMayHaveOccurred: true;
      startContext: 'pool-idle' | 'leased-task' | 'cleanup-only';
    }
  | OperationBaseV1 & {
      kind: 'stop';
      checkpoint: 'stop-admitted';
      mutationDispatchMayHaveOccurred: false;
    }
  | OperationBaseV1 & {
      kind: 'stop';
      checkpoint: 'stop-dispatched' | 'stop-readback';
      mutationDispatchMayHaveOccurred: true;
    }
  | OperationBaseV1 & {
      kind: 'release';
      checkpoint:
        | 'release-admitted' | 'release-identity-verifying'
        | 'release-git-verifying';
      mutationDispatchMayHaveOccurred: false;
    }
  | OperationBaseV1 & {
      kind: 'release';
      checkpoint: 'release-delete-dispatched' | 'release-absence-readback';
      mutationDispatchMayHaveOccurred: true;
    }
  | OperationBaseV1 & {
      kind: 'drain-delete' | 'legacy-cleanup' | 'recovery-delete';
      checkpoint:
        | 'cleanup-admitted' | 'cleanup-identity-verifying'
        | 'cleanup-git-verifying';
      mutationDispatchMayHaveOccurred: false;
    }
  | OperationBaseV1 & {
      kind: 'drain-delete' | 'legacy-cleanup' | 'recovery-delete';
      checkpoint: 'cleanup-delete-dispatched' | 'cleanup-absence-readback';
      mutationDispatchMayHaveOccurred: true;
    }
  | OperationBaseV1 & {
      kind: 'legacy-bind';
      checkpoint: 'legacy-identity-binding';
      mutationDispatchMayHaveOccurred: false;
    }
  | OperationBaseV1 & {
      kind: 'legacy-reconcile';
      checkpoint: 'legacy-observing';
      mutationDispatchMayHaveOccurred: false;
    };

interface RecoveryCheckpointV1 {
  operation: NonCommandOperationV1;
  reasonCode: PoolReasonCode;
  recordedAt: string;
}

interface FinalizedOperationV1 {
  finalizationId: string;
  operationId: string;
  finalizerOperationId: string;
  resourceId: string;
  kind: NonCommandOperationV1['kind'];
  sourceCheckpoint: string;
  sourceAuthorityGeneration: string;
  sourceOwnerEpoch: string;
  finalResourceGeneration: string;
  result:
    | 'not-dispatched' | 'ready' | 'stopped' | 'known-running'
    | 'blocked' | 'lease-activated' | 'lease-refused'
    | 'release-rolled-back' | 'cleanup-rolled-back'
    | 'legacy-bound-running' | 'legacy-bound-stopped'
    | 'legacy-cleanup-required';
  finalizedAt: string;
}

type ResourceStateV1 =
  | 'create-intent' | 'provisioning' | 'readiness-verifying' | 'observing'
  | 'ready-idle' | 'stopped-idle' | 'blocked-idle'
  | 'lease-verifying' | 'leased' | 'starting' | 'stopping'
  | 'releasing' | 'deleting' | 'recovery-required' | 'quarantined'
  | 'legacy-running' | 'legacy-stopped' | 'legacy-recovery-required'
  | 'legacy-cleanup-required' | 'legacy-tombstone-unverified'
  | 'tombstoned';

type CommandOwnerV2 =
  | {
      kind: 'pool-lease';
      taskId: string;
      taskName: string;
      resourceId: string;
      incarnationId: string;
      leaseId: string;
      leaseGeneration: string;
    }
  | {
      kind: 'legacy-workspace';
      workspaceId: string;
      workspaceName: string;
      resourceId: string;
      incarnationId: string;
    };

type CommandAdmissionCheckpointV1 =
  | 'authority-reserved' | 'request-published' | 'continuity-verifying';

type CommandCheckpointV1 =
  | CommandAdmissionCheckpointV1
  | 'dispatch-authorized' | 'helper-outcome-unknown' | 'terminal';

interface CommandNoDispatchProofV1 {
  proofVersion: 1;
  proofId: string;
  commandId: string;
  operationId: string;
  finalizerOperationId: string;
  owner: CommandOwnerV2;
  sourceCheckpoint: CommandAdmissionCheckpointV1;
  sourceCommandRecordGeneration: string;
  sourceResourceGeneration: string;
  sourceLeaseRecordGeneration: string | null;
  dispatchMayHaveOccurred: false;
  terminalCommandRecordGeneration: string;
  finalizedAt: string;
}

interface CommandAuthorityV1 {
  commandId: string;
  recordGeneration: string;
  owner: CommandOwnerV2;
  operationId: string;
  admittedResourceGeneration: string;
  admittedLeaseRecordGeneration: string | null;
  state: 'admitting' | 'active' | 'unknown' | 'terminal' | 'legacy-terminal';
  checkpoint: CommandCheckpointV1;
  dispatchMayHaveOccurred: boolean;
  noDispatchProof: CommandNoDispatchProofV1 | null;
  admittedAt: string;
  terminalAt: string | null;
  terminalKind:
    | 'not-dispatched' | 'exited' | 'cancelled'
    | 'terminated-by-stop' | 'resource-absent' | null;
}

interface ResourceAuthorityV1 {
  resourceId: string;
  physicalResourceId: string;
  incarnationId: string;
  generation: string;
  kind: 'pool' | 'legacy-workspace';
  poolId: string | null;
  legacyWorkspaceName: string | null;
  creation: {
    requestId: string | null;
    createdByAgentContainers: true;
    dispatchCheckpoint:
      | 'intent-recorded' | 'dispatched' | 'response-recorded'
      | 'identity-verified' | 'legacy-imported';
  };
  request: CompatibilityRequestV1 | null;
  compatibility: CompatibilityTupleV1 | null;
  remote: ExactRemoteIdentityV1 | null;
  state: ResourceStateV1;
  providerRawState: string | null;
  lastObservedAt: string | null;
  blockedReason: PoolReasonCode | null;
  leaseId: string | null;
  commandSlot: null | {
    commandId: string;
    owner: CommandOwnerV2;
    commandOperationId: string;
    commandRecordGeneration: string;
    checkpoint: CommandCheckpointV1;
    admittedResourceGeneration: string;
    admittedLeaseRecordGeneration: string | null;
    state: 'admitting' | 'active' | 'unknown';
    admittedAt: string;
  };
  pristineProof: null | {
    terminal: 'ready';
    operationId: string;
    warmInvocationId: string | null;
    incarnationId: string;
    expectedOid: string;
    verifiedAt: string;
    providerState: string;
  };
  leaseBaselineProof: null | {
    leaseId: string;
    leaseGeneration: string;
    pristineOperationId: string;
    expectedOidAtActivation: string;
    activatedAt: string;
  };
  activeOperation: NonCommandOperationV1 | null;
  recovery: RecoveryCheckpointV1 | null;
  legacyRecovery: LegacyOpaqueRecoveryV1 | null;
  quarantine: null | {
    reasonCode: PoolReasonCode;
    operationId: string;
    recordedAt: string;
  };
  cleanup: {
    deleteDispatched: boolean;
    absenceProof: AbsenceProofV1 | null;
    absenceFinalizationId: string | null;
    deletedAt: string | null;
  };
  createdAt: string;
}

interface PoolLeaseV1 {
  leaseId: string;
  leaseGeneration: string;
  recordGeneration: string;
  poolId: string;
  resourceId: string;
  incarnationId: string;
  taskId: string;
  taskName: string;
  state:
    | 'verifying' | 'active' | 'releasing' | 'recovery-required'
    | 'released-discarded' | 'released-resource-absent';
  idleReturnReservation: 0 | 1;
  createdAt: string;
  activatedAt: string | null;
  releasedAt: string | null;
  releaseOperationId: string | null;
  releaseReasonCode: PoolReasonCode | null;
}

interface LegacyNoDispatchProofV1 {
  proofVersion: 1;
  reservationId: string;
  terminalReservationGeneration: string;
  requestId: string;
  sourceCheckpoint: 'intent-recorded';
  dispatchMayHaveOccurred: false;
  providerResponseRecorded: false;
  matchedResourceRecorded: false;
  activationGeneration: string;
  stateRootId: string;
  maintenanceLeaseId: string;
  launcherEpoch: string;
  zeroClientAttestationId: string;
  finalizedAt: string;
}

interface LegacyReservationV1 {
  reservationId: string;
  generation: string;
  operationId: string;
  activationGeneration: string;
  sourceKind: 'legacy-create-intent' | 'legacy-operation';
  requestId: string;
  recordedCodespaceId: string | null;
  recordedCodespaceName: string | null;
  checkpoint: string;
  dispatchMayHaveOccurred: boolean;
  contribution: CapacityContributionV1;
  state: 'reserved' | 'recovery-required' | 'quarantined' | 'terminal-not-dispatched';
  noDispatchProof: LegacyNoDispatchProofV1 | null;
  reasonCode: PoolReasonCode | null;
  createdAt: string;
  terminalAt: string | null;
}

interface LegacyOpaqueRecoveryV1 {
  migrationGeneration: string;
  recordedOperationId: string;
  recordedReason: string;
  recordedAt: string;
  classifiedKind: 'remove-unknown' | 'start-stop-unknown' | 'other-unknown';
  resolution: null | {
    reconcileOperationId: string;
    outcome: 'running' | 'stopped' | 'cleanup-required' | 'absent';
    resolvedAt: string;
  };
}

interface CodespacesControlRegistryV1 {
  schemaVersion: 1;
  writerProtocol: 'codespaces-control/v2';
  generation: string;
  createdAt: string;
  updatedAt: string;
  pools: Record<string, PoolRecordV1>;
  resources: Record<string, ResourceAuthorityV1>;
  leases: Record<string, PoolLeaseV1>;
  commands: Record<string, CommandAuthorityV1>;
  legacyReservations: Record<string, LegacyReservationV1>;
  finalizedOperations: Record<string, FinalizedOperationV1>;
  finalizedAbsenceOperations: Record<string, FinalizedAbsenceOperationV1>;
}
```

`NonCommandOperationV1.exactEndpoint` is null only for `create-intent` or a dispatched create lacking response identity. Every readiness, warm, lease, start, stop, release, cleanup, legacy-bind, and legacy-reconcile checkpoint requires the canonical non-null recorded endpoint. A create response-recorded checkpoint also requires it. Cross-field validation rejects every other null.

Metadata v3 carries logical name/workspace ID, registry resource/incarnation/generation, actor/host, repository and owner IDs, requested ref/OID, Dev Container path/blob, exact remote identity, identity completeness, lifecycle projection, and cleanup proof projection. It is strict, old-reader-incompatible, and cannot independently mutate authority.

Command request/status/offset files use schema v2, repeat the complete `CommandOwnerV2`, and retain only argv count, mode, safe relative cwd, structural helper status, decimal offsets, and timestamps. They contain no argv or output. Existing command ID attach requires all owner fields with AND semantics. Terminal IDs are never reused while history exists.

### 6.2 Absence and Terminal-Finalization Validation

A typed provider error is not by itself a capacity update. Every ordinary absence finalizer atomically consumes the exact active/recovery operation into immutable `finalizedAbsenceOperations`, stores the independently keyed proof, tombstones the resource, and applies the source-specific lease/warm/reservation disposition. Before any zero ordinary contribution, the strict registry validator MUST:

1. Require every proof and finalization field and reject unknown keys.
2. Require exactly one finalization at `proof.finalizationId`; map key and embedded ID agree.
3. Match proof and finalization source kind/checkpoint/authority generation/owner epoch, resource, physical resource, incarnation, recorded Codespace ID/name, host, original/finalizer operation, operation kind, admitted/tombstone generation, endpoint, and time against each other and immutable enclosing authority with AND semantics.
4. Recompute the canonical percent-encoded exact Codespace GET endpoint and require byte equality everywhere.
5. Require method GET, typed status 404, and typed adapter classification. Message matching and DELETE 404 are insufficient.
6. Require the tombstone generation to be the fresh generation written by the same atomic finalizer.
7. Reject orphaned history, caller-supplied proof, copied proof/history, cross-operation, cross-policy, cross-resource, and stale proof before capacity sampling.

The strict source mapping is:

| Source | Required absence operation kind |
| --- | --- |
| create response/readiness | `create-reconcile` or `readiness-reconcile` according to the consumed operation |
| warm observation/readiness | `warm-observe` or `readiness-reconcile` |
| lease verification | `lease-verify` |
| admitting/unknown command resource readback | Only unknown commands may use `command-reconcile-absence`; admitting commands use no provider call and terminate no-dispatch |
| every start checkpoint | `start-reconcile` |
| every stop checkpoint | `stop-reconcile` |
| release before DELETE dispatch | `release-reconcile-pre-delete` |
| release after DELETE dispatch | `release-delete` |
| drain/legacy/recovery cleanup before DELETE dispatch | Matching `*-reconcile-pre-delete` kind |
| drain/legacy/recovery cleanup after DELETE dispatch | Matching delete kind |
| `legacy-bind/legacy-identity-binding` | `legacy-reconcile` |
| `legacy-reconcile/legacy-observing` | `legacy-reconcile` |

Every non-absence operation finalizer similarly consumes the exact operation into `finalizedOperations` in the same transaction as its state/lease/warm/reservation update. No operation simply disappears.

### 6.3 Registry Invariants

Strict validation runs before every write and every provider, Git, SSH, helper, or readiness effect:

1. Map keys equal embedded IDs. Unknown keys, malformed JSON, unsupported versions, symlinks, hard-link ambiguity, broken references, and duplicate IDs fail closed.
2. Every resource has one physical ID. Pool create lineage has a request ID; migrated history may preserve null rather than fabricate one.
3. Every nonterminal lease/resource pointer is bidirectionally exact. No task ID/name, physical resource, or live incarnation has two nonterminal leases.
4. A verifying lease has `idleReturnReservation: 1`, exact `lease-verifying` resource, and exact lease operation. Recovery retains the reservation. Every other Phase 1 lease state has zero.
5. Every admitting command has exactly one matching command/slot pair at `authority-reserved`, `request-published`, or `continuity-verifying`, `dispatchMayHaveOccurred: false`, null terminal fields, and null no-dispatch proof.
6. Every active command has one matching pair at `dispatch-authorized`, `dispatchMayHaveOccurred: true`, exact owner/generations, resource `leased`, and active lease where applicable.
7. Every unknown command has one complete command/slot/resource recovery tuple and pool lease recovery where applicable, checkpoint `helper-outcome-unknown`, and `dispatchMayHaveOccurred: true`.
8. Terminal `not-dispatched` requires matching immutable `CommandNoDispatchProofV1`; every other terminal kind requires that proof null.
9. Command and slot command ID, owner, operation, command generation, checkpoint, admitted resource generation, and admitted lease generation match with AND semantics.
10. A no-dispatch finalizer consumes the exact source command generation, rotates command/resource/lease-record generations as applicable, clears only that slot, and preserves the same immutable lease epoch. A paused writer that loses this generation race performs zero helper/SSH calls.
11. Unknown-command owner mismatch may add quarantine evidence but cannot clear or structurally break the recovery tuple.
12. `ready-idle` requires exact create lineage, non-null provider-observed environment and repository-owner identity, immutable compatibility, terminal pristine proof for the current incarnation, and no lease/slot/operation/recovery/quarantine.
13. Recorded ready-idle is not current warm or lease proof. Warm and lease each require operation-scoped fresh proof.
14. `leased` preserves historical baseline but permits task-owned repository changes.
15. `releasing` has exactly one release operation, one releasing lease, and null command slot. Every pre-delete live rollback restores only the same task and immutable lease epoch. It never returns the resource to idle inventory.
16. Recovery carries the complete exact operation. Every finite checkpoint maps to one recovery row in section 9.10. It is never ordinary warm, lease, command, cleanup, or reset eligibility.
17. Verified tombstone has null lease/slot/operation/recovery, completed cleanup, and valid bound absence proof backed by exactly one immutable finalization. Only this form contributes zero ordinary capacity.
18. Legacy unverified tombstone has no proof and conservatively contributes total/running until exact reconciliation.
19. No two service-eligible or independently live resources share Codespace ID, name, or environment ID. Phase 2 immutable same-Codespace predecessor/successor history is one exception. The only non-historical exception is the exact shared-target quarantine in section 11: two mutually exclusive, non-service-eligible possible incarnation authorities may share one physical/Codespace identity only while both point bidirectionally to the same `shared-codespace` target, reset operation, and nonconsumed parent reservation. They have no command or executable lease authority and are counted as one target under the full reset floor. They may undergo the exact atomic reset-discard parent-admission/ownership-transfer transaction while remaining quarantined. Only their exact target child may perform an allowlisted physical cleanup action, and only its finalizer may change durable target disposition or tombstone them. No two independently live incarnations are permitted.
20. Provider-observed environment and repository-owner identity is immutable. One-time legacy completion follows only the exact binding algorithm.
21. Every create/start operation stores absolute reservation `{ total: 1, running: 1, creating: 1 }` from admission through terminal proof. No later dispatch admission exists.
22. Every non-null `activeWarm` is the sole warm owner. A finalizer atomically publishes the next action or clears/retains recovery ownership; proof cannot be stolen.
23. `terminal-not-dispatched` legacy reservations have contribution zero and an exact activation-bound proof. Any response, dispatch possibility, resource match, or quiescence mismatch forbids the state.
24. Every operation checkpoint has its exact dispatch flag, endpoint, owner, generation, reservation, and source-state combination. An unrecognized combination fails before sampling or effects.
25. Resource, lease-record, command-record, pool/warm, operation-owner, and legacy-reservation generation tokens rotate on modification. Immutable owner epochs, command/operation IDs, and finalized history do not.
26. No operation or lease expires by time. Reconciliation ownership may be claimed only by exact generation CAS; the original writer must revalidate that generation before any mutation.

### 6.4 Phase 1 State Transitions

```text
create-intent -> provisioning -> readiness-verifying -> ready-idle
      | terminal no-dispatch               |-> blocked/stopped/tombstoned
      `-> immutable terminal history       `-> recovery/quarantine

ready-idle -> observing -> ready-idle | stopped-idle | blocked-idle
                           | tombstoned | recovery | quarantined

ready-idle -> lease-verifying -> leased
                 |               |-> ready-idle/stopped-idle/blocked-idle
                 |               `-> tombstoned on typed exact GET 404
                 `-> recovery with idle-return reservation retained

stopped-idle -> starting -> readiness-verifying -> ready-idle
leased -> starting/stopping -> same leased task in known running/stopped state
leased -> releasing -> deleting -> tombstoned
   ^          | pre-delete exact live rollback only
   `----------'

command admitting -> terminal(not-dispatched)
command admitting -> active -> terminal
command active -> command unknown + resource/lease recovery
command unknown -> terminal + same lease active on exact helper proof
command unknown -> terminal(resource-absent) + tombstone
                   + released-resource-absent lease on bound GET 404
```

Typed exact GET 404 is a legal terminal outcome from every readiness, start, stop, release, and cleanup checkpoint. Source-specific rules in section 9.10 determine lease/warm/reservation cleanup. No absence outcome replenishes, starts, creates, adopts, or returns a released task environment to idle inventory.

## 7. Eligibility, Exact Identity, and Complete Git Preservation

### 7.1 Exact Handle and Compatibility

A pooled handle contains logical task ID/name, lease ID/immutable lease generation, resource ID, incarnation ID, Codespace ID/name, non-null environment ID, and mutable record generations. One authoritative record is selected by immutable registry key; every field then matches that same record with AND semantics. No OR, scan-order, name-only, fallback, nullable-environment, or cross-generation resolution is permitted. Duplicate/colliding identity fails before provider, SSH, helper, or state effects.

Pristine compatibility compares explicit actor, provider owner, repository/repository owner, billing owner, requested ref/expected OID, expected origin, Dev Container path/blob, requested/observed machine and location, exact Codespace ID/name/environment/creation, idle/retention, private port/visibility, sorted named-secret names, and Git-credential capability. Near matches and listing results never qualify.

### 7.2 Non-Substitutable Eligibility Modes

- **Pristine allocation:** Warm, create/start finalization, and lease activation. Requires active compatible pool, exact app-create lineage, real immutable identity, running state, private ports, exact repository root/origin/expected HEAD, SSH/helper, nonempty readiness, and no barrier.
- **Lease continuity:** Post-activation command/attach/cancel/stop/resume. Requires exact handle/lease/provider/incarnation, barriers, ports, SSH/helper, and running/stopped state as appropriate. It MUST NOT require baseline HEAD, clean Git, original branch/ref/origin, or pristine readiness.
- **Ordinary cleanup:** Release/drain for non-recovery resources. Validates recorded immutable identity and null command/other-operation/recovery/quarantine, not current allocation policy.
- **Recovery cleanup:** Only exact generation-bound cleanup checkpoints. It cannot clear command/reset ambiguity, adopt, or edit arbitrary state.
- **Command recovery:** Either exact admitting command no-dispatch terminalization or exact unknown command owner convergence. Admitting recovery performs no provider/SSH/helper call. Unknown recovery may inspect/cancel only that helper or exact-GET its recorded resource for typed absence.
- **Operation recovery:** Only exact finite create/readiness/warm/lease/start/stop/release/pre-delete checkpoints. It performs only the matrix's allowlisted read-only proof.
- **Reset recovery/discard:** Phase 2 only, exact tuple, parent, reservation, and independently generated physical-target child operations.

### 7.3 Complete All-Retained-Git-Data Preservation Proof

This proof MUST land and pass before any Phase 1 pool implementation merges. Every live-resource deletion path, including release, drain, legacy/recovery cleanup, Phase 2 pre-reset destructive dispatch, and Phase 2 reset-failure discard, runs package-owned fixed-argv probes through a trusted channel and MUST:

1. Verify exact repository root and canonical expected `origin` URL.
2. Use NUL-safe porcelain to reject index, worktree, initialized-submodule worktree, untracked, merge, rebase, sequencer, and other in-progress worktree changes.
3. Require attached, non-unborn `HEAD` on a local branch.
4. NUL-frame and strictly parse every ref under `refs/*`, including heads, remotes, tags, stash, notes, replace, bisect, worktree, and custom namespaces.
5. Through fixed Git plumbing, enumerate every standard root/per-worktree pseudoref that can retain an object, including `ORIG_HEAD`, `FETCH_HEAD`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`, `AUTO_MERGE`, and bisect/sequencer/worktree heads.
6. Enumerate every reflog with fixed machine framing, including HEAD, branch, remote, stash, and worktree logs, and validate every old/new object OID. Reflog data is reachable repository data for this deletion policy.
7. Reject unsupported repository extensions and additional linked-worktree administrative state unless the proof implementation explicitly enumerates every associated ref, pseudoref, and reflog.
8. Independently inventory the canonical `$GIT_COMMON_DIR/modules` tree for the superproject and recursively for every retained module repository. This commonly includes `.git/modules` and includes initialized, deinitialized, unregistered, and residual module Git directories.
9. Never infer that absence of a submodule worktree or `.git/config` registration means absence of repository data. `git submodule foreach` alone is insufficient.
10. Map each retained module administrative repository uniquely to trusted `.gitmodules` metadata, exact superproject gitlink, canonical expected origin, and canonical administrative path before proving it.
11. For an initialized module, prove worktree state and the complete repository-data rules. For a deinitialized module, which has no worktree to inspect, still prove all refs, pseudorefs, reflogs, upstreams, advertised-origin roots, and reachability.
12. Recurse into each retained module repository's own common `modules` tree. A stale/deleted module with no trusted mapping, duplicate mapping, path escape, symlink, unreadable entry, malformed Git directory, unsupported layout, missing expected gitlink/origin, or unbounded/ambiguous traversal fails closed.
13. Fetch a fresh, strictly parsed advertised-ref snapshot from each repository's expected origin without mutating local refs.
14. Require every local branch to have one resolvable upstream in the expected `origin` namespace, exact validated OIDs, and zero commits in `upstream..local`.
15. Permit an `origin` remote-tracking ref only when it maps to an advertised expected-origin branch with the exact OID. Reject other remotes and stale/mismatched tracking refs.
16. Permit a tag only when the exact tag object and, for annotated tags, peeled target match the advertised expected-origin tag. Otherwise reject it.
17. Unconditionally reject `refs/stash`, `refs/notes/*`, `refs/replace/*`, task-created custom refs, and every unsupported namespace as `REMOTE_GIT_UNPUBLISHED_REF`.
18. Require every OID retained by an allowed ref, recognized pseudoref, or any reflog entry in the superproject or any retained module repository to be reachable from that repository's validated advertised expected-origin roots. `FETCH_HEAD` and other recognized pseudorefs pass only when all OIDs do.
19. Treat malformed framing, invalid ref/OID, timeout, unexpected exit, recursion/administrative ambiguity, unbounded output, unsupported storage/extension, or unreadable proof as `REMOTE_GIT_PREFLIGHT_UNAVAILABLE`.

No shell interpolation is allowed. Neither destructive acknowledgement bypasses preservation. The proof does not claim to recover truly unreachable objects or data outside Git repositories, but it covers every object retained by local refs, supported pseudorefs, or reflogs in the superproject and every retained module Git directory.

A clean superproject with a stash, task tag not present upstream, note, custom ref, reset-away unpushed reflog/`ORIG_HEAD` commit, or equivalent data retained only under `.git/modules` after `git submodule deinit -f` MUST perform zero DELETE and zero reset-primitive calls. Unknown residual module administration also performs zero destructive calls and retains authority/capacity.

## 8. Capacity and Cost Contract

### 8.1 One Canonical Phase 1 Sampler

One sampler validates protocol, registry, metadata projections, command barriers, legacy reservations, and Phase 2 parent/target reservations under the control lock. It groups only by proven physical-resource identity. For each Phase 1 physical resource it computes the component-wise maximum of resource base contribution, active/recovery operation's absolute reservation, and any exact legacy reservation mapped to that resource. It never adds an absolute operation vector to the same resource base.

| State/evidence | total | running | creating |
| --- | ---: | ---: | ---: |
| Valid bound proof-bearing tombstone | 0 | 0 | 0 |
| Create intent through readiness finalization | 1 | 1 | 1 |
| Exact stopped resource with no possible start/create | 1 | 0 | 0 |
| Start admitted/in flight/ambiguous | 1 | 1 | 1 |
| Observing, ready-idle, lease-verifying, leased, stopping, releasing, or deleting while not freshly proven stopped | 1 | 1 | 0 |
| Blocked/cleanup target freshly proven running | 1 | 1 | 0 |
| Blocked/cleanup target freshly proven stopped with no possible start/create | 1 | 0 | 0 |
| Provider unreachable and not freshly proven stopped | 1 | 1 | 0 |
| Recovery/quarantine with possible create/start | 1 | 1 | 1 |
| Recovery/quarantine with exact live state and no possible create/start | 1 | 1 unless freshly proven stopped | 0 |
| Legacy unverified tombstone | 1 | 1 | 0 |
| Legacy pre-dispatch terminal with valid no-dispatch proof | 0 | 0 | 0 |
| Other legacy reservation | Its recorded conservative vector; never zero without terminal proof |

Every create, including its first intent transaction, reserves `{ total: 1, running: 1, creating: 1 }` and tests post-replacement limits atomically. A provider call cannot occur unless that reservation exists. Every start reserves the same absolute vector from `start-admitted`. It weakens only on atomic no-dispatch/stable-stopped finalization, exact ready finalization, or bound absence. Unknown retains the full vector.

Every non-tombstoned resource contributes total one. Running is zero only with durable exact stable stopped evidence and no possible start/create. Creating is one while create/start may be active or ambiguous. Every finite checkpoint has one canonical vector; validation fails rather than omitting a state.

The sampler includes non-pool workspaces, every intent, all pool states, admitting/active/unknown command barriers, cleanup/recovery/quarantine, legacy reservations, proof-bearing tombstones as zero, and Phase 2 reset groups. No private sampler may reinterpret a vector.

### 8.2 Idle Reservations

- Every unleased, non-tombstoned pool reservation contributes one, including create intent, provisioning, stopped, blocked, recovery, and quarantine.
- A `lease-verifying` resource contributes through its exact `idleReturnReservation: 1`, not as an unleased resource.
- Lease-verification recovery retains that reservation.
- Lease success atomically consumes it.
- Stopped/blocked/known refusal converts it to the returned resource's ordinary idle contribution.
- Typed absence removes it and stores a zero-capacity tombstone.
- Each Phase 2 reset reserves one future idle slot before any preflight or dispatch.
- Phase 2 parent reservations own reset idle accounting until consumed; linked targets do not add a second idle slot.

### 8.3 Budget Rules

- Only explicit `pool warm --yes-cost` creates/starts unleased Phase 1 target capacity.
- Lease has no paid provider mutation and never waits for a transition.
- Task resume starts only its already leased resource.
- Cleanup starts only its exact stopped deletion target with `--yes-cost` and cannot return it to inventory.
- Phase 2 reset is separately gated, cost-bearing, destructive, and fully reserved before preflight.
- Release, drain, reconciliation, and reset completion make no create/warm/replacement call.
- No keepalive, timer, daemon, startup reconciliation, hidden retry, or queued target action is permitted.

## 9. Phase 1 CLI and Algorithms

### 9.1 Commands and Exit Contract

```text
ac codespaces upgrade-control --yes [--json]
ac codespaces upgrade-control --resume --activation-generation G --yes [--json]
ac codespaces reconcile-legacy TASK --generation G [--json]
ac codespaces recover-discard TASK --generation G --yes --force-remote-data-loss [--yes-cost] [--json]
ac codespaces reconcile-command --command C --operation O --generation G [--cancel --yes] [--json]
ac codespaces reconcile-operation --resource R --operation O --generation G [--json]
ac pool warm NAME [--count N] --yes-cost [--json]
ac pool status NAME [--probe] [--json]
ac pool drain NAME --yes --force-remote-data-loss [--yes-cost] [--json]
ac pool reconcile-delete NAME --resource R --operation O --generation G [--json]
ac pool recover-discard NAME --resource R --operation O --generation G --yes --force-remote-data-loss [--yes-cost] [--json]
ac create TASK --backend codespaces --pool NAME [--json]
ac release TASK --discard --yes --force-remote-data-loss [--json]
```

Exit `0` means the requested action or exact convergence completed as stated, including successful command no-dispatch reconciliation. Exit `1` means miss, partial, safety/capacity block, active-warm conflict, recovery, quarantine, provider unreachable, a synchronous command refused before dispatch, or unproven result. Exit `2` is usage/config error before effects. Exit `130` remains verified connected-command cancellation behavior (`src/cli.ts:240-242`). JSON emits one versioned document; connected command bytes remain raw streams.

`pool status` is local/read-only by default. `--probe` permits one `GET /user` actor check and at most one exact Codespace GET per selected recorded resource. It MUST NOT call SSH, readiness/helper/repository probes, or any mutation. It never initializes protocol, writes state, acquires warm ownership, creates, starts, stops, deletes, resets, lists/adopts, keeps alive, or queues work.

### 9.2 Activation and Legacy Migration

`upgrade-control` performs only the controlled in-place flow in section 5.2 and no provider mutation:

1. Require gate, strict config, owner confirmation, supported durability, complete launcher authority, closed process-start gate, and actual zero-client attestation.
2. Acquire the old lock and scan all metadata, create intents, commands, and lifecycle operations strictly.
3. Block unreadable state, active lifecycle work, active/unknown/request-only/unreadable v1 command state, and create state from which dispatch may have occurred without exact response/resource mapping.
4. Publish activating and migrate exact app-recorded history only. Never list candidates.
5. Convert `environmentId === codespaceId` to synthesized-unproven. Treat distinct nonempty environment as provider-observed. Every migrated live record lacks repository-owner identity until exact binding.
6. Convert shipped tombstones to unverified, proofless, conservative total/running records. Historic booleans/error text never become proof.
7. Preserve terminal command IDs as non-reusable history and opaque lifecycle recovery without invented fields.
8. Complete metadata v3, registry, legacy no-dispatch classification, permanent fence, and active marker under one zero-client maintenance epoch.

An unmatched response-free shipped create intent may become `terminal-not-dispatched` only when source state is exactly `intent-recorded`, no response/correlation/identity/matching resource exists, durable source ordering proves dispatch marker would precede provider invocation (`src/codespaces-create.ts:141`, `src/codespaces-create.ts:176-188`), and actual zero-client proof prevents a paused writer. Otherwise activation blocks.

Publication uncertainty leaves protocol activating. Exact `upgrade-control --resume --activation-generation A --yes` under the same live maintenance authority and newly validated zero clients is the sole convergence. There is no fresh-root, ordinary-operation, or post-activation legacy-intent escape hatch.

### 9.3 Legacy Identity and Tombstones

`reconcile-legacy TASK --generation G` publishes one read-only exact operation, verifies current actor, and exact-GETs only the recorded name. Typed 404 writes bound absence; exact live identity must match every independently recorded field before one-time repository-owner/environment binding; mismatch quarantines; unreachable remains capacity-bearing; live legacy tombstone becomes cleanup-only.

`recover-discard TASK` is a narrow exact cleanup path for identity-incomplete app-created legacy resources and exact live unverified tombstones. It requires all available identity, null command/unrelated recovery, complete Git proof, exact delete, and bound GET-404. A stopped target requires `--yes-cost` and full start reservation. It never grants execution, adopts, or replenishes.

### 9.4 Serialized Warm

1. Validate gate, protocol, config, target, and `--yes-cost` before effects. Target zero returns a no-op snapshot.
2. Under lock validate all state, synchronize configured demand fields, sample capacity, and require null active warm.
3. Atomically install one warm owner and its first deterministic exact operation, or clear ownership if no action can occur.
4. Freshly observe recorded ready-idle candidates, then retryable blocked records, one at a time.
5. Outside lock run exact actor/provider/identity/state/private-port/repository/SSH/helper/nonempty-readiness proof.
6. Exact CAS finalizes ready, stopped, blocked, typed absence, unreachable recovery, or quarantine.
7. The finalizer atomically publishes the next action or clears ownership. It never leaves an ownerless gap.
8. Before spending, count only still-ready records proven by this invocation. Prefer one stopped start, then one exact create, with full reservations.
9. Stop on first deterministic failure, ambiguity, unreachable result, quarantine, capacity block, or write uncertainty.
10. Crash reconciliation finalizes only the recorded action, clears active warm, and never continues target maintenance. Later explicit warm is required.

### 9.5 Immediate Lease

`create --pool` atomically selects one deterministic ready-idle record, creates a verifying lease with `idleReturnReservation: 1`, binds the resource, and publishes exact lease-verification operation before one bounded pristine proof. Success activates and consumes the idle reservation. Stopped/blocked refusal removes the unactivated lease and converts reservation to ordinary idle occupancy. Typed exact 404 tombstones, removes lease/reservation, and returns `POOL_MISS`. Uncertainty retains exact recovery and the reservation. It never selects another candidate, waits, starts, creates, or falls back.

### 9.6 Command Admission and Every Pre-Dispatch Checkpoint

Pooled and non-pooled commands use the same finite authority sequence:

1. Under lock AND-match full handle/owner, require lease continuity, one-command limit, null slot/unrelated operation, and globally unused command ID.
2. Atomically publish command and exact resource slot as `admitting/authority-reserved`.
3. Publish request v2 with complete owner and no argv. After durable publication, exact CAS advances command and slot to `request-published`.
4. Exact CAS advances both to `continuity-verifying`; outside lock perform lease continuity without baseline branch/HEAD/cleanliness/origin/readiness checks.
5. Exact CAS advances both to `active/dispatch-authorized` and sets `dispatchMayHaveOccurred: true`.
6. Only the process that won and revalidated this exact authorization generation may invoke framed helper transport.
7. Exact terminal/cancel proof atomically terminalizes and clears only the exact slot.
8. Any ambiguity after dispatch authorization writes the complete unknown command/slot/resource/lease tuple.

A crash or write failure at any of `authority-reserved`, request file published while registry remains `authority-reserved`, `request-published`, or `continuity-verifying` leaves a generation-bound admitting command. It never becomes unknown merely because the process stopped.

`reconcile-command` accepts either one exact admitting command generation or the complete unknown tuple. For an admitting command it performs no provider, SSH, helper, cancel, lifecycle, or task-argv action. It may inspect only exact local secondary paths. An absent request or an exact owner-bound request is compatible with no dispatch. Owner mismatch, malformed state, or helper status at/after `accepted` is a fail-closed contradiction.

The no-dispatch finalizer atomically:

1. Revalidates command generation, operation, owner, finite checkpoint, slot, source resource generation, and current lease record generation.
2. Writes terminal `not-dispatched` history and matching `CommandNoDispatchProofV1`.
3. Clears only the exact resource slot.
4. Preserves the same resource and, where one exists, immutable lease epoch as active because admission never changed ownership.
5. Rotates mutable generations so every paused admission writer is stale.

Successful reconciliation returns exit `0`, machine outcome `not-dispatched`, and `COMMAND_NOT_DISPATCHED`. A synchronous command path that deterministically refuses before authorization performs the same terminal transaction but returns exit `1`. If the original writer wins `dispatch-authorized`, the reconciler's CAS fails and no-dispatch is forbidden. From that point only unknown-command rules apply to uncertainty. No command checkpoint expires by time.

### 9.7 Unknown Command Convergence

For an exact unknown tuple, reconciliation first inspects or explicitly cancels only the recorded helper owner. Typed terminal/cancel proof restores the exact pre-command resource/lease state and same lease epoch while terminalizing only this command.

If helper proof is unavailable, the same reconciliation may issue one exact GET to the endpoint in the original command checkpoint. Typed 404 atomically writes bound `command-reconcile-absence` proof/history, terminalizes command `resource-absent`, clears exact slot/recovery, tombstones resource, marks pool lease `released-resource-absent`, and returns `COMMAND_RESOURCE_ABSENT`. It performs no Git/delete/start/list/warm. Exact live, non-404, unreachable, malformed, mismatch, stale, or write-uncertain evidence retains the full tuple and capacity.

### 9.8 Stop, Start, and Branch Continuity

Stop and start admission are resource-scoped exact transactions. Stop rejects only that resource's barriers. Start of a leased stopped resource preserves task ownership and reserves `{1,1,1}`. Every original writer revalidates exact operation generation immediately before PATCH. PATCH/readback ambiguity becomes recovery and PATCH is never retried by reconciliation.

Command, attach/cancel, stop, start, and resume MUST NOT compare provider `git_status.ref`, requested ref, baseline HEAD, cleanliness, original origin, or pristine readiness after lease activation. A task may create/switch branches, commit, stop, resume, and run sequential commands on the same lease/incarnation.

### 9.9 Release, Drain, and Delete

Release:

1. Require exact task/handle/active lease and `--discard --yes --force-remote-data-loss`.
2. Atomically publish `release-admitted` after ordinary cleanup eligibility proves null command/unrelated operation/recovery/quarantine.
3. Exact-GET recorded identity. Typed 404 immediately finalizes bound absence and lease completion.
4. Exact stopped proof atomically rolls resource/lease back to the same leased/active epoch before returning `POOL_STOPPED`.
5. Exact running resource advances to `release-git-verifying` and runs section 7.3.
6. Every deterministic Git refusal atomically restores the same active lease before response.
7. Only after complete proof does one transaction publish `release-delete-dispatched` with mutation possible. The writer revalidates that generation, then DELETEs only recorded name.
8. DELETE 404 does not prove absence. Exact GET typed 404 is required for proof, tombstone, lease completion, and zero capacity.
9. Live/unreachable/non-404 after delete becomes exact delete recovery with lease/capacity retained. No replacement action occurs.

Drain first marks pool draining, conflicts with active warm, skips active leases, and processes exact unleased resources deterministically. Stopped cleanup needs same-invocation `--yes-cost` and full start reservation. It never clears unrelated recovery/quarantine. Pool becomes drained only when no live/nonterminal resource, nonterminal lease, idle/reset parent reservation, active warm, cleanup parent/child, or recovery remains.

`reconcile-delete` acts only from a checkpoint where DELETE may have occurred. It exact-GETs only and finalizes bound 404. Exact live/unreachable retains recovery. `recover-discard` may retry only exact live cleanup with all identity, Git, acknowledgement, start, delete, and absence gates.

### 9.10 Total Non-Command Reconciliation Matrix

`reconcile-operation` never repeats remote mutation, Git proof, discovery, or target policy. Exact generation CAS transfers reconciliation ownership; all stale original writers then perform zero mutations. Every legal checkpoint has one explicit row. A response-less dispatched create intentionally remains a capacity-bearing incident because no safe exact identity exists; this contract does not call that state terminal or offer listing/adoption as false convergence.

| Exact checkpoint | Allowed evidence and atomic terminal/convergent result |
| --- | --- |
| `create-intent` | No provider call. Exact sequencing finalizes immutable not-dispatched history and releases `{1,1,1}`. Any contradiction retains recovery. |
| `create-dispatched` without response identity | No GET/list/adoption is possible. Retain a conservative nonterminal incident/recovery state and `{1,1,1}`. No in-tool terminal result is claimed; it cannot mutate or free capacity. |
| `create-response-recorded` | Exact GET. Typed 404 tombstones. Exact stopped finalizes stopped. Exact running may perform only original immutable/pristine readiness proof. Mismatch quarantines; unknown retains `{1,1,1}`. |
| `observing` | Exact GET plus original fixed probes. Finalize ready/stopped/blocked/404/quarantine and clear warm owner. Unknown retains recovery. Never continue target. |
| `readiness-verifying` in any context | Exact GET 404 tombstones and applies source-specific lease/warm/reservation cleanup. Exact running may repeat only original fixed readiness/pristine proof and finalize ready or blocked. Exact stopped finalizes source-context stopped/refusal. Mismatch quarantines; unknown retains recovery. |
| `lease-verifying` | Exact GET plus bounded pristine proof. Activate, capacity-safe stopped/blocked refusal, or typed-404 tombstone with lease/reservation removal and `POOL_MISS`. Unknown retains verification recovery. |
| `start-admitted` | Exact GET 404 tombstones. Exact stopped finalizes not-dispatched and restores exact pre-start state. Exact running advances only to same operation readiness. Transitional/unreachable retains `{1,1,1}`; identity mismatch quarantines with it. No PATCH. |
| `start-dispatched` or `start-readback` | Exact GET 404 tombstones. Exact running advances to same readiness. Exact stable stopped restores exact pre-start state and releases creating/running reservation as appropriate. Transitional/unreachable retains recovery and `{1,1,1}`; mismatch quarantines with it. No PATCH retry. |
| `start-readiness-verifying` | Exact GET 404 tombstones. Exact running repeats only original readiness. Exact stopped restores exact pre-start stopped state. Unreachable retains recovery; mismatch quarantines. |
| `stop-admitted` | Exact GET 404 tombstones and closes any lease as resource-absent. Exact running finalizes not-dispatched and restores pre-stop state. Exact stopped finalizes stopped while preserving same lease. Transitional/unreachable retains recovery; mismatch quarantines. No PATCH. |
| `stop-dispatched` or `stop-readback` | Exact GET 404 tombstones. Exact stopped finalizes stopped with same lease. Exact stable running finalizes known-running with same lease. Transitional/unreachable retains recovery; mismatch quarantines. No PATCH retry. |
| `release-admitted`, `release-identity-verifying`, or `release-git-verifying` | Exact GET 404 tombstones and marks lease `released-resource-absent`. Exact live matching identity atomically rolls back to same active lease and immutable lease epoch, consumes operation, and returns `release-rolled-back`; stopped also reports `POOL_STOPPED`. Unreachable retains recovery; mismatch quarantines with lease/capacity. No Git/start/DELETE/replacement/warm. |
| `release-delete-dispatched` or `release-absence-readback` | Only `reconcile-delete`. Exact GET 404 finalizes `release-delete` and lease. Exact live/unreachable retains delete recovery; mismatch quarantines without rollback because DELETE may have occurred. |
| Cleanup `cleanup-admitted`, `cleanup-identity-verifying`, or `cleanup-git-verifying` | Exact GET 404 tombstones. Exact live identity consumes operation into `cleanup-rolled-back` and restores exact prior cleanup-required state. Unreachable retains recovery; mismatch quarantines. Operator may rerun only after successful rollback. No Git/start/DELETE/target continuation. |
| Cleanup `cleanup-delete-dispatched` or `cleanup-absence-readback` | Exact GET 404 tombstones through matching delete kind. Exact live/unreachable retains exact delete recovery; mismatch quarantines without rollback. No PATCH, list, or replenishment. |
| `legacy-identity-binding` | Exact GET only from its required non-null recorded endpoint. Typed 404 finalizes `legacy-reconcile` absence. Exact identity atomically binds once and finalizes `legacy-bound-running` or `legacy-bound-stopped`; mismatch quarantines and unreachable retains recovery. |
| `legacy-observing` | Exact GET only from its required non-null recorded endpoint. Typed 404 finalizes `legacy-reconcile` absence. Exact live tombstone becomes cleanup-only with `legacy-cleanup-required`; exact running/stopped finalizes matching legacy state; mismatch quarantines and unreachable retains recovery. |

Every typed-absence finalizer atomically consumes the exact source operation, writes proof/history, tombstones, clears matching operation/recovery and warm owner, removes its absolute reservation, and applies source lease disposition. Verifying lease is removed with `POOL_MISS`; active/releasing lease becomes `released-resource-absent`; unleased warm action clears owner and stops. Every terminal non-absence result stores `FinalizedOperationV1` in the same transaction; a retained recovery remains explicitly nonterminal. Exact live release rollback returns only to the same task/lease, never pool inventory. Thus Phase 1 remains single-use.

## 10. Phase 1 Data and Fault Contract

Forbidden durable data includes task/readiness argv copies, output/PTY/replay bytes, request/command/argv/output/compatibility/config/token/secret hashes, credentials, secret values, environment snapshots, provider bodies/raw errors, raw reset evidence, process lists, path listings, and arbitrary cleanup scripts. Allowed structural evidence includes immutable Git OIDs, explicit provider/public protocol/version IDs, random UUID generations, argv count, connected offsets, stable classifications, timestamps, capability names, and capacity numbers.

Events contain only structural IDs, states, reasons, times, and capacity. Redaction is defense in depth, not universal proof; current tests cover selected fixtures only (`test/codespaces-backend.test.ts:277-311`, `test/codespaces-command.test.ts:108-134`).

| Fault | Durable state and convergence |
| --- | --- |
| Activation lacks complete launcher authority/zero clients | No activating marker/provider effect; protocol cannot be activated. There is no fresh-root fallback. |
| Activation crash | Exact activating generation; same authority and newly proven zero clients required to resume. |
| Old process paused after metadata load | Launcher drains/terminates/reaps it before first scan. |
| Pre-dispatch v1 intent | Activation-bound terminal proof after actual drain, or activation blocker. |
| Pre-dispatch v2 create | Exact no-dispatch terminalization; otherwise `{1,1,1}` recovery. |
| Crash at any command admitting checkpoint | Exact command-generation no-dispatch finalization, same lease preserved, zero provider/SSH/helper calls. |
| Command authorization race | One CAS wins; terminalized writer cannot dispatch, authorized command cannot be no-dispatch-finalized. |
| Unknown command, resource absent | Bound GET-404 atomically terminalizes command/resource/lease. |
| Readiness/start/stop typed 404 at any checkpoint | Bound source-specific tombstone, operation finalization, lease/warm/reservation disposition, zero mutation retry. |
| Release crash before DELETE dispatch | Exact live rollback to same lease or typed absence; no Git/DELETE during reconciliation. |
| Delete/readback unknown | Recovery retains lease/checkpoint/capacity; exact GET may finalize. |
| Lease verification concurrent warm | Idle-return reservation blocks duplicate idle create. |
| Warm crash | One warm owner plus exact action; reconciliation clears owner and never continues target. |
| Registry/secondary corruption | Structural read-only error; no mutation or capacity inference. |
| Dead lock owner | Lock may be reclaimed after exact local-owner proof; registry reservations remain. |

## 11. Detailed Phase 2 Contract

### 11.1 Hard Gate and Complete Version Fence

Phase 2 is unavailable by default. Before product code, the owner and independent security reviewer MUST approve this complete strict tuple:

```ts
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
```

These nine keys are one indivisible approval tuple: the first seven fields through `resetProofSchemaVersion` and the two additional mandatory fields `resetOperationReadbackSchemaVersion` and `resetCleanupSchemaVersion`. The three IDs bind approved subjects; their versions bind the threat model, boundary, and primitive implementation; the schema versions bind proof, operation readback, and cleanup semantics. The overview and issue #38 replacement body below reproduce every key. Missing, extra, or mismatched fields fail before reservation, quiescence, Git, provider, or state effects.

The tuple appears in owner/security artifacts, strict config, pool policy generation, package descriptor, reset admission, parent reservation, operation, pre-destructive proof, success/failure proof, every physical cleanup target, every child cleanup operation/finalization, predecessor/successor records, and machine status. Any primitive code, operation readback, cleanup addressability, trust boundary, evidence, capacity, or provider-guarantee change requires a new version and approval. Config cannot enable an unmatched package implementation.

The approved threat model MUST define prior-task adversary/privilege assumptions; all processes/jobs/services/sockets/helper children; every repository/home/mount/volume/cache/temp/tool/helper/credential writable surface; exclusions and accepted residual risk; the trusted external invoker; typed process termination/non-restart proof; state destruction/replacement/rekey; new environment identity; named-secret/Git-credential revocation; provider guarantees versus observations; and allowed task populations. Unknown or best-effort classes keep reset disabled.

### 11.2 Trusted Primitive, Quiescence, and Cleanup Reachability

The exact package-owned primitive MUST:

1. Target only exact recorded predecessor identity, never discovery.
2. Execute outside prior-task influence.
3. Accept a client reset operation ID before possible dispatch and expose a typed exact operation endpoint by that ID after every uncertain outcome.
4. Return the complete bounded physical outcome and every possible billed target, including exact Codespace ID/name/endpoint, physical ID, resource/incarnation ID, and environment identity when one exists.
5. Make typed no-dispatch mean that no destructive predecessor or successor effect could have occurred.
6. Support a durable independently readable quiescence hold that prevents all prior-task mutation and restart before destructive dispatch.
7. Terminate/prevent restart of all in-boundary processes before successor setup.
8. Destroy, replace, or cryptographically rekey every included writable surface and explicitly reject/account for external mounts, caches, sockets, and provider storage.
9. Produce a different non-null immutable environment identity.
10. Re-bootstrap the helper from trusted package/control evidence.
11. Permit exact repository, port, SSH, and nonempty readiness proof.
12. Declare full conservative peak total/running/creating deltas.
13. Guarantee a trusted cleanup channel capable of quiescing and running section 7.3 for every exact live target even when successor helper/bootstrap/readiness failed.
14. Guarantee exact delete and exact GET-404 readback for every bounded target.

Listing is never operation readback. A primitive that can create an unidentifiable successor, lose operation correlation, lose its quiescence hold, or strand trusted Git proof is not admissible.

Before the primitive may destroy, replace, rekey, or otherwise make predecessor Git data inaccessible, the trusted path MUST:

1. Persist reset and primitive operation IDs, exact operation endpoint, predecessor binding, generations, future-idle reservation, and full capacity floor with `dispatchMayHaveOccurred: false`.
2. Acquire a durable quiescence hold bound to the reset operation and predecessor. The hold prevents every prior-task process/helper/job/service and other in-boundary mutation source from running or restarting.
3. Read the hold back through the approved trusted channel and prove `typed-held-no-prior-task-mutation`.
4. While the hold remains active, complete section 7.3 over the predecessor superproject and every retained module Git repository, including deinitialized/residual `.git/modules` data.
5. Atomically revalidate the hold, Git proof, tuple, operation, resource/lease generations, and parent reservation and publish `destructive-dispatch-authorized`.
6. From that exact authorization generation, atomically publish `destructive-dispatched` with `dispatchMayHaveOccurred: true` before invoking the primitive.
7. Revalidate the exact dispatched generation and active hold, then invoke the primitive. A process that loses either generation performs zero primitive calls.

Git refusal causes zero primitive calls. The same lease may be restored only after typed no-dispatch and typed quiescence-release proof. Uncertain hold acquisition/release, Git proof, authorization persistence, or primitive dispatch retains reset recovery and the full parent reservation. The hold remains active through primitive readback/success finalization, or discard establishes equivalent trusted per-target quiescence before Git/delete.

Git reset/clean, stop/start, process listing, file scanning, Dev Container restart, arbitrary shell cleanup, or in-environment probes alone are insufficient. Secret values remain provider-owned and are never scanned/persisted. Default deny reset when named-secret capabilities are nonempty or Codespaces Git credential capability is enabled; override requires separately versioned provider-side revocation/reprovisioning and residue-destruction proof.

### 11.3 Phase 2 Policy

```yaml
backends:
  codespaces:
    pools:
      coding:
        desiredReady: 2
        maxIdle: 2
        releasePolicy: reset
        reuse:
          enabled: true
          threatModelId: agent-task-isolation
          threatModelVersion: "1"
          boundaryId: codespaces-full-reincarnation
          boundaryVersion: "1"
          resetPrimitiveId: github-reincarnate
          resetPrimitiveImplementationVersion: "1"
          resetProofSchemaVersion: 1
          resetOperationReadbackSchemaVersion: 1
          resetCleanupSchemaVersion: 1
```

Only a fresh resource warmed after Phase 2 activation under the exact tuple may be `reuseEligible`. Phase 1, migrated, provisional, recovery, quarantine, and existing-lease resources remain discard-only. Policy drift disables reset but leaves exact Phase 1 discard available.

### 11.4 Reset Schema

Registry schema v2 adds strict structures equivalent to the following. Unknown keys and invalid discriminant fields fail closed.

```ts
interface ResetPrimitiveDescriptorV1 {
  approvedContract: ApprovedResetContractV1;
  invocationKind: 'package-built-in-provider-control-plane';
  peakAdditionalCapacity: CapacityContributionV1;
  maxPhysicalTargets: 1 | 2;
  operationReadback: {
    kind: 'typed-exact-operation-get';
    endpointTemplateId: string;
    bindsClientOperationIdBeforeDispatch: true;
    completeTargetSet: true;
    typedNoDispatchMeansNoEffect: true;
  };
  quiescence: {
    kind: 'typed-out-of-task-hold';
    exactReadbackById: true;
    preventsPriorTaskMutationAndRestart: true;
  };
  cleanup: {
    exactTargetAddressability: true;
    trustedQuiescence: true;
    trustedGitPreservation: true;
    exactDeleteAndGet404: true;
  };
}

interface ResetIncarnationBindingV1 {
  role: 'predecessor' | 'successor';
  resourceId: string;
  physicalResourceId: string;
  incarnationId: string;
  githubHost: 'github.com';
  codespaceId: string;
  codespaceName: string;
  exactEndpoint: string;
  environmentId: string;
  admittedResourceGeneration: string;
}

interface ResetPreDestructiveProofV1 {
  schemaVersion: 1;
  proofId: string;
  resetOperationId: string;
  primitiveOperationId: string;
  reservationId: string;
  approvedContract: ApprovedResetContractV1;
  predecessor: ResetIncarnationBindingV1 & { role: 'predecessor' };
  quiescenceOperationId: string;
  quiescenceHoldId: string;
  quiescenceReadbackEndpoint: string;
  quiescenceOutcome: 'typed-held-no-prior-task-mutation';
  gitPreservationProofId: string;
  gitPreservationOutcome: 'typed-complete';
  dispatchAuthorizationGeneration: string;
  authorizedAt: string;
}

interface ResetOperationBaseV1 {
  kind: 'reset';
  operationId: string;
  primitiveOperationId: string;
  primitiveOperationEndpoint: string;
  resetReservationId: string;
  admittedResourceGeneration: string;
  leaseGeneration: string;
  admittedLeaseRecordGeneration: string;
  approvedContract: ApprovedResetContractV1;
  startedAt: string;
}

type ResetOperationCheckpointV1 =
  | ResetOperationBaseV1 & {
      checkpoint: 'admitted' | 'quiescing' | 'git-preserving';
      dispatchMayHaveOccurred: false;
      preDestructiveProof: null;
    }
  | ResetOperationBaseV1 & {
      checkpoint: 'destructive-dispatch-authorized';
      dispatchMayHaveOccurred: false;
      preDestructiveProof: ResetPreDestructiveProofV1;
    }
  | ResetOperationBaseV1 & {
      checkpoint: 'destructive-dispatched' | 'operation-readback';
      dispatchMayHaveOccurred: true;
      preDestructiveProof: ResetPreDestructiveProofV1;
    };

interface ResetProofBaseV1 {
  proofSchemaVersion: 1;
  operationId: string;
  primitiveOperationId: string;
  resetReservationId: string;
  preDestructiveProofId: string;
  approvedContract: ApprovedResetContractV1;
  primitiveOutcome: 'typed-success';
  processBoundaryOutcome: 'typed-complete';
  writableBoundaryOutcome: 'typed-complete';
  credentialBoundaryOutcome: 'not-applicable' | 'typed-complete';
  completedAt: string;
}

interface SameCodespaceResetProofV1 extends ResetProofBaseV1 {
  physicalOutcome: 'same-codespace-reincarnation';
  predecessor: ResetIncarnationBindingV1 & { role: 'predecessor' };
  successor: ResetIncarnationBindingV1 & { role: 'successor' };
  predecessorRetirement: {
    kind: 'typed-control-plane-incarnation-retired';
    retirementProofId: string;
  };
}

interface ReplacementResetProofV1 extends ResetProofBaseV1 {
  physicalOutcome: 'replacement';
  predecessor: ResetIncarnationBindingV1 & { role: 'predecessor' };
  successor: ResetIncarnationBindingV1 & { role: 'successor' };
  predecessorAbsence: {
    kind: 'typed-exact-get-404';
    cleanupTargetId: string;
    absenceProofId: string;
    finalizationId: string;
  };
}

type ResetProofV1 = SameCodespaceResetProofV1 | ReplacementResetProofV1;

interface EnvironmentRetirementProofV1 {
  proofVersion: 1;
  retirementProofId: string;
  resetOperationId: string;
  primitiveOperationId: string;
  predecessor: ResetIncarnationBindingV1 & { role: 'predecessor' };
  successor: ResetIncarnationBindingV1 & { role: 'successor' };
  classification: 'typed-control-plane-incarnation-retired';
  approvedContract: ApprovedResetContractV1;
  retiredAt: string;
}

interface ResetFailureBaseV1 {
  operationId: string;
  primitiveOperationId: string;
  resetReservationId: string;
  approvedContract: ApprovedResetContractV1;
  failureKind: 'typed-failed' | 'typed-partial' | 'readback-unknown';
  checkpoint: string;
  reasonCode: PoolReasonCode;
  capacityDisposition: 'full-parent-retained';
  recordedAt: string;
}

type ResetFailureV1 =
  | ResetFailureBaseV1 & {
      targetSetStatus: 'unknown';
      physicalOutcome: 'unknown';
      cleanupTargetIds: [];
    }
  | ResetFailureBaseV1 & {
      targetSetStatus: 'complete';
      physicalOutcome: 'predecessor-only';
      cleanupTargetIds: [string];
    }
  | ResetFailureBaseV1 & {
      targetSetStatus: 'complete';
      physicalOutcome: 'same-codespace-reincarnation';
      cleanupTargetIds: [string];
    }
  | ResetFailureBaseV1 & {
      targetSetStatus: 'complete';
      physicalOutcome: 'replacement';
      cleanupTargetIds: [string, string];
    };

interface ResetCapacityVectorV1 {
  total: 0 | 1 | 2;
  running: 0 | 1 | 2;
  creating: 0 | 1 | 2;
}

type ResetTargetSetV1 =
  | { status: 'pre-dispatch'; cleanupTargetIds: [] }
  | { status: 'unknown'; cleanupTargetIds: [] }
  | { status: 'complete'; cleanupTargetIds: [string] | [string, string] };

interface ResetCapacityReservationV1 {
  reservationId: string;
  generation: string;
  operationId: string;
  primitiveOperationId: string;
  primitiveOperationEndpoint: string;
  predecessorResourceId: string;
  leaseId: string;
  resourceGeneration: string;
  leaseGeneration: string;
  leaseRecordGeneration: string;
  poolIdle: 1;
  predecessorAdmissionContribution: CapacityContributionV1;
  peakAdditionalCapacity: CapacityContributionV1;
  capacityFloor: ResetCapacityVectorV1;
  approvedContract: ApprovedResetContractV1;
  targetSet: ResetTargetSetV1;
  discardOperationId: string | null;
  state:
    | 'reserved' | 'preflight' | 'dispatch-authorized' | 'dispatched'
    | 'outcome-unknown' | 'retained-quarantine' | 'discarding'
    | 'consumed-no-dispatch' | 'consumed-success' | 'consumed-discard';
  createdAt: string;
}

interface ResetCleanupTargetBaseV1 {
  cleanupSchemaVersion: 1;
  targetId: string;
  generation: string;
  originalResetOperationId: string;
  primitiveOperationId: string;
  reservationId: string;
  approvedContract: ApprovedResetContractV1;
  physicalResourceId: string;
  githubHost: 'github.com';
  codespaceId: string;
  codespaceName: string;
  exactEndpoint: string;
}

type ResetCleanupTargetIdentityV1 =
  | ResetCleanupTargetBaseV1 & {
      targetKind: 'single-incarnation';
      member: ResetIncarnationBindingV1;
    }
  | ResetCleanupTargetBaseV1 & {
      targetKind: 'shared-codespace';
      predecessor: ResetIncarnationBindingV1 & { role: 'predecessor' };
      successor: ResetIncarnationBindingV1 & { role: 'successor' };
      predecessorRetirementProofId: string | null;
    };

type ResetCleanupTargetStatusV1 =
  | {
      state: 'pending';
      activeChildOperationId: null;
      absenceProofId: null;
      absenceFinalizationId: null;
    }
  | {
      state: 'active';
      activeChildOperationId: string;
      absenceProofId: null;
      absenceFinalizationId: null;
    }
  | {
      state: 'terminal-absent';
      activeChildOperationId: null;
      absenceProofId: string;
      absenceFinalizationId: string;
    };

type ResetCleanupTargetV1 = ResetCleanupTargetIdentityV1 & ResetCleanupTargetStatusV1;

interface ResetDiscardOperationV1 {
  kind: 'reset-discard';
  operationId: string;
  generation: string;
  originalResetOperationId: string;
  primitiveOperationId: string;
  reservationId: string;
  reservationGeneration: string;
  leaseId: string;
  leaseGeneration: string;
  leaseRecordGeneration: string;
  approvedContract: ApprovedResetContractV1;
  targetIds: string[];
  state: 'materializing-targets' | 'cleaning' | 'finalization-ready';
  startedAt: string;
}

type ResetCleanupParentV1 =
  | { kind: 'reset-success'; operationId: string }
  | { kind: 'reset-discard'; operationId: string };

interface ResetCleanupOperationV1 {
  cleanupSchemaVersion: 1;
  kind: 'reset-cleanup-target';
  operationId: string;
  generation: string;
  parent: ResetCleanupParentV1;
  originalResetOperationId: string;
  primitiveOperationId: string;
  reservationId: string;
  reservationGeneration: string;
  targetId: string;
  admittedTargetGeneration: string;
  approvedContract: ApprovedResetContractV1;
  exactEndpoint: string;
  checkpoint:
    | 'observing' | 'quiescing' | 'git-preserving'
    | 'start-dispatch-authorized' | 'start-dispatched' | 'start-readback'
    | 'delete-dispatch-authorized' | 'delete-dispatched'
    | 'absence-readback' | 'recovery-required';
  startDispatchMayHaveOccurred: boolean;
  deleteDispatchMayHaveOccurred: boolean;
  startCapacityReservation: CapacityContributionV1 | null;
  startedAt: string;
}

interface ResetCleanupTerminalMemberV1 {
  binding: ResetIncarnationBindingV1;
  terminalResourceGeneration: string;
  terminalState: 'reset-tombstoned';
}

interface ResetCleanupAbsenceProofV1 {
  proofVersion: 1;
  proofId: string;
  finalizationId: string;
  childOperationId: string;
  sourceChildOperationGeneration: string;
  finalizerOperationId: string;
  parent: ResetCleanupParentV1;
  originalResetOperationId: string;
  primitiveOperationId: string;
  reservationId: string;
  targetId: string;
  admittedTargetGeneration: string;
  tombstoneTargetGeneration: string;
  approvedContract: ApprovedResetContractV1;
  physicalResourceId: string;
  githubHost: 'github.com';
  codespaceId: string;
  codespaceName: string;
  exactEndpoint: string;
  terminalMembers: ResetCleanupTerminalMemberV1[];
  observedMethod: 'GET';
  typedHttpStatus: 404;
  classification: 'typed-http-404';
  observedAt: string;
}

interface FinalizedResetCleanupOperationV1 {
  finalizationId: string;
  childOperationId: string;
  sourceChildOperationGeneration: string;
  finalizerOperationId: string;
  parent: ResetCleanupParentV1;
  originalResetOperationId: string;
  primitiveOperationId: string;
  reservationId: string;
  targetId: string;
  admittedTargetGeneration: string;
  tombstoneTargetGeneration: string;
  approvedContract: ApprovedResetContractV1;
  physicalResourceId: string;
  githubHost: 'github.com';
  codespaceId: string;
  codespaceName: string;
  exactEndpoint: string;
  terminalMembers: ResetCleanupTerminalMemberV1[];
  absenceProofId: string;
  result: 'typed-exact-get-404';
  finalizedAt: string;
}

interface FinalizedResetDiscardOperationV1 {
  finalizationId: string;
  parentOperationId: string;
  originalResetOperationId: string;
  primitiveOperationId: string;
  reservationId: string;
  approvedContract: ApprovedResetContractV1;
  targetIds: [string] | [string, string];
  targetFinalizationIds: [string] | [string, string];
  result: 'all-physical-targets-absent';
  finalizedAt: string;
}

type ResetResourceStateV2 =
  | ResourceStateV1
  | 'reset-requested' | 'reset-preflight' | 'reset-running'
  | 'incarnation-verifying' | 'helper-verifying' | 'repository-verifying'
  | 'reset-readiness-verifying' | 'reset-retired'
  | 'reset-discarding' | 'reset-tombstoned';

type ResetLeaseStateV2 =
  | PoolLeaseV1['state']
  | 'reset-requested' | 'reset-preflight' | 'reset-running'
  | 'reset-quarantined' | 'reset-discarding'
  | 'released-reset' | 'released-reset-discarded';

interface PoolRecordV2 extends Omit<PoolRecordV1, 'releasePolicy'> {
  releasePolicy: 'discard' | 'reset';
  reuse: null | { enabled: true; approvedContract: ApprovedResetContractV1 };
}

interface ResourceAuthorityV2
  extends Omit<ResourceAuthorityV1, 'state' | 'activeOperation' | 'recovery'> {
  state: ResetResourceStateV2;
  activeOperation: NonCommandOperationV1 | ResetOperationCheckpointV1 | null;
  recovery: RecoveryCheckpointV1 | { operation: ResetOperationCheckpointV1; reasonCode: PoolReasonCode; recordedAt: string } | null;
  reuseEligible: boolean;
  approvedResetContract: ApprovedResetContractV1 | null;
  predecessorResourceId: string | null;
  successorResourceId: string | null;
  resetReservationId: string | null;
  resetProof: ResetProofV1 | null;
  resetFailure: ResetFailureV1 | null;
  retirementProof: EnvironmentRetirementProofV1 | null;
  resetCleanupTargetId: string | null;
}

interface PoolLeaseV2 extends Omit<PoolLeaseV1, 'state'> {
  state: ResetLeaseStateV2;
  resetOperationId: string | null;
  resetReservationId: string | null;
}

interface CodespacesControlRegistryV2 {
  schemaVersion: 2;
  writerProtocol: 'codespaces-control/v2';
  generation: string;
  createdAt: string;
  updatedAt: string;
  pools: Record<string, PoolRecordV2>;
  resources: Record<string, ResourceAuthorityV2>;
  leases: Record<string, PoolLeaseV2>;
  commands: Record<string, CommandAuthorityV1>;
  legacyReservations: Record<string, LegacyReservationV1>;
  finalizedOperations: Record<string, FinalizedOperationV1>;
  finalizedAbsenceOperations: Record<string, FinalizedAbsenceOperationV1>;
  resetReservations: Record<string, ResetCapacityReservationV1>;
  resetDiscardOperations: Record<string, ResetDiscardOperationV1>;
  resetCleanupTargets: Record<string, ResetCleanupTargetV1>;
  resetCleanupOperations: Record<string, ResetCleanupOperationV1>;
  resetCleanupAbsenceProofs: Record<string, ResetCleanupAbsenceProofV1>;
  finalizedResetCleanupOperations: Record<string, FinalizedResetCleanupOperationV1>;
  finalizedResetDiscardOperations: Record<string, FinalizedResetDiscardOperationV1>;
}
```

Every map/key/interface and every intersection/discriminant combination is strict. Pool, resource, lease, reset operation, parent reservation, failure/proof, target, child operation/generation, child proof/finalization, parent finalization, retirement, and predecessor/successor references are bidirectionally exact. A child operation is independently generated for one physical target and is not stored as a resource's sole top-level operation. This permits target A to finalize while parent cleanup and target B remain durable.

A single-incarnation target proof/finalization has exactly one terminal member equal to that target member. A shared target has exactly two terminal members, predecessor then successor, matching every binding field and fresh terminal generation. Proof/finalization parent, child source generation, target generation, target members, physical identity, endpoint, reservation, reset/primitive operation, tuple, and timestamp match each other and enclosing immutable authority. Duplicate members, order changes, copied pairs, and unknown cardinality fail before tombstone or capacity inference.

`ResetFailureV1.targetSetStatus: complete` is valid only when the same atomic transaction also stores every referenced immutable `ResetCleanupTargetV1` and every required predecessor/successor authority with complete bindings from approved typed operation readback. Target IDs are ordered predecessor then successor for replacement and have no duplicates. `targetSetStatus: unknown` requires no cleanup targets or successor authority. Therefore no crash window may retain a claimed complete topology without its target identities.

A complete same-Codespace partial result without retirement creates both possible incarnation authorities and one shared target in that transaction. Both authorities are `quarantined`, non-service-eligible, have a null command slot and no executable lease authority, share exactly one physical/Codespace ID/name/endpoint, differ in resource/incarnation/environment identity, and point to the same target/reset/reservation. This is the narrow shared-target exception to the ordinary uniqueness invariant; it does not assert that both environments are live. The later exact parent-admission transaction changes cleanup ownership only. The child may perform only its checkpointed start/delete actions; its finalizer alone changes durable disposition/tombstones.

### 11.5 Physical-Outcome Union Rules

`ResetProofV1` is physically discriminated:

- Same-Codespace success requires equal physical-resource ID, Codespace ID, name, and endpoint; different resource/incarnation IDs; different non-null environment IDs; and typed environment retirement bound to exact successor. Predecessor physical absence is not used because successor remains at the shared endpoint.
- Replacement success requires different physical-resource IDs, Codespace IDs, names, and endpoints. It permits only a predecessor bound exact-GET-404 cleanup target proof/finalization. Environment retirement cannot free a distinct billed predecessor.
- Fields belonging only to the other union member are unknown and invalid.
- Replacement predecessor remains a live capacity contributor and blocks drain until its own target-bound absence finalization exists. It is never represented as `reset-retired`.
- `reset-retired` is valid only for the same-Codespace union and only with exact retirement proof plus one counted live/absent successor physical authority.

### 11.6 Reset Capacity Invariants

Before reset preflight, one transaction reserves:

1. One future pool idle slot, requiring proposed effective idle at most `maxIdle`.
2. The descriptor's complete additional peak vector.
3. A `capacityFloor` equal to arithmetic predecessor contribution plus the approved additional peak vector.
4. Exact operation correlation and bounded physical-target count.

While a reset reservation is nonconsumed, all linked authorities form one reset capacity group. Its global contribution is the component-wise maximum of `capacityFloor` and the arithmetic sum of currently represented physical-target vectors. Linked resources are removed from ordinary independent sampling, preventing double count. The parent supplies exactly one future idle reservation; linked targets supply no additional idle occupancy until parent consumption.

An immediate child tombstone changes that target's ordinary contribution to zero but NEVER weakens `capacityFloor`, future-idle reservation, or parent reservation. Thus partial cleanup remains fully conservative. Only the parent finalizer consumes the floor:

- Same-Codespace success requires valid retirement and fully proven ready successor.
- Replacement success requires independently finalized predecessor absence and fully proven ready successor.
- Discard requires every physical target `terminal-absent` and no active child.
- Typed no-dispatch requires proof no primitive effect and typed quiescence release before restoring the same lease.

Drain is blocked by every nonconsumed reset reservation, reset parent, active child, or nonterminal target. It may ignore valid same-Codespace `reset-retired` history and valid `reset-tombstoned` history only after their complete proof/finalization links validate.

### 11.7 Reset and Read-Only Recovery Flow

Proposed command:

```sh
ac release fix-login --reset --yes --force-remote-data-loss --yes-cost
```

Reset admission requires all Phase 1 gates, exact active reuse-eligible lease, null command/other operation/recovery, exact current approved tuple, secret boundary, acknowledgements, and capacity. Refusal leaves the lease active. One transaction persists reset/primitive IDs, operation endpoint, predecessor, generations, and full reservation before any trusted preflight.

The trusted preflight acquires quiescence and completes all-ref preservation before publishing destructive authorization as required by section 11.2. The writer then publishes/revalidates `destructive-dispatched` before invoking the primitive. A crash before this checkpoint preserves typed no-dispatch eligibility; a crash after it uses operation readback and can never claim dispatch was impossible.

Complete success requires typed complete target topology, different non-null environment ID, immutable successor, correct physical-union predecessor disposition, trusted helper bootstrap, exact clean repository/source, typed process/writable/credential proof, private ports, SSH, and nonempty readiness.

For same-Codespace success, one final transaction writes immutable predecessor `reset-retired`, lease `released-reset`, ready-idle successor, proof, and `consumed-success` reservation.

For replacement success, a typed primitive success is not final while predecessor absence is unproven. The transaction materializes an independently generated predecessor physical target/child under parent kind `reset-success`. Exact GET 404 atomically finalizes that child and tombstones predecessor immediately while retaining the parent floor. Only then may one final transaction publish ready-idle successor, lease `released-reset`, proof containing the child proof/finalization IDs, and `consumed-success`. If predecessor is live, malformed, mismatched, or unreachable, success cannot finalize; the result remains recovery/quarantine and capacity-bearing. No reset success path destroys the predecessor before section 11.2's quiescence and all-ref proof.

`reconcile-reset` requires exact reset/primitive operation, reservation, tuple, resource and lease generations. It may exact-GET only recorded primitive-operation and target endpoints:

1. Typed no-dispatch releases the hold through typed readback, restores the same lease, and consumes only the undispatched parent reservation.
2. Complete typed success repeats only checkpoint-required trusted proof and follows the correct physical union.
3. Typed failed/partial with complete target topology atomically materializes every physical target and possible incarnation authority and enters discard-only reset quarantine, whether or not same-Codespace retirement proof exists.
4. Unknown/malformed/unreachable/incomplete/stale evidence retains the full reservation and recovery.

It never repeats reset, creates, lists candidates, adopts, switches resources, or continues target maintenance.

### 11.8 Exact Reset-Failure Discard With Independent Children

Provide:

```text
ac pool recover-reset-discard NAME --resource R --reset-operation O \
  --reservation S --generation G --lease-generation LG \
  --lease-record-generation LRG --yes --force-remote-data-loss \
  [--yes-cost] [--json]
```

This is the sole post-dispatch reset cleanup path:

1. Under lock require exact reset failure/quarantine, original/primitive operations, parent reservation/generation, predecessor, reset-quarantined lease and immutable/current generations, approved tuple, null command, and destructive acknowledgements.
2. Atomically publish one independent `ResetDiscardOperationV1`, set parent reservation `discarding`, and transfer cleanup ownership from lease/resource operation fields to this parent. No resource's sole operation is used as the multi-target cursor.
3. If topology is unknown, exact-GET only the recorded primitive operation endpoint. Accept only approved typed complete topology and atomically materialize all targets/authorities before changing failure target-set status to complete. Never list.
4. If topology was already complete, require every immutable target/authority to have been materialized by the original failure transaction. Replacement has ordered predecessor/successor single-incarnation targets. Predecessor-only has one target. Same-Codespace has one shared physical target containing both possible exact incarnation bindings.
5. A complete same-Codespace partial result is valid even without predecessor retirement proof. Its one shared target stores `predecessorRetirementProofId: null`; discard does not require invented retirement.
6. For each nonterminal target, independently generate and durably bind one child operation to parent, reset operation, primitive, reservation, tuple, target generation, exact endpoint, and all covered members.
7. Exact-GET the target once as its current physical unit. A single-incarnation response must match that member. A shared target response may match only the exact predecessor environment or exact successor environment. Any third environment or identity mismatch quarantines with zero delete.
8. For a live recognized target, acquire trusted per-target quiescence and run section 7.3 through the descriptor cleanup channel. Dirty, unpublished, residual `.git/modules`, or unavailable proof retains target and parent.
9. A stopped target may start only under this command with `--yes-cost` and an absolute `{1,1,1}` child reservation. It cannot return to inventory.
10. After proof, atomically publish child `delete-dispatch-authorized`; then publish `delete-dispatched` before exact DELETE. Every remote mutation requires exact generation revalidation.
11. DELETE 404 is not absence. Exact GET typed 404 is required.
12. One target finalization transaction consumes that exact child generation into immutable `finalizedResetCleanupOperations`, stores separately keyed `ResetCleanupAbsenceProofV1`, marks target `terminal-absent`, and changes every covered authority to proof-bearing `reset-tombstoned` immediately.
13. A single-incarnation target tombstones one authority. A same-Codespace shared target tombstones both exact possible incarnation authorities. Physical 404 proves neither E1 nor E2 remains, so no environment-retirement proof is required for this discard terminal path.
14. Target finalization leaves parent discard operation, full capacity floor, future-idle reservation, reset failure, and lease in reset-discarding state. It does not release any parent capacity.
15. Crash after target A finalization resumes target B through a newly generated child. A is never deleted/re-finalized, and its proof/history remains immutable.
16. Once every target is `terminal-absent` and no child is active, a provider-free parent transaction writes `FinalizedResetDiscardOperationV1` with the exact ordered target/finalization IDs, marks lease `released-reset-discarded`, consumes reset failure/parent operation, sets reservation `consumed-discard`, and releases floor/idle capacity.
17. Return stable per-target results. Never reset, adopt, return an incarnation to service, warm, create, replace, queue, or clear unrelated recovery.

For a same-Codespace partial outcome without retirement, the shared-target algorithm is the mandatory recovery/discard terminal path. It never queries the shared endpoint "as the predecessor." A live E1 or E2 is quiesced, Git-proven, and deleted as the one physical target. Typed 404 covers both exact recorded possibilities. Live E3, malformed identity, Git refusal, non-404, or unreachable readback performs zero delete and retains full accounting.

### 11.9 Phase 2 Migration and Failure

Schema-v2 migration is atomic under the writer protocol, blocked by admitting/active/unknown command or active non-command operation, and preserves all Phase 1 records as discard-only. Every migrated resource has `reuseEligible: false`, null tuple/proof/reservation/target. Config cannot make it reusable. Cross-tuple reuse is forbidden.

Transport loss, timeout, state-write failure after dispatch, stale CAS, descriptor mismatch, unknown topology, unchanged/null identity, provider drift, untrusted helper, repository mismatch, process/writable/credential gap, readiness failure, or capacity ambiguity produces exact reset recovery/quarantine with full parent accounting. No local recover/unlock, Git command, config/state edit, or acknowledgement clears it. Only exact reset reconciliation or reset-discard children can converge allowlisted state.

## 12. Implementation Stories

### 12.1 Phase 1 Prerequisites

- **Story 0.1:** Typed provider errors, exact source-bound absence proof/finalization, and typed absence at every non-command checkpoint.
- **Story 0.2:** Unambiguous registry-key handles with all-field AND resolution, real environment/repository-owner identity, metadata v3, one-time binding, and conservative tombstones.
- **Story 0.3:** Global command authority, finite admission checkpoints, generation-bound no-dispatch terminalization, one slot, complete unknown tuple, helper convergence, and exact-resource absence.
- **Story 0.4:** Complete fixed Git preservation over every ref/pseudoref/reflog and every retained module repository, including deinitialized/residual `.git/modules` data.
- **Story 0.5:** One canonical sampler with full create/start, idle rollback, legacy no-dispatch, recovery, and proof-bearing zero.
- **Story 0.6:** Controlled in-place protocol activation with actual launcher drain/zero-client proof, old-reader metadata, permanent fence, and exact resume. No fresh-root fallback.
- **Story 0.7:** Finite operation unions and total generation-bound readiness/start/stop/release/pre-delete recovery.

### 12.2 Phase 1 Delivery

- **Story 1.1:** Strict pool config, nonempty readiness, exact CLI/machine envelopes, and option call-count behavior.
- **Story 1.2:** Strict registry, invariants, atomic replacement, capacity, and cross-process tests.
- **Story 1.3:** One pool warm owner, serial action, full create/start reservations, and no crash continuation.
- **Story 1.4:** Immediate lease with idle-return reservation, fresh proof, typed absence, and exact handle.
- **Story 1.5:** Command authority and branch/task continuity across sequential commands, stop, and resume.
- **Story 1.6:** Complete Git-safe release/drain, pre-delete rollback, absence-bound delete, and no replenishment.
- **Story 1.7:** Status/events/redaction and forbidden-data audit.
- **Story 1.8:** Hosted matrices, package smoke, independent exact-head review, then separately authorized live proof.

### 12.3 Phase 2 Only After Gates

- **Story 2.0:** Owner/security approval of the complete nine-key tuple; no reset product code.
- **Story 2.1:** Prototype proves new identity, prior-task quiescence, pre-destructive Git proof, complete target readback after every fault, trusted cleanup, and peak accounting.
- **Story 2.2:** Schema v2, reset group capacity floor, physical outcome union, and discard-only migration.
- **Story 2.3:** Reset orchestration, immutable successor, replacement predecessor absence, same-Codespace retirement, read-only recovery, and independent target children.
- **Story 2.4:** Independent security review, hosted CI, exact-head review, and separately authorized live reset/release/discard proof.

## 13. Required Verification and Merge Gates

### 13.1 RED/GREEN Regressions

| Contract | RED reproducer | GREEN requirement |
| --- | --- | --- |
| v1 cross-field collision | Logical `alpha` has remote name `bookish-space`; another logical workspace is named `bookish-space`; run/observe/wait/attach/cancel the latter. | Select one registry authority, AND-match every field, and make zero provider/SSH/helper effects against `alpha`. |
| Exact-handle mutation | Mutate each logical/workspace/resource/incarnation/Codespace/environment/lease/generation field independently or duplicate an identity. | Fail before provider, SSH, helper, or state effects; no scan-order fallback. |
| Already-started v1 writer | Pause a real old package after metadata load and before command publication/SSH dispatch; invoke activation. | Launcher closes starts, drains/terminates/reaps it, and proves zero before scan. Activation cannot publish while it survives. |
| No fresh-root escape hatch | Select a missing, empty, or random same-principal state root without complete launcher authority. | `upgrade-control` and ordinary mutation reject before state/provider effects; documentation offers no bootstrap alternative. |
| Activation crash | Crash around marker, migration, fence, and active publication. | Start gate stays closed; resume requires exact generation/launcher epochs and new zero-client proof. |
| Future running reservation | With `maxRunning: 1`, `maxCreating: 2`, race two creates at intent. | Exactly one wins; at most one provider create call. |
| Capacity checkpoint coverage | Pause every create/start/readiness/stop/release/cleanup checkpoint and race non-pool create/start. | Every checkpoint validates to one conservative vector; none is omitted/double-counted. |
| Lease idle rollback | With `maxIdle: 1`, pause verification of A while warm attempts B; then refuse A stopped/blocked. | Warm cannot create B; exactly one effective idle reservation remains. |
| Lease typed 404 | Delete A after verifying lease publication. | Bound tombstone, lease/reservation cleanup, `POOL_MISS`, no fallback/start/create. |
| Absence proof copy | Orphan/copy proof/history or alter source checkpoint/owner/resource/physical/incarnation/ID/name/endpoint/generation. | Validation fails before zero; DELETE 404, text not-found, and non-404 fail. |
| Git stash | Clean pushed branch, then `git stash push --include-untracked`. | `REMOTE_GIT_UNPUBLISHED_REF`, durable rollback, zero DELETE/reset primitive. |
| Git tag/note/custom | Add unpublished tag, note, replace, or custom ref; separately exact advertised tag. | Unpublished/unsupported refs refuse; advertised tag passes only after exact object/peeled/reachability proof. |
| Git pseudoref/reflog | Reset an unpushed commit to upstream so only `ORIG_HEAD`/reflog retains it; exercise `FETCH_HEAD` and linked worktree. | Extra retained OID refuses; supported OIDs pass only when advertised-origin reachable; unsupported state fails closed. |
| Initialized submodule | Retain unpublished commit/stash only in initialized nested module while superproject is clean. | Recursive proof refuses with zero destructive calls. |
| Deinitialized submodule | Create unpublished module commit/stash, restore superproject, run `git submodule deinit -f -- path`. | Inventory retained `.git/modules` repository, detect data, and perform zero destructive calls. |
| Residual module administration | Leave orphaned/deleted/nested/unreadable/malformed/symlinked/path-escaping modules entry. | `REMOTE_GIT_PREFLIGHT_UNAVAILABLE`, zero destructive calls, conservative authority retained. |
| Safe deinitialized module | Deinitialized module has trusted mapping and every retained OID advertised/reachable. | Pass only after complete ref/pseudoref/reflog/upstream/origin proof; worktree absence alone proves nothing. |
| Command uniqueness | Race same command ID on two resources and two IDs on one resource. | One exact reservation wins; loser has zero SSH. |
| Command admitting crashes | Crash after `authority-reserved`, after request file but before CAS, after `request-published`, and during `continuity-verifying`. | Exact generation-bound no-dispatch history, exact slot clear, same lease, zero provider/SSH/helper calls. |
| Command admission race | Pause writer while reconciliation races each pre-dispatch generation. | Exactly one CAS wins; reconciler winner fences dispatch, authorization winner forbids no-dispatch proof. |
| Command no-dispatch corruption | Alter command/owner/operation/checkpoint/resource/lease generation/request owner or add helper `accepted`. | No terminalization or slot clearance. |
| Unknown command tuple | Lose SSH after helper dispatch. | One valid command/slot/resource/lease recovery tuple persists. |
| Unknown command absent | Exact resource GET returns typed 404. | Command `resource-absent`, lease closure, tombstone, zero capacity; no Git/delete/list/warm. |
| Readiness totality | At every readiness context/checkpoint return running-success, deterministic failure, stopped, 404, mismatch, and unreachable. | Exactly one matrix result; source-specific cleanup; no hidden target continuation. |
| Start totality | At every start checkpoint return running, stopped, transitional, unreachable, and 404. | No PATCH retry; running enters same readiness, stopped releases reservation, unknown retains `{1,1,1}`, 404 closes exact authority. |
| Stop totality | At every stop checkpoint return running, stopped, transitional, unreachable, and 404. | Same lease preserved for live result; absence closes it; no PATCH retry. |
| Release pre-delete recovery | Crash after each release pre-delete checkpoint, including before first GET and after Git proof but before DELETE checkpoint. | Exact live rolls back to same active lease; 404 closes lease; reconciliation performs zero Git/start/DELETE/replacement. |
| Release dispatch boundary | Race pre-delete rollback against `release-delete-dispatched`. | One generation wins; rollback impossible after DELETE may have occurred. |
| Cleanup pre-delete recovery | Crash at each drain/legacy/recovery cleanup checkpoint before DELETE. | Exact live restores cleanup-required state; 404 tombstones; zero Git/start/DELETE in reconciliation. |
| Delete convergence | DELETE succeeds, crash before tombstone. | Exact generation GET-404 writes bound proof/finalization; stale token fails. |
| Finalizer atomicity | Fault before/after proof, history, tombstone, lease, warm, reservation, and registry publication. | Old complete state or new complete state only; exact retry converges. |
| Pool warm concurrency | Warm A confirms R while B races. | B returns active-operation with zero probes/paid calls and cannot clobber proof. |
| Warm crash | Crash owner during observation/start/create. | Reconciliation finalizes exact action, clears owner, and never continues target. |
| Task branch continuity | Lease, create/switch branch, commit, run command 2, stop, resume while provider reports task branch, run command 3. | Same lease/incarnation; zero baseline ref/HEAD/pristine checks. |
| Pristine strictness | Present wrong ref before warm/initial lease. | Allocation rejects; continuity does not weaken pristine proof. |
| Command/release race | Race command admission and release. | One registry transaction wins; no dispatch after releasing. |
| Drain terminal history | Pool has only valid ordinary/reset tombstones, terminal leases, and valid same-Codespace reset-retired history. | Drain reaches drained; any parent/child/live/nonterminal target blocks. |
| Status boundary | Probe running/stopped/unreachable records. | Only `GET /user` plus bounded exact GETs; zero SSH/helper/readiness/Git/write/mutation calls. |
| Complete reset tuple | Omit readback or cleanup schema version, add unknown field, or mismatch any tuple location. | Reject before reservation/quiescence/Git/provider effects. |
| Pre-reset Git preservation | Add stash/note/custom ref/reset-away commit/deinitialized module data. | Quiescence may run; primitive and destructive writable-state calls remain zero. |
| Pre-reset mutation race | Keep hostile prior-task writer attempting mutation across Git proof. | Hold cannot attest or mutation is prevented; no dispatch authorization. |
| Reset pre-dispatch crash | Crash after admission, hold, Git proof, or authorization publication. | Exact typed no-dispatch/hold release restores same lease, or full recovery remains; never speculative dispatch. |
| Reset dispatch boundary | Crash before/after `destructive-dispatched` publication and immediately before/after primitive invocation. | Pre-checkpoint state may prove no dispatch; post-checkpoint state always uses operation readback; no durable false dispatch flag. |
| Reset union strictness | Put replacement absence fields in same-Codespace proof or retirement fields in replacement proof. | Strict schema rejection. |
| Replacement retirement only | Return distinct successor and predecessor environment retirement while predecessor GET is live. | No success/reservation consumption; predecessor counted; drain blocked. |
| Replacement predecessor 404 | Finalize predecessor target 404, then crash before successor finalization. | Predecessor tombstone persists immediately; full parent floor remains; successor cannot yet be idle. |
| Same partial no retirement | Return E1 to E2 at same Codespace, typed partial, complete topology, no retirement proof. | Valid quarantine with one shared target and an allowed discard path. |
| Partial topology atomicity | Crash while accepting complete replacement or same-Codespace partial readback. | Old unknown topology or new complete targets/authorities only; never complete IDs without bindings. |
| Same shared absence | Shared endpoint matches E1/E2, delete, then exact 404. | Child proof covers both exact members, both reset-tombstoned immediately, no fabricated retirement, full parent retained. |
| Same shared mismatch | Shared endpoint returns E3. | Zero delete; child/parent/full floor remain blocked. |
| Reset two-target crash | Finalize replacement target A and crash before B. | A proof/tombstone durable; parent floor/idle retained; B resumes through its own child. |
| Child finalizer race | Two processes finalize same child. | Exactly one atomic finalization; stale process writes nothing. |
| Parent crash window | Crash after last child finalization before parent finalization. | All tombstones persist, parent floor persists, retry performs zero provider calls and consumes parent only. |
| Reset proof copying | Copy child proof/history across target/member/operation/physical/endpoint/generation/reservation/tuple. | Validation fails before tombstone or capacity release. |
| No replenishment | Complete release, drain, absence, reset success, or reset discard below target. | Zero warm/create/replacement/queue calls except acknowledged cleanup-only start. |

### 13.2 Schema, Process, and Fault Coverage

Cover strict protocol/registry/metadata/command/reset schemas; unknown keys; malformed/partial files; symlink/hard-link ambiguity; all discriminants and illegal cross-fields; every finite checkpoint; owner/generation crossing; all cross-references; duplicate identity; migration of every shipped state/intent/tombstone/command; provider-observed versus synthesized identity; and forbidden sentinels in every serialized tree.

Use real child processes and separately assembled old/new packages for activation versus old writer; command admission versus no-dispatch reconciliation; command versus release/stop/drain; lease versus lease; warm versus warm/lease/create/start; lifecycle owner crossing; stale lock reclamation; duplicate identity publication; reset versus warm/drain/lease/capacity; and child/parent finalizer races.

Fault-inject before/after every protocol, attestation, lock, migration, atomic write/sync/rename, operation/reservation, command checkpoint, provider dispatch/readback, Git inventory/ref/advertisement/reachability probe, helper dispatch/cancel/status, operation finalizer, absence proof, reset quiescence/Git authorization/readback/topology materialization, child delete/finalization, parent finalization, and event publication. Assert exact call counts/endpoints, no adoption, no broad delete, no stale finalization, no unproven zero capacity, and no hidden target action.

### 13.3 Hosted and Live Gates

Run unit/config/CLI/state/migration/race/fault/package tests across Linux, macOS, and Windows publication modes represented by current CI. Add credential-free packaged help/schema smoke. Live Codespaces remains outside ordinary untrusted PR CI. Exact-head review, hosted CI, and authorized production proof are distinct.

Phase 1 live proof, only after owner authorization and written budget, demonstrates controlled activation with an old packaged client, target-two serial warm, unique cross-process leases, framed argv/connected-only output, branch continuity, every command admission crash, every lifecycle/readiness/release checkpoint, all retained Git-data refusals including deinitialized modules, typed absence/zero capacity, command absence, delete crash, forbidden-data absence, no adoption, no keepalive/replenishment, and exact accounting/cleanup.

Phase 2 live proof is separately authorized after all approval/security gates. It mutates every approved boundary class, proves pre-destructive quiescence/all-ref Git preservation, reserves full floor/idle, exercises operation readback and forced post-successor failure, converges independent target children including same-Codespace no-retirement partial outcome, then separately proves same-Codespace and replacement success. Mocked/hosted evidence is not live proof.

### 13.4 Merge Gates

Issue #37 may merge only after owner approval; Stories 0.1-0.7 and 1.1-1.8; controlled activation and actual zero clients; complete Git proof prerequisite; all schema/invariant/algorithm tests; complete forbidden-data audit; consistent overview/issue body; independent exact-head review; hosted CI; authorized production proof; and exact live cleanup/accounting.

Issue #38 implementation may start only after #37 is shipped, its live proof is accepted, the complete reset tuple is approved, and prototype/security review accepts pre-destructive preservation, physical union, operation readback, cleanup children, and capacity. It may merge only after all schema/capacity/reset recovery/discard tests, hosted CI, independent exact-head security review, and separate authorized production proof.

## 14. Publish-Review Remediation Closure

| Finding | Normative closure |
| --- | --- |
| 1. v1 exact lookup | Sections 2, 3, and 7 qualify exact create lineage but identify later OR-match collision; Phase 1 requires immutable-key selection plus all-field AND matching. Exact replacements for the overview, `docs/codespaces.md` warm-pool section, and issue #37 repeat it. |
| 2. fresh root | Sections 3, 4, 5, 9, 10, and tests remove fresh state root as an activation alternative. Complete launcher authority and zero clients are mandatory even for a new/empty selected root. |
| 3. existing Git protocol | Sections 1, 3, 7, stories, gates, overview, and issue #37 state that the complete replacement proof is a prerequisite and baseline porcelain/`[ahead]` is insufficient. |
| 4. reset tuple | Section 11, overview, and issue #38 reproduce the complete nine-key tuple, including operation-readback and cleanup schema versions. |
| 5. deinitialized submodules | Section 7 independently inventories every retained recursive `$GIT_COMMON_DIR/modules` repository; deinitialized/residual data is fully proved or fails closed. Tests cover deinit, orphan, and nesting. |
| 6. admitting command crash | Sections 6 and 9 define every finite pre-dispatch checkpoint, bound no-dispatch proof, exact generation race, same-lease outcome, and zero external calls. |
| 7. non-command convergence | Sections 6 and 9 provide finite readiness/start/stop/release/cleanup checkpoints and a total matrix with typed absence and source-specific terminal dispositions. |
| 8. Git before reset destruction | Sections 7 and 11 require trusted prior-task quiescence plus complete all-ref/module proof before destructive dispatch authorization. |
| 9. reset physical union | Section 11 defines a strict discriminated union. Replacement success requires predecessor bound 404 and keeps it capacity-bearing until then; only same-Codespace accepts retirement. |
| 10. same-Codespace partial | Section 11 atomically materializes complete topology, permits two mutually exclusive quarantined possibilities under one narrow shared-target identity exception, and defines physical absence that terminalizes both without retirement. |
| 11. multi-target discard | Section 11 adds independent durable target and child-operation maps, immediate per-target proof/tombstone finalization, and separate parent-only reservation consumption after all targets. |
| 12. provenance | Header/evidence/issue blocks identify review target `9b62fbc...`, implementation baseline `61767ea...`, and this artifact as post-review. No sibling is claimed as evidence. |

## 15. Exact Overview Replacement Body

Replace `docs/codespaces-warm-pools.md` with exactly the following Markdown when implementation work updates repository documentation:

```markdown
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
```

Replace the complete `## Proposed warm pools` section in `docs/codespaces.md` with exactly the following Markdown so the current-v1 page does not retain the disproven exact-by-name claim:

```markdown
## Proposed warm pools

[Codespaces warm pools](codespaces-warm-pools.md) is the post-review design direction for later delivery phases. It is not implemented in v1.

Current v1 creates and records one exact provider response/readback for a requested logical workspace and does not adopt ambiguous provider candidates. Later backend handle resolution is less strict: after the CLI loads the requested logical record, the backend scans logical-name-sorted metadata and accepts the first workspace-ID, remote-name, or Codespace-ID match. A cross-field name/ID collision can therefore select a different recorded workspace for affected observe, wait, run/exec, attach, or cancel operations. Do not treat later execution as exact-by-name until the proposed immutable registry-key selection and all-field AND match is implemented.

Phase 1 proposes app-created, fully verified, single-use warm resources and requires the replacement complete Git-preservation proof before discard. Reset/reuse is a later opt-in phase with a separate hard-gated cleanup and trust-boundary contract.
```

## 16. Exact Issue #37 Replacement Body

Replace the complete issue #37 body with exactly the following Markdown:

```markdown
## Priority

`priority: critical` - next Codespaces delivery phase after experimental Codespaces v1.

## Review provenance

The exact documentation review target is `9b62fbc11f287328c881bf762b0cc068882b8486`. Its implementation baseline is direct parent `61767eab0de1210eb1b8233cd04d78a2c0f9c7a7`. The target changes only `docs/codespaces-warm-pools-spec.md`, `docs/codespaces-warm-pools.md`, and `docs/codespaces.md`; source, native, tests, scripts, package, and workflows are unchanged. This replacement issue body is a post-review contract, not content in that commit and not implementation or live-provider evidence.

Warm pools, leases, the control registry, complete Git proof, total recovery, and reset remain unimplemented.

## Outcome

Add named pools of exact, Agent-Containers-created, fully-ready Codespaces. `ac create TASK --backend codespaces --pool NAME` atomically leases one resource to one logical task. Phase 1 is single-use: release discards the exact physical resource, capacity stays below target until a later explicit warm, and a mutated task environment never returns to another task.

## Required v1 identity correction

Current v1 records an exact create response/readback, but later backend operations do not guarantee exact handle resolution. The CLI first loads the requested logical record, then backend lookup scans logical-name-sorted metadata and accepts the first workspace-ID, remote-name, or Codespace-ID match (`src/cli.ts:206-218`, `src/backend.ts:160-166`, `src/state.ts:484-493`). A cross-field collision can therefore redirect observe, wait, run/exec, attach, or cancel.

Before pool work, introduce an unambiguous registry key and handle. Select one authority by immutable key, then AND-match every supplied logical task/workspace, workspace ID, resource, incarnation, Codespace ID/name, environment, lease, and generation field against it. Collision, duplicate, missing field, mismatch, or stale generation fails before provider, SSH, helper, or state effects. Replacing `||` with `&&` alone is insufficient because current callers assign different meanings to `handle.name`.

Create-time exact response/readback and diagnostic-only, non-adopting candidate listing remain valid and must not be weakened.

## Required Git prerequisite

The implementation baseline's deletion check uses porcelain status and `[ahead]` only (`src/codespaces.ts:88-98`). It is not sufficient. Before any Phase 1 pool code may merge or any Phase 1 DELETE may dispatch, replace it with package-owned fixed-argv proof of exact repository root/origin, clean worktree/index/untracked/in-progress state, attached non-unborn HEAD, every `refs/*` ref, every supported root/per-worktree pseudoref, every reflog old/new OID, branch/upstream, remote-tracking refs, tags, fresh advertised-origin roots, and object reachability.

Independently inventory and recursively prove every retained `$GIT_COMMON_DIR/modules` repository, commonly `.git/modules`, including initialized, deinitialized, unregistered, and residual module Git directories. Absence of a worktree or config registration proves nothing. Every retained module must map uniquely to trusted `.gitmodules` metadata, exact gitlink, expected origin, and canonical administrative path. Deinitialized modules receive complete ref/pseudoref/reflog/upstream/origin/reachability proof.

Stash, notes, replace/custom refs, unpublished tags/branches, reset-away reflog/pseudoref commits, or submodule-only unpublished data refuses deletion. Unknown, stale, orphaned, nested-unenumerable, unreadable, malformed, symlinked, escaped, unsupported, or ambiguously mapped module administration fails closed. Both destructive acknowledgements remain mandatory and never bypass proof.

## Blocking control-plane prerequisite

All Codespaces writers under one state root MUST use writer protocol `codespaces-control/v2` and one strict resource-authoritative registry. Resource/physical identity, pool warm ownership, lease, globally unique command ID/slot, finite lifecycle operation, recovery checkpoint, finalization, and capacity reservation transition in one atomic registry replacement under one versioned cross-process lock. Provider, Git, readiness, SSH, and helper I/O run outside the lock only behind exact durable checkpoints.

The shipped capacity lock is not a mixed-version fence. Some v1 command/lifecycle writers do not acquire it, and a process can load metadata then later publish command state and dispatch SSH.

`ac codespaces upgrade-control --yes` is controlled in-place activation only. An external crash-persistent launcher/deployment authority must completely control every process with root access. Before first scan it closes old/new launch, enumerates every issued client, drains or terminates and reaps every started client, and proves zero active clients for the same state-root, maintenance-lease, launcher, and activation epochs. Start prevention, PID snapshots, acknowledgements, empty roots, random paths, and finding no command receipt are insufficient.

The gate remains closed through activation and crash/resume. Resume requires exact activation generation, same launcher epoch, live maintenance capability, and newly proven zero clients. There is no fresh-state-root bootstrap or fallback in this contract. If complete authority and zero clients cannot be proved, activation is unsupported; selecting a missing/new/empty root does not waive the gate.

Only then may activation migrate exact local records to old-reader-incompatible metadata v3, build the registry, and make the old lock a permanent ownerless fence. Missing/activating/unsupported protocol blocks ordinary mutation. Activation never lists/adopts provider candidates.

Before pool delivery, land RED/GREEN fixes for:

- all-field handle/provider identity, real environment/repository-owner identity, synthesized identity migration, and conservative unverified tombstones;
- typed exact-endpoint provider errors and source/checkpoint/owner/resource/physical/incarnation/endpoint/generation-bound absence proof plus immutable finalization;
- one physical-resource sampler with full create/start, idle-return, legacy, recovery, and tombstone vectors;
- globally exact command IDs/owners/slots and command-versus-lifecycle transactions;
- finite admitting command checkpoints and generation-bound no-dispatch terminalization before helper authorization;
- complete unknown command/slot/resource/lease convergence, including typed exact resource absence;
- finite readiness/start/stop/release/cleanup checkpoints with a terminal read-only recovery row and typed absence for every legal state;
- the complete retained-Git-data prerequisite, including deinitialized/residual module repositories;
- operation-specific pristine, continuity, ordinary cleanup, recovery cleanup, command recovery, and operation recovery eligibility;
- generation-bound command, operation, delete, and legacy-intent finalization with no general unlock.

## Locked product contract

- Keep `AGENT_CONTAINERS_EXPERIMENTAL_CODESPACES=1` on every pool/control public operation.
- Keep local `gh` auth and harness orchestration. Add no credential custody or agent scheduler.
- Keep exact app-create lineage and immutable provider/source/private-port/SSH/helper/nonempty-readiness proof for warm/lease.
- Keep framed argv transport and connected-only output.
- Persist no task/readiness argv copy, output/replay bytes, forbidden hashes, credential/secret values, provider body, or raw provider error.
- Provider discovery remains diagnostic-only and never creates ownership, lease, cleanup, or mutation authority.
- One physical resource has at most one nonterminal lease and one admitting/active/unknown command.
- Global `maxTotal`, `maxRunning`, `maxCreating`, pool `maxIdle`, and one command per resource apply across pool/non-pool/legacy/recovery state.
- No lease expiry/stealing, daemon, scheduler, timer, keepalive, startup warm, hidden create/start, queued replacement, automatic replenishment, or output replay.
- Recovery/quarantine is non-leasable and exact allowlisted recovery is not unlock/adoption/state editing.
- Reset/reuse is #38 and MUST NOT ship in Phase 1.

## Configuration

~~~yaml
backends:
  codespaces:
    maxTotal: 4
    maxRunning: 2
    maxCreating: 1
    maxParallelCommandsPerWorkspace: 1
    pools:
      coding:
        desiredReady: 2
        maxIdle: 2
        releasePolicy: discard
~~~

`desiredReady` is an explicit warm target. `maxIdle` counts every effective unleased reservation, including create/provisioning/stopped/blocked/recovery/quarantine and lease-verification idle-return reservations. The command limit equals one. Pools require nonempty `readiness.command`; `ready-without-setup-proof` is ineligible. Unknown keys fail before effects.

Config load has no effect. First explicit warm creates/synchronizes a configured pool under CAS. Removed/policy-drifted pools remain status/drain/discard capable but cannot warm/lease.

## Canonical CLI

~~~sh
ac codespaces upgrade-control --yes
ac pool warm coding --count 2 --yes-cost
ac pool status coding
ac create fix-login --backend codespaces --pool coding
ac run fix-login -- opencode "Fix the login bug"
ac release fix-login --discard --yes --force-remote-data-loss
ac pool drain coding --yes --force-remote-data-loss [--yes-cost]
~~~

- `warm --count N` reaches N ready-idle resources; omission uses `desiredReady`; zero is valid; warm never shrinks.
- One nonzero warm owns a pool and serially completes every observation/start/create/readiness action.
- `create --pool` is immediate lease-only, rejects cost/machine/geo/wait/fallback, and performs no paid action.
- Pool miss is exit `1`; stopped-only is `POOL_STOPPED`.
- A stopped leased task remains owned. `ac start TASK --yes` resumes only the same lease.
- Release/drain require destructive acknowledgements. Exact stopped cleanup additionally needs `--yes-cost` and full start reservation.
- Release/drain/recovery do not replace capacity. Later explicit warm is required.
- Status is local/read-only. `--probe` permits only `GET /user` plus one exact GET per selected record and no SSH/helper/readiness/Git/write/mutation/list/adoption.

## Canonical capacity

Use one sampler over every physical resource and legacy/reset reservation. For each Phase 1 resource, combine base state and active operation by component-wise maximum, not addition.

The first create-intent transaction reserves `{total:1,running:1,creating:1}` and tests all limits. Start reserves the same vector at admission. It weakens only through atomic no-dispatch/stable-stopped, ready, or absence finalization. Every non-tombstoned resource is total one. Running is zero only when exactly stopped with no possible create/start. Only a valid exact-GET-404 tombstone is zero. Every finite checkpoint has one validated vector.

Lease verification retains `idleReturnReservation: 1`. Warm cannot use it. Success consumes it; stopped/blocked refusal converts it to ordinary idle occupancy; typed absence removes it; uncertainty retains it.

## Warm and lease

Warm installs one pool owner and one exact action atomically, freshly observes deterministic candidates, then prefers exact stopped starts and exact creates with full reservations. First failure/ambiguity/unreachable/quarantine/capacity block stops. Crash reconciliation finalizes only the action, clears ownership, and never continues the target.

Lease reservation binds one recorded candidate and idle-return reservation before one bounded pristine proof. Success activates. Stopped/blocked safely returns idle occupancy. Typed 404 atomically records bound absence, tombstones, removes unactivated lease/reservation, and returns `POOL_MISS`. Uncertainty retains exact recovery. It never tries a second candidate.

## Identity and task continuity

Warm/initial lease is pristine and exact. Post-lease command/attach/cancel/stop/resume uses continuity and MUST NOT compare baseline provider ref, branch, HEAD, cleanliness, origin, or pristine readiness. A task may create/switch branches, commit, run sequential commands, stop, and resume on one lease/incarnation.

## Command authority and recovery

Reserve command ID globally and install exact command/slot as `authority-reserved`. Advance through `request-published` and `continuity-verifying`, then atomically publish `dispatch-authorized`. Only that generation may invoke helper transport.

A crash at any pre-dispatch checkpoint is accepted by `reconcile-command --command C --operation O --generation G`. It performs zero provider/SSH/helper calls and atomically writes owner/generation/checkpoint-bound `not-dispatched` history, clears only the slot, preserves the same lease, and fences paused writers. A helper `accepted` state or owner/generation mismatch fails closed. Once dispatch authorization wins, no-dispatch finalization is forbidden.

Post-dispatch ambiguity stores one exact unknown command/slot/resource/lease tuple. Reconciliation inspects/cancels only that helper. If unavailable, exact resource GET 404 atomically terminalizes `resource-absent`, tombstones, closes lease, frees capacity, and returns `COMMAND_RESOURCE_ABSENT` with no Git/delete/start/list/warm.

## Total lifecycle recovery

Readiness, start, stop, release, and drain/legacy/recovery cleanup use finite strict checkpoints. `reconcile-operation` requires exact operation/resource/lease/warm generations and never repeats PATCH, DELETE, Git proof, or target policy.

Every checkpoint accepts typed exact GET 404 as a source-bound atomic tombstone outcome. Running/stopped readiness/start/stop outcomes finalize only the recorded context. Start/stop PATCH is never retried. Every release checkpoint before DELETE dispatch rolls an exact live target back to the same active task lease and can close typed absence; it performs no Git/start/DELETE. Every cleanup checkpoint before DELETE similarly restores exact cleanup-required state or tombstones. After DELETE may have occurred, only exact GET 404 finalizes and exact live/unreachable retains delete recovery.

No operation disappears on terminalization: each terminal result stores immutable finalization in the same registry replacement as resource/lease/warm/reservation changes. Ambiguous response-less create remains explicit nonterminal recovery because listing/adoption cannot safely identify it.

## Bound absence proof

Only typed HTTP 404 from GET of the exact recorded Codespace endpoint proves absence. Proof and immutable finalization cross-bind source kind/checkpoint/authority generation/owner epoch, original/finalizer operation, resource, physical resource, incarnation, host, Codespace ID/name, canonical endpoint, admitted generation, and fresh tombstone generation. Orphaned/copied/stale proof, DELETE 404, text messages, and historic booleans never free capacity.

## Complete Git preservation and discard

Every live delete runs the prerequisite proof of the superproject and every retained module repository. It covers root/origin, worktree/index, every ref, supported pseudoref, every reflog OID, branch/upstream, remote tracking, tags, fresh advertised origin, and reachability. It independently recurses through initialized, deinitialized, and residual `$GIT_COMMON_DIR/modules` repositories. Unmapped/unreadable/unsupported module administration fails closed.

Release first publishes releasing. Exact stopped, deterministic Git refusal, or generation-bound pre-delete live reconciliation restores the same active lease before response. Only after complete Git proof may it publish DELETE-dispatched. Exact GET 404 is required after DELETE. Ambiguity retains lease/checkpoint/capacity.

Drain completes only with no live/nonterminal resource, lease, warm, operation, idle/reset reservation, reset parent/child, or cleanup recovery. Valid terminal histories do not block.

## Legacy migration

Synthesized environment and missing repository-owner identity stay cleanup-only until exact binding. Shipped tombstones stay unverified/capacity-bearing until bound GET 404. Opaque recovery is retained without invented fields.

A response-free shipped intent reaches zero only when exact pre-dispatch state/order and actual zero old clients prove no dispatch. Proof binds activation/launcher/state-root/reservation generations. Any possibility blocks activation. Publication uncertainty leaves protocol activating; exact activation resume is the sole convergence.

## Machine data

Use versioned structural envelopes and stable outcomes including `not-dispatched`, `resource-absent`, and `release-rolled-back`. Connected output stays raw/non-durable. No provider body/raw error or forbidden command/secret material enters state/events.

## Acceptance criteria

- [ ] Cross-field logical/remote-name collision cannot redirect any backend operation; every supplied handle field is AND-matched.
- [ ] Controlled activation cannot begin until a paused old package exits/is reaped; no fresh/missing/empty-root bypass exists.
- [ ] Create/start full vectors and lease idle-return reservation prevent global/idle overflow across processes.
- [ ] Every command pre-dispatch checkpoint generation-bound terminalizes with zero external calls; authorization race has one winner.
- [ ] Unknown command exact 404 atomically closes command/resource/lease and capacity.
- [ ] Every readiness/start/stop/release/pre-delete checkpoint has typed absence and exact live terminal/convergent behavior with no mutation retry.
- [ ] Release pre-delete recovery restores only the same lease; post-delete recovery never rolls back.
- [ ] Proof/finalization copying or field mutation cannot free capacity.
- [ ] Stash, unpublished tag/note/custom ref, reset-away reflog commit, and initialized/deinitialized submodule-only data all produce zero DELETE.
- [ ] Orphaned/nested/unreadable/malformed/escaping residual `.git/modules` state fails closed.
- [ ] One warm owner prevents proof stealing and crash recovery never continues target.
- [ ] Branch create/switch, commits, sequential commands, stop/resume stay on the same lease without pristine checks.
- [ ] Release/drain/recovery make zero replacement/queued calls; no background maintenance exists.
- [ ] No durable state contains forbidden argv/output/hash/credential/secret/provider data.
- [ ] Full hosted, process, race, fault, exact-head review, and separately authorized production proof passes.

## Dependency and non-goals

Reset/reuse is #38 and MUST NOT be implemented here. Also excluded: arbitrary adoption, cross-host scheduler, credential custody, output replay, lease stealing, keepalive, automatic warming, and replenishment.
```

## 17. Exact Issue #38 Replacement Body

Replace the complete issue #38 body with exactly the following Markdown:

```markdown
## Priority

`priority: critical`, hard-blocked follow-up to #37.

## Review provenance and hard dependency

The exact documentation review target is `9b62fbc11f287328c881bf762b0cc068882b8486`. Its unchanged implementation baseline is direct parent `61767eab0de1210eb1b8233cd04d78a2c0f9c7a7`; the target changes only three Codespaces documentation files. This replacement issue body is a post-review contract, not content in that commit and not reset implementation, security approval, or live-provider evidence.

Do not begin implementation until #37 is shipped and its exact production artifact passes separately authorized live activation, warm, lease, branch-continuity, command, complete retained-Git-data preservation, discard, lifecycle recovery, and capacity proof. Link the artifact, exact-head review, hosted CI, live proof, budget, and resource accounting as distinct gates.

## Outcome

Optionally return a previously leased physical pool resource only after an owner-approved immutable threat/boundary contract and exact package-owned primitive prove a new incarnation and every claimed process, writable-state, mount/cache, and credential boundary. Discard remains the default and available path. Git preservation protects repository data; it is not sanitization.

## Complete immutable approval tuple

Owner and independent security reviewer MUST approve this exact strict tuple before product code:

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

All first seven keys through `resetProofSchemaVersion` plus the two mandatory operation-readback and cleanup schema versions are required, for nine keys total. The tuple appears in approval/security artifacts, config, pool-policy generation, package descriptor, reset operation, parent reservation, pre-destructive proof, success/failure proof, every physical target and child operation/finalization, predecessor/successor records, and status. Missing, extra, stale, or mismatched fields fail before effects. Any primitive, readback, cleanup, boundary, evidence, capacity, or provider-guarantee change requires a new approval version.

The threat model defines prior-task adversary/privileges; every process/job/service/socket/helper child; every repository/home/mount/volume/cache/temp/tool/helper/credential writable surface; exclusions and accepted residual risk; trusted out-of-task invocation; typed process termination/non-restart; writable destruction/replacement/rekey; new environment identity; secret/Git-credential revocation; provider guarantees versus observations; and allowed task populations. Unknown/best-effort classes keep reset disabled.

## Trusted primitive and pre-destructive preservation

The exact package-owned primitive MUST target only recorded predecessor identity; accept a client operation ID before dispatch; expose typed exact operation readback by ID; return complete bounded physical topology and every possible billed target; make typed no-dispatch mean no destructive/successor effect; run outside prior-task influence; terminate/prevent restart of all in-boundary processes; destroy/replace/rekey all included writable state; account for exclusions; produce a different non-null environment identity; re-bootstrap helper trust; permit exact provider/repository/port/SSH/readiness proof; declare peak deltas; and provide trusted quiescence/Git/delete/absence cleanup for every target.

Before any destructive primitive call, one control transaction records reset/primitive operation IDs, exact readback endpoint, predecessor, generations, future-idle reservation, and full capacity floor with dispatch false. A trusted out-of-task channel then acquires/readbacks a durable hold preventing every prior-task mutation/restart and runs #37's complete all-retained-Git-data proof while held. A generation-checked transaction publishes `destructive-dispatch-authorized`; from that generation the writer must publish and revalidate `destructive-dispatched` with dispatch possible before invocation. Losing either generation causes zero primitive calls.

The Git proof includes all refs, supported pseudorefs, every reflog OID, and every retained initialized/deinitialized/residual `$GIT_COMMON_DIR/modules` repository. Stash, notes, custom refs, unpublished commits, unknown module administration, malformed evidence, or a mutation race causes zero primitive calls. The same lease is restored only after typed no-dispatch and hold release; uncertainty retains full recovery/accounting.

Provider listing is never readback or cleanup authority. A primitive capable of producing an unidentifiable or uncleanable target, losing operation correlation, or losing quiescence is inadmissible. Git reset/clean, process listing, Dev Container restart, stop/start, arbitrary shell cleanup, in-environment probes, and secret scans are not sanitization.

## Policy and UX

Reuse is disabled by default and requires the Codespaces gate plus a separate reuse gate.

~~~yaml
pools:
  coding:
    desiredReady: 2
    maxIdle: 2
    releasePolicy: reset
    reuse:
      enabled: true
      threatModelId: agent-task-isolation
      threatModelVersion: "1"
      boundaryId: codespaces-full-reincarnation
      boundaryVersion: "1"
      resetPrimitiveId: github-reincarnate
      resetPrimitiveImplementationVersion: "1"
      resetProofSchemaVersion: 1
      resetOperationReadbackSchemaVersion: 1
      resetCleanupSchemaVersion: 1
~~~

Only resources freshly warmed after Phase 2 activation under the exact tuple are reuse-eligible. Phase 1, migrated, provisional, recovery, quarantine, and existing-lease resources remain discard-only. Tuple drift disables reset but not exact discard.

~~~sh
ac release fix-login --reset --yes --force-remote-data-loss --yes-cost
ac release fix-login --discard --yes --force-remote-data-loss
ac pool reconcile-reset coding --resource R --reset-operation O --reservation S \
  --generation G --lease-generation LG --lease-record-generation LRG
ac pool recover-reset-discard coding --resource R --reset-operation O \
  --reservation S --generation G --lease-generation LG \
  --lease-record-generation LRG --yes --force-remote-data-loss [--yes-cost]
~~~

No reset/reconciliation/success/discard completion invokes warm, create, replacement, queue, or replenishment.

## Physical-outcome proof

Reset success proof is a strict discriminated union.

Same-Codespace success requires equal physical-resource ID, Codespace ID/name/endpoint; different resource/incarnation and non-null environment identities; and typed predecessor environment retirement bound to the exact successor. It may not substitute physical absence while successor is live at the shared endpoint.

Replacement success requires distinct physical-resource IDs, Codespace IDs/names/endpoints and a bound exact-GET-404 predecessor target proof/finalization. Environment retirement cannot release a distinct billed predecessor. Replacement predecessor remains capacity-bearing and blocks drain until its own absence is finalized. It never becomes `reset-retired`.

Fields from the other physical variant are rejected as unknown.

## Capacity and state

Before preflight, one #37 transaction reserves one future idle slot plus an aggregate capacity floor equal to predecessor contribution and the descriptor's complete additional peak total/running/creating vector. If any dimension overflows, leave lease unchanged.

While parent reservation exists, linked authorities form one reset group contributing the maximum of the full floor and summed current physical-target vectors. Linked targets are not double-counted and add no separate idle slot. A child's immediate tombstone makes that target's ordinary contribution zero but never weakens the parent floor or future idle reservation.

Same-Codespace success consumes parent only with retirement plus ready successor. Replacement success consumes only with predecessor absence plus ready successor. Discard consumes only after every physical target is terminal absent. Drain is blocked by every parent, active child, or nonterminal target.

Strict registry v2 replaces Phase 1 authority types and adds exact reuse tuple, reset states, operation/failure/proof, parent reservations, independent parent discard operations, physical cleanup targets, child cleanup operations, separately keyed child absence proofs, and immutable child finalizations. Every link is strict and bidirectionally exact.

## Reset flow and read-only reconciliation

1. Require shipped #37 gates, exact active eligible lease, null barriers, approved tuple, secret policy, acknowledgements, and capacity.
2. Persist operation/readback/predecessor/generations/full reservation before trusted preflight.
3. Acquire/readback prior-task quiescence and complete all-ref/module Git preservation.
4. Atomically authorize destructive dispatch, then publish/revalidate `destructive-dispatched` before invoking only the approved primitive. A crash before that checkpoint may prove no dispatch; a crash after it must use operation readback.
5. Require complete topology, different environment identity, correct physical predecessor disposition, trusted boundaries/helper, exact clean successor repository/source, private ports, SSH, and readiness.
6. Same-Codespace finalizes retirement/ready successor in one transaction.
7. Replacement materializes an independent predecessor absence child. Its 404 tombstones predecessor immediately while parent floor remains; only then may ready successor/lease/proof and parent success finalize.
8. Any interruption/mismatch/unproven result records exact recovery/quarantine with full accounting.

`reconcile-reset` exact-GETs only recorded operation/target endpoints. Typed no-dispatch releases hold, restores same lease, and consumes undispatched reservation. Complete success follows the correct union. Typed failed/partial complete topology atomically stores every physical target and possible incarnation authority while entering discard quarantine, even when same-Codespace retirement is absent. Unknown/malformed/unreachable/incomplete/stale evidence retains full recovery. It never repeats reset, lists, adopts, switches target, or continues pool target maintenance.

## Independent reset-failure cleanup

`recover-reset-discard` is the sole post-dispatch cleanup path. It creates one durable parent operation independent of resource authorities and keeps the full reservation.

Operation readback atomically materializes immutable physical targets and all possible incarnation authorities before topology becomes complete. Replacement creates ordered predecessor/successor single-incarnation targets. Predecessor-only creates one target. Same-Codespace creates one shared target covering both exact possible incarnation/environment bindings. A typed partial same-Codespace result may validly have no retirement proof; its two authorities are mutually exclusive possibilities, quarantined/non-executable, and are the sole narrow exception to live identity uniqueness while linked to one target and parent.

Each nonterminal target gets an independently generated child operation bound to parent/reset/primitive/reservation/tuple/target/generation/endpoint/members. Exact live identity must match the single member or, for shared target, exactly E1 or E2. A third environment performs zero delete.

Live targets require trusted quiescence and #37's complete superproject and retained-module Git proof. Stopped targets additionally require `--yes-cost` and absolute start reservation. Delete dispatch is separately checkpointed. DELETE 404 is insufficient; exact GET 404 is mandatory.

One child finalization transaction consumes only that exact child generation into immutable history, stores separately keyed target proof, marks target terminal, and immediately makes covered authorities proof-bearing `reset-tombstoned`. For a shared target, physical absence covers both exact E1/E2 possibilities without invented retirement. Parent operation, lease, reset failure, full capacity floor, and idle reservation remain.

Crash after target A finalization resumes target B through its own child without replaying A. After all targets are terminal and no child is active, one provider-free parent transaction stores immutable parent finalization with exact target/finalization IDs, marks lease `released-reset-discarded`, consumes failure/parent/reservation, and releases capacity. It creates no delayed tombstones.

## Secret and credential boundary

Reset is denied when named-secret capability is nonempty or Codespaces Git credential capability is enabled unless separately approved provider-side revocation/reprovisioning and residue-destruction proof covers every included surface and accepted exclusion. Agent Containers never reads/persists secret values. Value scanning is not proof.

## Migration

Phase 1 discard remains default. Every migrated resource is reset-ineligible with null tuple/proof/reservation/target; existing leases remain discard-only. Provisional identity, legacy cleanup/unverified tombstones, admitting/active/unknown commands, operation recovery, and quarantine remain reset-ineligible. Config alone never upgrades a resource. Cross-tuple reuse is forbidden.

## Acceptance criteria

- [ ] #37 shipped artifact, exact-head review, hosted CI, authorized live proof, budget, and accounting are linked/distinct.
- [ ] The complete nine-key tuple exists in overview/config/package/operation/proof/cleanup/status; omitted readback or cleanup version rejects before effects.
- [ ] Primitive dispatch is impossible without durable trusted quiescence and complete predecessor Git proof.
- [ ] Stash/note/custom ref/unpublished commit/deinitialized module data or mutation race causes zero primitive calls.
- [ ] Every pre-dispatch crash proves no dispatch/hold release or remains fully blocked without speculative invocation.
- [ ] Primitive invocation is preceded by durable `destructive-dispatched`; a crash before/after that transaction cannot leave a false dispatch flag.
- [ ] Same-Codespace and replacement proof variants reject each other's fields and enforce retirement versus absence.
- [ ] Replacement environment retirement without predecessor 404 cannot finalize, release capacity, or let drain complete.
- [ ] Replacement predecessor 404 tombstones immediately but parent floor stays until successor success finalizes.
- [ ] Typed same-Codespace partial without retirement enters valid shared-target discard.
- [ ] Complete partial topology, targets, and possible incarnation authorities commit atomically; no crash leaves complete target IDs without bindings.
- [ ] Shared-target cleanup accepts only exact E1/E2 and bound physical 404 terminalizes both without fabricated retirement.
- [ ] Each physical target has independent target generation, child operation, proof, and immutable finalization.
- [ ] Target 404 immediately tombstones that target while full parent floor/idle remains.
- [ ] Crash after target A finalization resumes B without replay/loss; parent finalization performs no provider call.
- [ ] Copied/orphaned/cross-target/cross-operation/cross-reservation/cross-tuple/stale/text/DELETE-404 evidence cannot tombstone or free capacity.
- [ ] Drain blocks on every parent, child, and nonterminal target.
- [ ] Stopped cleanup requires `--yes-cost` and absolute start reservation.
- [ ] Reset success/discard make zero warm/create/queued replacement/replenishment calls.
- [ ] No reset state/proof contains forbidden argv/output/hash/credential/secret/process/path/raw-provider data.
- [ ] Full schema, transition, capacity, process, race, fault, CLI, hosted CI, exact-head security review, and authorized live tests pass.

## Explicit non-goals

Cross-actor/owner/billing/repository/source reuse, arbitrary adoption, arbitrary reset scripts, credential migration, hidden retry/replenishment, background reset, keepalive, output replay, same-incarnation best-effort cleanup, bypass of #37 barriers, and deletion of an unproven target.
```

## 18. Final Architecture Position

Build Phase 1 around one version-fenced atomic control registry after controlled in-place activation. The permanent old-lock fence blocks newly launched old clients; actual launcher drain/zero-client proof blocks already-started v1 writers. This contract intentionally provides no fresh-root bypass.

Select one resource by immutable registry key and AND-match every handle field. Preserve immutable pristine proof at warm/lease boundaries while treating post-lease branch/files as task-owned. Command/resume uses continuity. Every command admission checkpoint and every non-command lifecycle checkpoint converges through exact generation-bound authority.

Land the complete retained-Git-data proof as a prerequisite. Every live deletion and every destructive reset first proves refs, pseudorefs, reflogs, and all retained module Git repositories, including deinitialized `.git/modules` data. Baseline porcelain/`[ahead]` is not sufficient.

Keep Phase 2 closed unless one exact versioned primitive proves prior-task quiescence, pre-destructive Git preservation, new incarnation, complete target readback, trusted cleanup reachability, and approved process/writable/credential boundaries within a full parent capacity floor. Same-Codespace success requires retirement; replacement success requires predecessor absence. Failed reset cleanup tombstones each physical target through an independent child while parent accounting persists to terminal convergence.
