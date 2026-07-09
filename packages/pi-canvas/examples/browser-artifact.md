# Browser Artifact Demo

This is the shortest blog-ready pi-canvas browser artifact path. It creates one
actable canvas surface (`builtin.canvas`), presents it in a signed local browser
session, and reads the human's answer back as canonical Pi state.

1. The agent calls `canvas_create` with a bounded `optionChooser` preset — a
   canvas single-select shorthand:

   ```json
   {
     "artifactId": "launch-copy",
     "title": "Which launch headline?",
     "optionChooser": {
       "options": [
         { "id": "bold", "title": "Ship the future, today", "detail": "Punchy, imperative." },
         { "id": "plain", "title": "A faster way to build", "detail": "Calm, concrete." }
       ]
     }
   }
   ```

   `optionChooser`, `reviewDecision`, and `form` are all preset shorthands that
   compose the one `builtin.canvas` substrate — there is no separate renderer.

2. `canvas_present` starts or focuses a signed, token-bearing loopback browser
   session and returns its transient local URL plus a `presentationPolicy`. Open
   it locally; do not paste, persist, or share it.

3. The human affirms an option in the browser and submits. The host validates
   token / origin / session / source / version, reduces the declared widget
   action, and commits canonical Pi state — the browser HTML is only a projection.

4. `canvas_read` returns the canonical readback: `formReadback.components[choice]`
   with `affirmed` / `negated` / `blank`, the per-widget `status`, and
   `requiredRemaining`. Handoff blocks only while a required widget is unanswered.

5. `canvas_export` writes a diffable source / state / provenance bundle plus
   `browser-host.evidence.json` (readiness verdict, receipts, layout audit) for a
   reviewable handoff.

The result is an artifact the human acts on and the agent digests as structured
canonical state — never scraped DOM (ADR 0004: actable ⟹ declared).
