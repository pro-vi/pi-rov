# ADR 0003: The md binary owns the contract; the adapter is a projection

- **Status:** Accepted
- **Date:** 2026-07-17
- **Deciders:** Provi, Claude build session (representation-integrity audit + external plan review)
- **Supersedes:** the TS-side implementation strategy of ADR 0002 (the envelope shape and recovery codes it defined stay)

## Context

ADR 0002's recovery layer was built entirely in TypeScript: a second heading
matcher (`toLocaleLowerCase` vs Rust's matcher), error classification by exit
code plus stderr substring sniffing, and a synthetic heading-block etag guard
for `md_replace_section`. A representation-integrity audit found these were
not passive mirrors but independent decision-makers that could disagree with
the binary: divergent occurrence counting could land mutations on the wrong
section, exit code 4 was always reported as etag drift even when it meant
duplicate headings, and the `schema_version` token was never validated. The
seams had no equivalence guards, so every md change could silently fork the
contract.

## Decision

Extend ADR 0001's rule from parsing to everything: the `md` binary owns
matching, ambiguity, error taxonomy, and drift guards. md emits a structured
JSON error envelope (serialized DiagnosticCode, hint, role,
requested/total/match context) under `--json`, describes itself via
`md schema --json` (commands, flags, kinds, diagnostics, capabilities,
binary_version), and enforces `--expect-etag` in-process — including
fail-closed `etag_ambiguous` when identical duplicates share a fingerprint.
The adapter deletes its matcher and sniffing, decodes the envelope through an
exported total mapping, validates `schema_version` on every payload,
handshakes once per session (`current` requires version AND required
capabilities), and treats candidates as pure projections of md listings.
Cross-repo parity tests drive the real binary; a grep-gate test bans
case-folding from the runtime.

## Rationale

The rejected alternative — keeping the TS recovery layer and fencing it with
parity tests — guards the drift instead of removing it: every new md
diagnostic or message tweak would need a synchronized TS change forever, and
the wrong-occurrence bug class survives any test gap. Structured errors and
the schema dump also serve every other md consumer (bench policy, direct
bash agents, a future MCP adapter) for free, which is why the Rust surface
carries `hint` in the envelope rather than assuming a typed adapter will
translate.

## Consequences

Positive:

- The adapter can no longer disagree with the binary about what matched or
  why something failed; wrong-target and wrong-recovery classes are removed
  structurally, not fenced.
- One diagnostic taxonomy end-to-end; adapter codes partition cleanly into
  binary-owned semantics and transport-only codes (missing binary, JSON
  parse, abort, version-unsupported).
- Legacy binaries degrade explicitly (handshake verdict + upgrade guidance)
  instead of receiving fabricated etag stories.
- Mutation aborts are contractually indeterminate (atomic writes: old-or-new,
  never partial; re-read before retry).

Negative:

- mdtools carries adapter-serving surface (envelope, schema dump) that must
  stay additive within `mdtools.v1`.
- Rust must ship before the TS that depends on new capabilities; the
  handshake makes partial deploys safe but adds one probe per session.
- Failure-candidate enrichment costs an extra md read on not-found/bad-loc
  paths.

## Revisit Triggers

- A needed recovery affordance cannot be expressed as a projection of md
  output (would force decision logic back into TS).
- `mdtools.v2` schema work begins (envelope and capability negotiation must
  be re-designed together).
- Usage data shows the per-session handshake or enrichment reads are a
  measurable latency problem in real sessions.

## References

- Plan: `docs/plans/2026-07-17-001-feat-binary-owned-contract-plan.md`
- mdtools commits: c479494 (envelope), 222ce84 (schema), 092ccdd (etag
  ambiguity + atomic writes), 46be4ec (loc vocabulary)
- pi-mdtools commits: 1745398 (decoder), 6c75b7e (usage sidecar), 55f35e2
  (parity + packaging), 002277e (gate polish)
- Parity suite: `test/integration.parity.test.ts` (MD_BINARY opt-in)
