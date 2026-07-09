# Pi Tool Distill

Recoverable semantic compression for large Pi tool results.

V0 intercepts `tool_result`, saves the raw text under your Pi agent directory, runs a safe code-only reducer/cache layer, asks a configured fast model to produce a compact observation card when needed, validates the card, and gives the main model a `distill_expand` handle for raw recovery.

## Safety model

- Raw output is canonical. The card is a lossy view.
- No card is returned unless raw output was saved first.
- `read`, `edit`, `write`, `distill_expand`, image-containing results, and diff-like output pass through by default.
- Auth/model/cache/validation failures preserve the original tool result or fall through to the next trusted stage.
- Safe reducers are deterministic and raw-backed: normalized duplicate and append-only repeat cards point at the current raw artifact and, when relevant, the previous raw artifact that proves the reduction.
- Semantic cache hits reuse only previously validated summaries with the same raw hash, tool/input/question prompt signature, model, and summary settings; cache-hit cards are rebuilt with the current raw artifact id.
- The extension does not register a `context` hook, rewrite old messages, or mutate already-sent cards.
- Raw artifacts may contain secrets; `/distill recent` shows metadata only, not raw content.
- Durable usage stats are written as closed sidecar JSONL records containing only numeric counters, bounded enums, generated ids, and hashes. The stats store rejects unknown fields at runtime so raw text, summaries, input previews, cwd paths, and free-form errors cannot be persisted by usage accounting.

## Commands

```text
/distill help
/distill status
/distill mode off|auto|force
/distill model
/distill model <provider>/<modelId>
/distill threshold <chars>
/distill policy list
/distill policy set <tool> pass|semantic|deny
/distill recent
/distill selftest
/distill stats [--project|--global] [--since 30d] [--activation] [--include-backfill] [--json]
/distill stats backfill [--dry-run] [--global]
/distill reset
```

`/distill model` opens an interactive picker for authenticated text models. You can also set the model directly.

Example with a fast OAuth-backed Codex model:

```text
/distill model openai-codex/gpt-5.3-spark
/distill mode auto
```

`auto` distills eligible large outputs above the threshold. `force` distills eligible non-exact outputs even below the threshold. Exactness-sensitive tools still pass unless explicitly configured with a semantic policy.

Run `/distill selftest` after configuring a model to exercise the live auth/model path with synthetic large output. It writes a raw artifact, asks the configured distiller for a card, validates the card, expands the raw tail, and reports PASS/FAIL with the artifact id.

`/distill status` includes session counters for reducer hits, semantic model calls, semantic cache hits/misses/stale/invalid/error states, fallback, expansion, and byte totals.

When tool-distill fires, the footer status updates with a compact path indicator and estimated main-context token delta:

```text
distill ◆ −9.4k  model path
distill ◇ −2.1k  code reducer
distill ↻ −9.4k  semantic cache
distill ! raw    fallback
distill ↗ raw    expand
```

`/distill stats` consolidates durable usage across sessions. Project scope filters by the hashed current cwd; global scope folds all cwd hashes. Live tracked stats are reported separately from historical backfill estimates. Backfill scans existing artifact metadata across all cwd hashes, deduplicates against live records, excludes selftests, and renders unknowable historical expansion/distiller-spend counters as `unknown` rather than `0`.

## Global promotion

Pi auto-discovers project-local extensions from `.pi/extensions/` and global extensions from `~/.pi/agent/extensions/`. If you manually promote this checkout with `rsync` or a copy into `~/.pi/agent/extensions/tool-distill/`, later project-local edits are not linked automatically; re-promote after changing this source and run `/reload` in existing Pi sessions.

The extension also includes a process-local singleton guard, so a promoted global copy and this project-local copy do not both register `/distill` and `distill_expand` in the same Pi process.

## Model tool

The extension registers:

```text
distill_expand({ id, mode?: "summary" | "raw" | "head" | "tail", maxChars?: number })
```

Use it when an observation card may have omitted details needed for correctness.

## Development

```bash
npm install
npm run typecheck
npm test
npm run smoke-test
npm run e2e:stats
npm run check
```

## Transcript eval harness

Local Pi session transcripts can be mined into replayable fixtures to compare raw context, truncation, head/tail reduction, and Spark distillation:

```bash
npm run eval:scan
npm run eval:run -- --sample 50
npm run eval:run -- --live --model openai-codex/gpt-5.3-codex-spark --sample 50
npm run eval:report
npm run eval:synthetic
```

Defaults:

- Sessions root: `~/.pi/agent/sessions`
- Eval output: `reports/evals/tool-distill/` under this extension
- Offline runs never call a model; `distill-spark` is skipped unless a fixture has a cached summary.
- Live runs require explicit `--live --model provider/modelId` and use configured Pi auth.
- Eval reports include byte/token savings, latency, fallback/skipped counts, required-fact retention, and expansion-needed rate.
- `eval:synthetic` runs deterministic production-runtime cases with mocked model calls: exact duplicate semantic cache reuse, append-only reducer, and same-raw/different-question cache miss. It reports compression, model calls skipped, cache/reducer hits, retention, and expansion-needed rate without live models.

`reports/` is gitignored because fixtures copy raw transcript tool output and may contain secrets.

## Testability

Offline checks are deterministic and do not call live models:

- `npm run typecheck` validates strict TypeScript.
- `npm test` covers config normalization, command mutation, artifact persistence, policy decisions, safe reducers, semantic cache behavior, durable stats schema/store/backfill, synthetic eval metrics, fallback paths, and mocked self-test recovery.
- `npm run smoke-test` loads the extension through the real Pi CLI and runs `/distill help`, `/distill status`, and `/distill policy list`.
- `npm run e2e:stats` runs an isolated Pi CLI smoke test with a temporary `PI_CODING_AGENT_DIR`, verifies stats persistence through side files/query seams, and asserts the real global settings file is untouched.

Authenticated live coverage is opt-in:

```text
/distill model openai-codex/gpt-5.3-spark
/distill selftest
```

Default `npm run check` intentionally does not run `/distill selftest`, because it requires configured model auth and may spend live model tokens.

## V0 scope

V0 does not rewrite shell commands, prune historical prompt context, register a `context` hook, learn from expansion feedback, or fine-tune a model. Those belong to later work.
