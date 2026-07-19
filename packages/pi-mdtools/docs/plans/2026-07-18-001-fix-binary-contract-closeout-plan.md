---
status: completed
date: 2026-07-18
title: Binary-owned contract — closeout
scope: cross-repo (mdtools + pi-mdtools)
---

# Binary-owned contract closeout

One focused architecture pass, then build locally. Closes the remaining
authority gaps so mutation outcomes, executable identity, temp-file ownership,
benchmark visibility, and recovery advice are truthful and mechanically tested —
without expanding v0.2 into an OS-locking project.

## Objective

Close the remaining authority gaps so mutation outcomes, executable identity,
temp-file ownership, benchmark visibility, and recovery advice are truthful and
mechanically tested — without expanding v0.2 into an OS-locking project.

### Requirements

- R1: A mutation is reported completed or rejected only from a validated binary receipt.
- R2: Any started mutation without authoritative output is indeterminate; anything proven not started is untouched.
- R3: Probe, execution, recovery enrichment, and status share one stable observed binary context.
- R4: Free-form argument values cannot re-enter option parsing.
- R5: Atomic-write cleanup never removes an entry whose ownership was never established or is known lost.
- R6: Full command inventory and prompt-advertised commands are distinct, mechanically validated sets.
- R7: Remediation remains binary-owned and is correct for the target domain and selector role.
- R8: Public wording distinguishes etag checking, atomic replacement, cross-process CAS, and observed executable identity.

## Architecture Decision

Approach: Strengthen the existing authority seams rather than introduce a new protocol version:

- Pi owns subprocess lifecycle and transport authority through a typed mutation outcome.
- Rust's MutationResult, diagnostics, selector roles, and capabilities remain the domain authorities.
- Pi acquires an observed executable context using nanosecond stat identity checkpoints around the schema probe and command spawn.
- Rust's atomic writer gains explicit temp ownership.
- Benchmark inventory gains an explicit prompt-visibility policy.
- Documentation states the remaining concurrency boundaries exactly.

Rationale: Both repositories already contain the right primitives: MutationResult,
the diagnostic macro, md schema, the handshake cache, and one atomic writer.
Extending those is simpler and more testable than adding locking, OS-specific
executable handles, or a second protocol.

Rejected alternative: Implement filesystem-level CAS and execute copied/private
binary snapshots now. That would require new OS-specific lifecycle and cleanup
machinery unrelated to the two actual merge blockers.

Accepted trade-offs:

- A final stat-check→spawn race remains; the adapter promises observed stability at checkpoints, not exact inode execution.
- Etag guards are same-invocation drift checks, not CAS against external writers.
- The existing std-only check→unlink and check→rename gaps remain documented.
- One filesystem stat per call remains acceptable.

## High-Level Technical Design

```
Pi tool call
  → resolve path
  → stat identity A
  → probe `md schema --json`
  → stat identity B
       changed → discard/retry
  → observed execution context
  → recheck abort + identity before command spawn
       changed → reacquire; do not start mutation
  → execute
  → lifecycle + exit + typed decoder
       valid mutation receipt → completed
       valid v1 error envelope → rejected
       never started → not_started
       anything else after start → indeterminate
  → result envelope → rendering + telemetry
```

Recovery reads use the same observed context and revalidate it. They never
independently resolve or handshake another binary.

### Representation ledger

| Meaning | Authority | Derived consumer / mirror | Drift guard |
|---|---|---|---|
| Mutation receipt | Rust MutationResult | Pi defensive decoder | Unit tests + real-binary parity |
| Diagnostic and role | Rust diagnostic macro + typed selector role | Pi projection | Exhaustiveness and parity tests |
| Mutation lifecycle outcome | Pi runtime | Result metadata and telemetry | Discriminated-union tests |
| Binary capabilities | Rust md schema | Pi required-capability policy | Real-schema parity |
| Prompt visibility | Bench inventory policy | Display/allowed prompt sets | Python loader tests |
| Etag concurrency claim | Runtime behavior | README, help, prompts, ADR | Wording sweep and behavior probes |

## State-Action Contracts

### Mutation outcome

| State | Caller observation | Durable file state | Side effects | Race behavior | Locking test |
|---|---|---|---|---|---|
| Abort before runner | E_MD_COMMAND_ABORTED, not_started | Untouched | Usage line only | Abort rechecked after every pre-spawn await | pre_start_abort_never_spawns |
| Launch fails before spawn | Launch failure, not_started | Untouched | No child process | Cannot be confused with post-start loss | launch_error_is_untouched |
| Exit 0 + valid receipt | ok, completed | Fully committed or authoritative no-change | Guard result and telemetry recorded | Same-file Pi calls remain queued | valid_receipt_is_completed |
| Nonzero + valid v1 error | Mapped failure/ambiguity, rejected | Untouched by binary contract | Bound enrichment allowed | No independently resolved recovery binary | structured_rejection_is_clean |
| Started, any other result | E_MD_COMMAND_ABORTED, indeterminate | Old or fully replaced; re-read required | Telemetry marks file re-query-relevant | Late abort/output loss never becomes failed-clean | lost_result_is_indeterminate |

Invariants:

- Mutation status === "ok" iff mutationOutcome === "completed".
- mutationOutcome === "indeterminate" iff the process started and no authoritative receipt was accepted.
- guardedResult exists only after a validated mutation receipt.
- Re-query tracking is set for completed or indeterminate, never inferred from status alone.

### Observed binary identity

| State | Observation | Mutation effect | Cache behavior | Test |
|---|---|---|---|---|
| Stable identity | Probe/result reused | Normal execution | Cached by path, dev, ino, size, mtimeNs, ctimeNs | stable_identity_reuses_probe |
| Changes during probe | Probe discarded and retried | No mutation spawn | Unstable result not cached | swap_during_probe_rebinds |
| Changes before command | Context reacquired | No command under stale context | Old entry invalidated | swap_before_spawn_rebinds |
| Repeated churn | Typed pre-start failure/status | Untouched | Nothing cached | identity_churn_stops_cleanly |
| Swap after final check | Documented residual | Replacement may execute | Response still undergoes schema/receipt validation | Explicit non-goal |

### Atomic temp ownership

| State | Caller observation | Target | Temp/foreign entry | Test |
|---|---|---|---|---|
| create_new collision | I/O failure | Untouched | Existing entry retained | collision_does_not_cleanup_foreign_entry |
| Owned temp, later ordinary error | I/O failure | Untouched | Removed only after same-inode check | owned_temp_is_cleaned |
| Path substitution detected | I/O failure | Untouched | Substituted entry retained | substitution_relinquishes_cleanup |
| Successful rename | Success | Complete replacement | No staging entry | Existing atomic-write suite |

Omitted-state challenge:

- Process death may leave a staging file, but the target remains old and complete.
- A swap after the final identity check remains outside the std-only guarantee.

## Implementation Units

### U1. Authoritative Pi mutation outcomes

- Goal: Make lifecycle and binary receipts the only authority for mutation results.
- Requirements: R1, R2, R4
- Dependencies: None
- Files:
    - pi-mdtools Modify: src/types.ts, src/runtime.ts, index.ts, src/usage.ts
    - pi-mdtools Test: test/runtime.test.ts, test/integration.parity.test.ts, test/usage.test.ts
- Approach: Add a process-start discriminator and typed not_started | rejected | completed | indeterminate mutation outcome. Validate required MutationResult fields while accepting additive fields. Emit etags as --expect-etag=<value>.
- Patterns to follow: decodeBinaryErrorEnvelope defensive narrowing; Rust src/model.rs mutation receipt.
- Test scenarios:
    - Happy path: valid set-task, move-section, and replace-section receipts are completed and preserve raw data.
    - Edge: schema-valid junk is indeterminate, not success.
    - Edge: expectEtag: "--help" reaches Rust as data and produces an etag diagnostic.
    - Error: pre-start launch failure is untouched; nonzero/no-envelope and exit-0/unparseable after start are indeterminate.
    - Integration: telemetry counts a read after completed or indeterminate mutation as a re-query.
- Verification: No started mutation lacking a valid receipt can surface as ordinary failed-clean or success.

### U2. Stable observed executable context

- Goal: Keep schema classification, execution, recovery, and status on one observed identity.
- Requirements: R3
- Dependencies: U1
- Files:
    - pi-mdtools Modify: src/runtime.ts, src/types.ts, src/content.ts
    - pi-mdtools Test: test/runtime.test.ts, test/integration.parity.test.ts
- Approach: Use bigint stat identity including mtimeNs and ctimeNs; compare before/after probing and immediately before each spawn. Retry boundedly on change. Carry the context into failure decoding and enrichment instead of re-resolving.
- Patterns to follow: Existing session runtime and handshake cache.
- Test scenarios:
    - Happy path: unchanged binary incurs one probe per identity.
    - Edge: atomic replacement, in-place same-size overwrite with restored mtime, and schema-time self-replacement all invalidate.
    - Error: repeated churn yields an unstably-observed pre-start result, never a mutation spawn.
    - Integration: status reports the resolution it actually probed; recovery enrichment cannot run a different identity.
- Verification: No fresh resolveBinary() or handshake occurs inside failure classification or enrichment.

### U3. Ownership-aware atomic cleanup

- Goal: Stop error cleanup from deleting pre-existing or substituted staging entries.
- Requirements: R5
- Dependencies: None
- Files:
    - mdtools Modify: src/output.rs
    - mdtools Test: src/output.rs, tests/cli_section_etag.rs
- Approach: Represent successful exclusive creation as an ownership-bearing guard. Cleanup is disabled when creation failed or substitution was detected; ordinary cleanup verifies the directory entry still names the owned inode.
- Patterns to follow: Existing handle-based permission and inode checks in write_file_atomic.
- Test scenarios:
    - Happy path: permissions, symlink-referent behavior, and atomic rename remain unchanged.
    - Edge: planted temp collision remains untouched.
    - Error: substituted path is detected without removing attacker bytes.
- Verification: The unconditional remove_file(tmp_path) path no longer exists.

### U4. Separate inventory from prompt visibility

- Goal: Restore the complete benchmark gate without changing the benchmark documentation to advertise metadata tooling.
- Requirements: R6
- Dependencies: None
- Files:
    - mdtools Modify: bench/md_inventory_v1.json, bench/command_policy.py, bench/test_analyze_inputs.py
    - mdtools Test: bench/test_command_policy.py
- Approach: Add an optional prompt-visibility policy, default true; mark schema non-visible. Full command/kind parity remains unchanged, while prompt/display sets derive only visible commands.
- Patterns to follow: The existing single inventory loader and Rust schema parity test.
- Test scenarios:
    - Happy path: ordinary commands remain visible.
    - Edge: schema remains in full/query inventories but not prompt surfaces.
    - Error: non-boolean visibility values fail inventory loading.
    - Integration: the frozen manifest check and full unittest discovery pass.
- Verification: python3 -m unittest discover -s bench -p 'test_*.py' is fully green and no prompt-doc text is added merely to satisfy parity.

### U5. Domain- and role-correct remediation

- Goal: Ensure every hint names a recovery action valid for the failing command and role.
- Requirements: R7
- Dependencies: U2
- Files:
    - mdtools Modify: src/errors.rs, src/commands/section.rs, src/commands/move_section.rs, src/commands/replace.rs, src/commands/table.rs
    - mdtools Test: tests/cli_error_envelope.rs, tests/cli_move_section.rs, tests/cli_table.rs
    - pi-mdtools Modify: src/runtime.ts
    - pi-mdtools Test: test/runtime.test.ts, test/integration.parity.test.ts
- Approach: Replace free-form Rust selector roles with a closed enum, make overloaded invalid_selector defaults domain-neutral, add precise call-site hints, and retain source/destination context for etag ambiguity. Pi rewrites occurrence advice only for a recognized role.
- Patterns to follow: Existing etag-mismatch role factories and exhaustive diagnostic macro.
- Test scenarios:
    - Happy path: source/destination occurrence advice names the correct Pi parameter.
    - Edge: 25-match capped context retains role and total count.
    - Error: multi-table selection recommends --index, never heading occurrence or :preamble.
    - Error: unknown role preserves the binary hint instead of fabricating target advice.
- Verification: Rust remains the remediation authority; TypeScript performs projection only.

### U6. Contract wording and final cross-repo gate

- Goal: Make every public claim match the implemented guarantee and close the branches with one evidenced gate.
- Requirements: R8
- Dependencies: U1–U5
- Files:
    - mdtools Modify: README.md, CLAUDE.md, src/cli.rs
    - pi-mdtools Modify: README.md, index.ts, src/runtime.ts, src/prompts.ts, docs/adr/0003-binary-owned-contract.md
    - pi-mdtools Test: test/usage.test.ts
- Approach: Use "content fingerprint," "same-invocation guard," "atomic replacement," and "observed binary identity." Explicitly deny cross-process CAS and exact executable binding.
- Test scenarios:
    - Documentation: no "atomically with the splice" or "exact binary" overclaim remains.
    - Integration: prompt budget remains under 400 tokens.
    - Gate: Rust tests/fmt, full Python discovery, Pi typecheck/unit, and real-binary parity all pass against the freshly built binary.
- Verification: Both worktrees finish clean on local branches; no push or PR.

## Scope Boundaries

- No mdtools wire schema version bump.
- No new diagnostic code.
- No command or Pi tool surface expansion.
- No benchmark prompt prose added for md schema.
- No Pi queue rewrite: the dependency already canonicalizes existing file paths.
- No push or PR during this local workflow.

### Deferred to Follow-Up Work

- Filesystem-level CAS or cooperative cross-process locking.
- Immutable executable snapshot or fd-based execution.
- Syscall-backed conditional unlink/rename, directory fsync, and orphan-temp scavenging.
- Granular Rust diagnostics for open/write/fsync/rename/stdout failures.
- collect versus FileSet::is_multi() wire-shape reconciliation.
- Deriving command-kind and argument grammar mirrors from schema.
- Existing table-row etag ambiguity residual.

## System-Wide Impact

- Interaction graph: Pi tool → observed binary context → subprocess → binary receipt/envelope → Pi projection → rendering and telemetry.
- Error propagation: Rust owns domain errors; Pi owns launch, identity, transport loss, and indeterminate-state classification.
- State lifecycle: Only validated receipts authorize completed/rejected outcomes; cleanup requires established ownership.
- API parity: Existing tool names, parameters, binary commands, and diagnostic codes remain unchanged.
- Integration coverage: Real-binary tests cover argument boundaries and wire decoding; adversarial unit tests cover process and filesystem races.
- Unchanged invariants: Atomic replacement preserves permissions and symlink referents; clap parse failures remain outside JSON envelopes; Pi same-file calls remain serialized.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Strict receipt parser rejects future additive fields | Validate required fields and command/file consistency; allow unknown extras |
| Identity retries create a loop | Fixed retry bound and typed unstable result |
| Capability list drifts | Real-schema parity test covers the adapter-required subset |
| Cleanup hardening leaks owned temps on ambiguous identity | Prefer leak over deleting an unowned entry; orphan cleanup remains deferred |
| Visibility policy silently hides commands | Default visible; only explicit false hides; loader tests both sets |
| Wording changes exceed prompt budget | Existing budget test remains a hard gate |

## Disconfirming Evidence

The architecture is rejected if any of these remain true:

- A schema-valid arbitrary object is accepted as mutation success.
- A started nonzero/no-envelope mutation returns ordinary E_MD_COMMAND_FAILED.
- A binary replacing itself during the schema probe executes without reacquisition.
- Same-size/restored-mtime replacement bypasses ordinary identity invalidation.
- A preplanted or substituted staging entry is removed.
- md schema still causes the full Python gate to fail.
- Multi-table selection still receives heading-occurrence advice.
- Documentation still promises cross-process CAS or exact executable binding.

## Bug-Trace / Confidence Cross-Check

| Finding | Contract clause | Unit | Match |
|---|---|---|---|
| 262/263 benchmark suite | Full inventory ≠ prompt-visible subset | U4 | Yes |
| Started mutation reported failed-clean | Started + no authority = indeterminate | U1 | Yes |
| expectEtag option injection | Opaque values use --flag=value | U1 | Yes |
| Probe/execution identity seams | Observed context with checkpoints | U2 | Yes, with final race explicit |
| Foreign temp cleanup | Cleanup requires retained ownership | U3 | Yes |
| Wrong-domain selector hint | Call-site/domain-owned remediation | U5 | Yes |
| Etag guard is not CAS | Scope claims to same-invocation checking | U6 | Yes, mechanism deferred |
| Schema-valid junk and telemetry drift | Typed mutation outcome and receipt decoder | U1 | Yes |
| Handshake capability undercount | Required subset covers registered-tool behavior | U2 | Yes |
