// The `builtin.canvas` renderer (ADR 0003, plan U4).
//
// One composable renderer over an ordered list of trusted, Pi-owned widgets.
// Satisfies the existing BrowserArtifactRenderer contract, so it registers,
// reduces, and reports through the same store / host / receipt / readiness spine
// as any browser renderer — the constraint being that reduceAction returns a
// single `set` transition, so each browser action mutates exactly one
// `components.<id>` (or `form.submitted`).
//
// The browser client updates optimistically for instant feedback, then reconciles
// against the committed canonical state returned by the action. The DOM is a
// reactive projection; Pi owns the truth. Widgets with a previewKind apply the
// chosen value to a local demo element with no round-trip.

import { designTokensCss } from "./design-system.js";
import { guardDocumentHtml, wrapSandboxedDocument } from "./document-guard.js";
import type {
  BrowserArtifactPlaybook,
  BrowserArtifactRenderer,
  BrowserArtifactStateSummary,
  BrowserHostBootstrap,
  BrowserRendererHandoffCheck,
  BrowserRendererTransition,
} from "./browser-renderer.js";
import { isJsonObject } from "./json.js";
import type { CanvasReadback, CreateCanvasRequest, JsonObject } from "./types.js";
import {
  buildFormReadback,
  emptyWidgetState,
  parseFormAction,
  parseFormState,
  reduceWidget,
  requiredRemaining,
  widgetStateToJson,
} from "./widgets/reducers.js";
import {
  assertValidFormDefinition,
  buildFormActions,
  buildFormActionSchema,
  buildFormInitialState,
  buildFormStateSchema,
  readFormDefinition,
} from "./widgets/schema.js";
import {
  CANVAS_BROWSER_RENDERER_ID,
  CANVAS_BROWSER_RENDERER_VERSION,
  type FormDefinition,
  type FormReadback,
} from "./widgets/types.js";

// Encode a JSON string for embedding in a <script type="application/json"> block.
// Character references are NOT decoded inside a script element, so HTML-escaping the
// JSON (turning " into &quot;) would corrupt it; only the </ sequence can break the
// script context, so escape just that. Quotes and < stay intact for JSON.parse.
function escapeScriptJson(value: string): string {
  return value.replaceAll("</", "<\\/");
}

function formDefinitionOf(readback: CanvasReadback): FormDefinition {
  const view = readback.source.view;
  const props = view && "props" in view && isJsonObject(view.props) ? view.props : undefined;
  return readFormDefinition(props);
}

// Transform the form definition for the client: variant/embed HTML is guarded for
// self-containment and wrapped as a sandboxed srcdoc. No token ever enters this
// content — the selection about it is a trusted parent widget.
function toClientFormDefinition(def: FormDefinition): JsonObject {
  return {
    requireSubmit: def.requireSubmit === true,
    components: def.components.map((d): JsonObject => {
      const base: JsonObject = { id: d.id, kind: d.kind, prompt: d.prompt, required: d.required === true };
      if (d.allowUnsure === false) base.allowUnsure = false;
      if (d.allowNote) base.allowNote = true;
      if (d.previewKind) base.previewKind = d.previewKind;
      if (typeof d.max === "number") base.max = d.max;
      if (d.placeholder) base.placeholder = d.placeholder;
      if (d.kind === "html-embed") {
        const content = d.html ?? "";
        const guard = guardDocumentHtml(content);
        base.blocked = !guard.ok;
        base.srcdoc = guard.ok ? wrapSandboxedDocument(content, d.prompt) : "";
      }
      if (d.options) {
        base.options = d.options.map((o): JsonObject => {
          const opt: JsonObject = { id: o.id, title: o.title };
          if (o.detail) opt.detail = o.detail;
          if (o.take) opt.take = o.take;
          if (o.previewValue !== undefined) opt.previewValue = o.previewValue;
          if (d.kind === "design-variant" && typeof o.html === "string") {
            const guard = guardDocumentHtml(o.html);
            opt.blocked = !guard.ok;
            opt.srcdoc = guard.ok ? wrapSandboxedDocument(o.html, o.title) : "";
          }
          return opt;
        });
      }
      return base;
    }),
  };
}

function formReadbackToJson(rb: FormReadback): JsonObject {
  return {
    submitted: rb.submitted,
    rollup: {
      total: rb.rollup.total,
      answered: rb.rollup.answered,
      blank: rb.rollup.blank,
      skipped: rb.rollup.skipped,
      requiredRemaining: [...rb.rollup.requiredRemaining],
    },
    components: rb.components.map((c) => ({
      id: c.id,
      kind: c.kind,
      prompt: c.prompt,
      required: c.required,
      status: c.status,
      confirmed: c.confirmed,
      affirmed: [...c.affirmed],
      negated: [...c.negated],
      blank: [...c.blank],
      value: c.value,
      unsure: c.unsure,
      note: c.note,
    })),
  };
}

const FORM_STYLES = `${designTokensCss()}
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--pc-bg); color: var(--pc-text); }
    .wrap { max-width: 920px; margin: 0 auto; padding: 28px 22px 64px; }
    h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
    .sub { color: var(--pc-text-muted); font-size: 13px; margin: 0 0 20px; }
    .fc { display: grid; gap: 14px; }
    .w { background: var(--pc-surface); border: 1px solid var(--pc-border); border-radius: 10px; padding: 16px 18px; }
    .w-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px; }
    .w-q { font-weight: 600; font-size: 14px; display: flex; gap: 8px; align-items: center; }
    .req { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; color: var(--pc-warn); border: 1px solid var(--pc-warn); border-radius: 4px; padding: 1px 5px; }
    .chip { font-size: 11px; font-weight: 600; border-radius: 999px; padding: 2px 9px; }
    .chip.answered { color: var(--pc-accent); background: var(--pc-accent-weak); }
    .chip.unsure { color: var(--pc-warn); background: var(--pc-accent-weak); }
    .chip.skipped { color: var(--pc-text-muted); background: var(--pc-surface-2); }
    .chip.untouched { color: var(--pc-text-faint); background: var(--pc-surface-2); }
    .opts { display: grid; gap: 7px; }
    .opt { display: flex; gap: 10px; align-items: center; border: 1px solid var(--pc-border); background: var(--pc-surface-2); border-radius: 6px; padding: 8px 11px; font-size: 13px; cursor: pointer; color: inherit; text-align: left; width: 100%; }
    .opt .mark { width: 17px; height: 17px; border-radius: 5px; border: 1.5px solid var(--pc-border-strong); display: grid; place-items: center; font-size: 11px; color: transparent; flex-shrink: 0; }
    .opt.radio .mark { border-radius: 50%; }
    .opt.affirm { border-color: var(--pc-accent); background: var(--pc-accent-weak); }
    .opt.affirm .mark { background: var(--pc-accent); border-color: var(--pc-accent); color: var(--pc-on-accent); }
    .opt.negate { color: var(--pc-text-muted); }
    .opt.negate .mark { border-color: var(--pc-text-muted); color: var(--pc-text-muted); }
    .opt.negate .lbl { text-decoration: line-through; opacity: 0.7; }
    .opt .lbl { flex: 1; }
    .opt .dt { font-size: 11px; color: var(--pc-text-faint); }
    .dots { display: flex; gap: 6px; align-items: center; }
    .dot { width: 22px; height: 22px; border-radius: 50%; border: 1.5px solid var(--pc-border-strong); background: transparent; cursor: pointer; padding: 0; }
    .dot.on { background: var(--pc-accent); border-color: var(--pc-accent); }
    .rv { font-size: 12px; color: var(--pc-text-muted); margin-left: 6px; font-variant-numeric: tabular-nums; }
    .field { width: 100%; border: 1px solid var(--pc-border-strong); background: var(--pc-surface-2); border-radius: 6px; padding: 9px 11px; font: inherit; color: var(--pc-text); }
    .ctls { display: flex; gap: 8px; margin-top: 11px; flex-wrap: wrap; }
    .ctl { font-size: 11.5px; border: 1px solid var(--pc-border-strong); background: var(--pc-surface); color: var(--pc-text-muted); border-radius: 999px; padding: 4px 11px; font-weight: 600; cursor: pointer; }
    .ctl.on { color: var(--pc-warn); border-color: var(--pc-warn); }
    .note-l { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--pc-text-faint); font-weight: 700; margin: 10px 0 4px; }
    .embed { border: 1px dashed var(--pc-border-strong); border-radius: 6px; background: var(--pc-surface-2); padding: 12px; font-size: 12px; color: var(--pc-text-muted); }
    .preview { margin-top: 10px; }
    .track { position: relative; height: 30px; border: 1px solid var(--pc-border); border-radius: 999px; background: var(--pc-surface-2); overflow: hidden; }
    .puck { position: absolute; top: 5px; left: 5px; width: 18px; height: 18px; border-radius: 50%; background: var(--pc-accent); }
    .swatch { height: 34px; border-radius: 6px; border: 1px solid var(--pc-border); }
    .variants { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .variant { border: 1px solid var(--pc-border); border-radius: 6px; overflow: hidden; background: var(--pc-surface-2); cursor: pointer; padding: 0; text-align: left; }
    .variant.picked { border-color: var(--pc-accent); box-shadow: 0 0 0 2px var(--pc-accent-weak); }
    .thumb { height: 120px; border-bottom: 1px solid var(--pc-border); overflow: hidden; background: #fff; }
    .vframe { width: 100%; height: 100%; border: 0; pointer-events: none; }
    .vmeta { padding: 8px 10px; }
    .vname { font-size: 12px; font-weight: 650; display: block; }
    .pick { color: var(--pc-accent); }
    .vtake { font-size: 11px; color: var(--pc-text-muted); }
    .eframe { width: 100%; height: 200px; border: 1px solid var(--pc-border); border-radius: 6px; background: #fff; }
    .handoff { margin-top: 16px; display: flex; justify-content: space-between; align-items: center; gap: 12px; background: var(--pc-surface); border: 1px solid var(--pc-border); border-radius: 9px; padding: 12px 15px; flex-wrap: wrap; }
    .hstatus { font-size: 13px; font-weight: 600; display: flex; gap: 8px; align-items: center; }
    .hdot { width: 9px; height: 9px; border-radius: 50%; }
    .rollup { font: 12px var(--pc-font-mono); color: var(--pc-text-faint); }
    .submit { border: none; border-radius: 6px; padding: 9px 16px; font-size: 13px; font-weight: 650; background: var(--pc-accent); color: var(--pc-on-accent); cursor: pointer; }
    .submit:disabled { background: var(--pc-surface-2); color: var(--pc-text-faint); border: 1px solid var(--pc-border); cursor: not-allowed; }
    @media (max-width: 620px) { .handoff { flex-direction: column; align-items: stretch; } }`;

function renderFormHtml(readback: CanvasReadback, bootstrap: BrowserHostBootstrap): string {
  const formDef = formDefinitionOf(readback);
  const bootstrapJson = escapeScriptJson(JSON.stringify({ ...bootstrap, title: readback.source.title }));
  const formDefJson = escapeScriptJson(JSON.stringify(toClientFormDefinition(formDef)));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pi Canvas Form</title>
  <style>
    ${FORM_STYLES}
  </style>
</head>
<body>
  <main class="wrap"><div id="app" data-testid="composable-form"></div></main>
  <script type="application/json" id="pi-host-bootstrap">${bootstrapJson}</script>
  <script type="application/json" id="pi-form-def">${formDefJson}</script>
  <script>
    const bootstrap = JSON.parse(document.querySelector("#pi-host-bootstrap").textContent);
    const formDef = JSON.parse(document.querySelector("#pi-form-def").textContent);
    const app = document.querySelector("#app");
    let state = bootstrap.state;
    let stateVersion = bootstrap.stateVersion;
    let actionInFlight = false;
    let lastPreview = null;

    function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
    function defById(cid) { return formDef.components.find(function (d) { return d.id === cid; }); }
    function compState(cid) { return (state && state.components && state.components[cid]) || { selections: {}, value: null, unsure: false, skipped: false, note: null }; }
    function statusOf(c) {
      if (c.skipped) return "skipped";
      if (c.unsure) return "unsure";
      var answered = (c.value != null && (typeof c.value !== "string" || c.value.trim().length > 0)) || Object.keys(c.selections || {}).some(function (k) { return c.selections[k] === "affirm" || c.selections[k] === "negate"; });
      return answered ? "answered" : "untouched";
    }
    function requiredRemaining() {
      return formDef.components.filter(function (d) { return d.required && ["answered", "unsure"].indexOf(statusOf(compState(d.id))) < 0; }).map(function (d) { return d.id; });
    }

    function optRow(d, opt) {
      var c = compState(d.id);
      var ans = (c.selections || {})[opt.id];
      var single = d.kind === "single-select" || d.kind === "design-variant";
      var cls = "opt" + (single ? " radio" : "") + (ans === "affirm" ? " affirm" : ans === "negate" ? " negate" : "");
      var mark = ans === "affirm" ? "✓" : ans === "negate" ? "–" : "";
      var detail = opt.take ? '<span class="dt">' + esc(opt.take) + "</span>" : opt.detail ? '<span class="dt">' + esc(opt.detail) + "</span>" : "";
      return '<button type="button" class="' + cls + '" data-cid="' + esc(d.id) + '" data-oid="' + esc(opt.id) + '" data-testid="opt-' + esc(d.id) + "-" + esc(opt.id) + '"><span class="mark">' + mark + '</span><span class="lbl">' + esc(opt.title || opt.id) + "</span>" + detail + "</button>";
    }

    function widgetBody(d) {
      var c = compState(d.id);
      if (d.kind === "rating") {
        var max = d.max && d.max > 0 ? d.max : 5;
        var dots = "";
        for (var i = 1; i <= max; i++) dots += '<button type="button" class="dot' + (c.value != null && i <= c.value ? " on" : "") + '" data-cid="' + esc(d.id) + '" data-dot="' + i + '" aria-label="' + i + '"></button>';
        return '<div class="dots">' + dots + '<span class="rv" data-rv="' + esc(d.id) + '">' + (c.value == null ? "—" : c.value + " / " + max) + "</span></div>";
      }
      if (d.kind === "short-text") {
        return '<input class="field" data-cid="' + esc(d.id) + '" data-text="1" placeholder="' + esc(d.placeholder || "") + '" value="' + esc(c.value || "") + '">';
      }
      if (d.kind === "html-embed") {
        return d.blocked ? '<div class="embed">embedded content blocked — external references are not allowed</div>' : '<iframe class="eframe" sandbox="allow-scripts" data-testid="embed-' + esc(d.id) + '" srcdoc="' + esc(d.srcdoc || "") + '"></iframe>';
      }
      if (d.kind === "design-variant") {
        var vs = (d.options || []).map(function (o) {
          var cc = compState(d.id); var picked = (cc.selections || {})[o.id] === "affirm";
          var frame = o.blocked ? '<div class="embed">variant blocked — external references</div>' : '<iframe class="vframe" sandbox="allow-scripts" srcdoc="' + esc(o.srcdoc || "") + '"></iframe>';
          return '<button type="button" class="variant' + (picked ? " picked" : "") + '" data-cid="' + esc(d.id) + '" data-oid="' + esc(o.id) + '" data-testid="opt-' + esc(d.id) + "-" + esc(o.id) + '"><div class="thumb">' + frame + '</div><div class="vmeta"><span class="vname">' + esc(o.title) + ' <span class="pick" style="display:' + (picked ? "inline" : "none") + '">✓</span></span><span class="vtake">' + esc(o.take || "") + "</span></div></button>";
        }).join("");
        return '<div class="variants">' + vs + "</div>";
      }
      var opts = (d.options || []).map(function (o) { return optRow(d, o); }).join("");
      var body = '<div class="opts">' + opts + "</div>";
      if (d.previewKind) body += '<div class="preview" data-preview="' + esc(d.id) + '">' + previewSlot(d) + "</div>";
      return body;
    }

    function previewSlot(d) {
      if (d.previewKind === "motion") return '<div class="track"><div class="puck" data-puck="' + esc(d.id) + '"></div></div>';
      if (d.previewKind === "swatch") return '<div class="swatch" data-sample="' + esc(d.id) + '"></div>';
      return '<div class="swatch" data-sample="' + esc(d.id) + '" style="height:22px"></div>';
    }

    function controls(d) {
      var c = compState(d.id);
      var out = [];
      if (d.allowUnsure !== false) out.push('<button type="button" class="ctl' + (c.unsure ? " on" : "") + '" data-cid="' + esc(d.id) + '" data-op="unsure" data-testid="unsure-' + esc(d.id) + '">' + (c.unsure ? "● not sure" : "not sure") + "</button>");
      if (!d.required) out.push('<button type="button" class="ctl' + (c.skipped ? " on" : "") + '" data-cid="' + esc(d.id) + '" data-op="skip" data-testid="skip-' + esc(d.id) + '">' + (c.skipped ? "skipped ✓" : "skip this") + "</button>");
      if (!out.length) return "";
      return '<div class="ctls">' + out.join("") + "</div>";
    }

    function noteField(d) {
      if (!d.allowNote) return "";
      var c = compState(d.id);
      return '<div class="note-l">note (optional)</div><input class="field" data-cid="' + esc(d.id) + '" data-note="1" placeholder="Add a justification…" value="' + esc(c.note || "") + '">';
    }

    // Build the DOM structure ONCE. State changes are patched in place by syncState
    // so the design-variant/html-embed iframes are never recreated (recreating an
    // iframe reloads it — the white flash).
    function render() {
      var cards = formDef.components.map(function (d) {
        var c = compState(d.id);
        var st = statusOf(c);
        var req = d.required ? '<span class="req">Required</span>' : "";
        return '<div class="w" data-cid="' + esc(d.id) + '"><div class="w-head"><span class="w-q">' + req + esc(d.prompt) + '</span><span class="chip ' + st + '" data-chip="' + esc(d.id) + '">' + st + "</span></div>" + widgetBody(d) + controls(d) + noteField(d) + "</div>";
      }).join("");
      var handoff = '<div class="handoff"><span class="hstatus" data-testid="handoff"><span class="hdot"></span><span class="htext"></span></span><span style="display:flex;gap:12px;align-items:center"><span class="rollup" data-testid="rollup"></span><button class="submit" type="button" data-op="submit" data-testid="submit">Submit</button></span></div>';
      app.innerHTML = '<h1>' + esc(bootstrap.title || "Form") + '</h1><p class="sub">Answer what you have an opinion on. Skip or mark not sure for the rest — nothing is lost.</p><div class="fc">' + cards + "</div>" + handoff;
    }

    function syncState() {
      formDef.components.forEach(function (d) {
        var c = compState(d.id);
        Array.prototype.forEach.call(app.querySelectorAll('.opt[data-cid="' + d.id + '"][data-oid], .variant[data-cid="' + d.id + '"][data-oid]'), function (btn) {
          var ans = (c.selections || {})[btn.dataset.oid];
          btn.classList.toggle("affirm", ans === "affirm");
          btn.classList.toggle("negate", ans === "negate");
          btn.classList.toggle("picked", ans === "affirm");
          var mark = btn.querySelector(".mark"); if (mark) mark.textContent = ans === "affirm" ? "✓" : ans === "negate" ? "–" : "";
          var pick = btn.querySelector(".pick"); if (pick) pick.style.display = ans === "affirm" ? "inline" : "none";
        });
        var max = d.max && d.max > 0 ? d.max : 5;
        Array.prototype.forEach.call(app.querySelectorAll('.dot[data-cid="' + d.id + '"]'), function (dot) { dot.classList.toggle("on", c.value != null && Number(dot.dataset.dot) <= c.value); });
        var rv = app.querySelector('[data-rv="' + d.id + '"]'); if (rv) rv.textContent = c.value == null ? "—" : c.value + " / " + max;
        var chip = app.querySelector('.chip[data-chip="' + d.id + '"]'); if (chip) { var s = statusOf(c); chip.className = "chip " + s; chip.textContent = s; }
        var uns = app.querySelector('.ctl[data-cid="' + d.id + '"][data-op="unsure"]'); if (uns) { uns.classList.toggle("on", !!c.unsure); uns.textContent = c.unsure ? "● not sure" : "not sure"; }
        var skp = app.querySelector('.ctl[data-cid="' + d.id + '"][data-op="skip"]'); if (skp) { skp.classList.toggle("on", !!c.skipped); skp.textContent = c.skipped ? "skipped ✓" : "skip this"; }
      });
      var rem = requiredRemaining();
      var counts = { answered: 0, blank: 0, skipped: 0 };
      formDef.components.forEach(function (d) { var s = statusOf(compState(d.id)); if (s === "answered" || s === "unsure") counts.answered++; else if (s === "skipped") counts.skipped++; else counts.blank++; });
      var ready = rem.length === 0;
      var submitted = state && state.form && state.form.submitted;
      var hdot = app.querySelector(".hdot"); if (hdot) hdot.style.background = ready ? "var(--pc-accent)" : "var(--pc-warn)";
      var htext = app.querySelector(".htext"); if (htext) { htext.style.color = ready ? "var(--pc-accent)" : "var(--pc-warn)"; htext.textContent = submitted ? "Submitted" : ready ? "Ready for handoff" : "Blocked — required: " + rem.map(esc).join(", "); }
      var rollup = app.querySelector(".rollup"); if (rollup) rollup.textContent = counts.answered + " answered · " + counts.blank + " blank · " + counts.skipped + " skipped";
      var submit = app.querySelector(".submit"); if (submit) { submit.disabled = !(ready && !submitted); submit.textContent = submitted ? "Submitted ✓" : "Submit"; }
      firePreview();
    }

    function firePreview() {
      if (!lastPreview) return;
      var d = defById(lastPreview.cid);
      if (!d) { lastPreview = null; return; }
      var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (d.previewKind === "motion") {
        var puck = app.querySelector('[data-puck="' + lastPreview.cid + '"]');
        if (puck) {
          var ms = typeof lastPreview.value === "number" ? lastPreview.value : 0;
          var end = puck.parentElement.clientWidth - puck.offsetWidth - 10;
          if (reduce) { puck.style.transform = "translateX(" + end + "px)"; }
          else { puck.style.transition = "none"; puck.style.transform = "translateX(0)"; requestAnimationFrame(function () { requestAnimationFrame(function () { puck.style.transition = "transform " + ms + "ms ease"; puck.style.transform = "translateX(" + end + "px)"; }); }); }
        }
      } else {
        var sample = app.querySelector('[data-sample="' + lastPreview.cid + '"]');
        if (sample && lastPreview.value != null) { sample.style.background = String(lastPreview.value); }
      }
      lastPreview = null;
    }

    function optimistic(env) {
      var next = JSON.parse(JSON.stringify(state));
      var c = next.components[env.componentId];
      var d = defById(env.componentId);
      if (env.op === "submit") { next.form.submitted = true; return next; }
      if (!c || !d) return next;
      function clearC() { c.confirmed = false; c.confirmedSignature = null; }
      if (env.op === "affirm" || env.op === "negate") {
        var ans = env.op === "affirm" ? "affirm" : "negate";
        var single = d.kind === "single-select" || d.kind === "design-variant";
        c.selections = single ? {} : Object.assign({}, c.selections);
        c.selections[env.optionId] = ans; c.value = null; c.unsure = false; c.skipped = false; clearC();
      } else if (env.op === "clear") { var s = Object.assign({}, c.selections); delete s[env.optionId]; c.selections = s; clearC(); }
      else if (env.op === "unsure") { c.unsure = !c.unsure; if (c.unsure) { c.selections = {}; c.value = null; c.skipped = false; } clearC(); }
      else if (env.op === "skip") { if (d.required) return next; c.skipped = !c.skipped; if (c.skipped) { c.selections = {}; c.value = null; c.unsure = false; } clearC(); }
      else if (env.op === "note") { c.note = typeof env.note === "string" ? env.note : null; }
      else if (env.op === "value") { c.value = env.value; c.unsure = false; c.skipped = false; c.selections = {}; clearC(); }
      return next;
    }

    async function sendAction(env) {
      if (actionInFlight) return;
      actionInFlight = true;
      var snapshot = state;
      state = optimistic(env);
      syncState();
      try {
        var response = await fetch("/session/" + bootstrap.sessionId + "/action", {
          method: "POST",
          headers: { "content-type": "application/json", "x-pi-canvas-token": bootstrap.token },
          body: JSON.stringify({ artifactId: bootstrap.artifactId, sessionId: bootstrap.sessionId, sourceHash: bootstrap.sourceHash, stateVersion: stateVersion, origin: window.location.origin, action: env })
        });
        var result = await response.json();
        if (!response.ok) { app.dataset.lastError = result.error || "action failed"; state = snapshot; syncState(); return; }
        stateVersion = result.stateVersion;
        state = result.state;
        syncState();
      } catch (err) { state = snapshot; syncState(); }
      finally { actionInFlight = false; }
    }

    app.addEventListener("click", function (event) {
      var opt = event.target.closest ? event.target.closest("[data-oid]") : null;
      if (opt) { var d = defById(opt.dataset.cid); var oid = opt.dataset.oid; var cur = (compState(opt.dataset.cid).selections || {})[oid];
        if (d.kind === "multi-select") { var op = !cur ? "affirm" : cur === "affirm" ? "negate" : "clear"; sendAction({ componentId: opt.dataset.cid, op: op, optionId: oid }); }
        else { if (d.previewKind) { var o = (d.options || []).find(function (x) { return x.id === oid; }); lastPreview = { cid: d.id, value: o && o.previewValue }; } sendAction({ componentId: opt.dataset.cid, op: "affirm", optionId: oid }); }
        return; }
      var dot = event.target.closest ? event.target.closest("[data-dot]") : null;
      if (dot) { sendAction({ componentId: dot.dataset.cid, op: "value", value: Number(dot.dataset.dot) }); return; }
      var ctl = event.target.closest ? event.target.closest("[data-op]") : null;
      if (ctl) { sendAction({ componentId: ctl.dataset.cid, op: ctl.dataset.op }); return; }
    });
    app.addEventListener("change", function (event) {
      var t = event.target;
      if (t && t.dataset && t.dataset.note) sendAction({ componentId: t.dataset.cid, op: "note", note: t.value });
      else if (t && t.dataset && t.dataset.text) sendAction({ componentId: t.dataset.cid, op: "value", value: t.value });
    });

    render();
    syncState();
  </script>
</body>
</html>`;
}

const FORM_PLAYBOOK: BrowserArtifactPlaybook = {
  id: "builtin.canvas",
  title: "Composable form — async visual question channel",
  purpose:
    "Ask the human several questions at once and read back every selection and every silence. This is the one actable canvas substrate; optionChooser and reviewDecision are presets that compose it. Also carries design-variant picks.",
  canonicalState: "Pi owns per-widget answers under components.<id>; the browser DOM is a reactive projection, never the truth.",
  agentAction:
    "canvas_create with a form payload, canvas_present, then canvas_read to get formReadback (affirmed / negated / blank / note per component + required-remaining).",
  useWhen: [
    "You need the human's opinion on multiple related decisions and can accept partial answers.",
    "Design iteration: present real variants and read which the human picked.",
    "You want blank / not-sure / skipped to be meaningful signal, not just missing data.",
  ],
  avoidWhen: [
    "A single yes/no decision — use reviewDecision.",
  ],
  qualityGates: [
    "Only required widgets block handoff; optional blanks never do.",
    "Each design-variant option must declare a one-sentence take.",
    "Variant / embed content is self-contained and sandboxed; no external references.",
  ],
  nextSteps: [
    "canvas_present to open or focus the signed local browser session.",
    "canvas_read for canonical formReadback before acting on the answers.",
  ],
};

export const canvasBrowserRenderer: BrowserArtifactRenderer = {
  id: CANVAS_BROWSER_RENDERER_ID,
  version: CANVAS_BROWSER_RENDERER_VERSION,
  label: "Canvas",
  // Every declared path on a canvas form (components.<id>, form.submitted) is an answer path;
  // the human commits them in the browser. Agent-facing tool/command writes are rejected (ADR 0004
  // trust model). canvas_update stays open for terminal canvases and third-party browser renderers.
  updatePolicy: "browser-only",
  playbook: FORM_PLAYBOOK,
  actionSchema: buildFormActionSchema(),
  defaultActions: [{ type: "set", path: "form.submitted", label: "Submit form" }],
  defaultState: { form: { submitted: false }, components: {} },
  defaultStateSchema: buildFormStateSchema(),
  renderHtml(readback: CanvasReadback, bootstrap: BrowserHostBootstrap): string {
    return renderFormHtml(readback, bootstrap);
  },
  reduceAction(readback: CanvasReadback, action: JsonObject): BrowserRendererTransition {
    const parsed = parseFormAction(action);
    if (!parsed.ok) return { kind: "reject", reason: parsed.reason };
    const envelope = parsed.envelope;
    const def = formDefinitionOf(readback);
    const state = parseFormState(readback.state.state, def);
    if (envelope.op === "submit") {
      const remaining = requiredRemaining(def, state);
      if (remaining.length > 0) {
        return { kind: "reject", reason: `submit blocked: required widgets unanswered: ${remaining.join(", ")}`, rendererActionType: "submit" };
      }
      return { kind: "set", path: "form.submitted", value: true, rendererActionType: "submit" };
    }
    const componentId = envelope.componentId;
    const wdef = componentId ? def.components.find((w) => w.id === componentId) : undefined;
    if (!componentId || !wdef) return { kind: "reject", reason: `unknown component: ${componentId ?? "(none)"}` };
    const current = state.components[componentId] ?? emptyWidgetState(wdef);
    const result = reduceWidget(wdef, current, envelope);
    if (!result.ok) return { kind: "reject", reason: result.reason, rendererActionType: envelope.op };
    return { kind: "set", path: `components.${componentId}`, value: widgetStateToJson(result.next), rendererActionType: envelope.op };
  },
  summarizeState(readback: CanvasReadback): BrowserArtifactStateSummary {
    const def = formDefinitionOf(readback);
    const state = parseFormState(readback.state.state, def);
    const rb = buildFormReadback(def, state);
    const remaining = rb.rollup.requiredRemaining;
    return {
      kind: "form",
      status: remaining.length > 0 ? "pending" : "ready",
      summary: `${rb.rollup.answered}/${rb.rollup.total} answered, ${rb.rollup.blank} blank, ${rb.rollup.skipped} skipped${remaining.length ? `, required-remaining: ${remaining.join(", ")}` : ""}`,
      fields: { formReadback: formReadbackToJson(rb) },
    };
  },
  summarizeHandoff(readback: CanvasReadback): BrowserRendererHandoffCheck | undefined {
    const def = formDefinitionOf(readback);
    const state = parseFormState(readback.state.state, def);
    const remaining = requiredRemaining(def, state);
    if (remaining.length > 0) {
      return { checkId: "form-required", readyForHandoff: false, status: "pending", reason: `Required widgets not yet answered: ${remaining.join(", ")}` };
    }
    if (def.requireSubmit && !state.form.submitted) {
      return { checkId: "form-submit", readyForHandoff: false, status: "pending", reason: "Form has not been submitted." };
    }
    return undefined;
  },
  renderTerminalFallback(readback: CanvasReadback): string[] {
    const def = formDefinitionOf(readback);
    const state = parseFormState(readback.state.state, def);
    const rb = buildFormReadback(def, state);
    const lines = [
      `Form: ${readback.source.title}`,
      `  ${rb.rollup.answered}/${rb.rollup.total} answered · ${rb.rollup.blank} blank · ${rb.rollup.skipped} skipped`,
    ];
    for (const c of rb.components) {
      const detail = c.affirmed.length ? ` -> ${c.affirmed.join(", ")}` : c.unsure ? " -> not sure" : "";
      lines.push(`  [${c.status}] ${c.id}: ${c.prompt}${detail}`);
    }
    if (rb.rollup.requiredRemaining.length) lines.push(`  required-remaining: ${rb.rollup.requiredRemaining.join(", ")}`);
    return lines;
  },
};

/** Build a create request for a composable form from a bounded `form` shorthand payload. */
export function createFormCanvasRequest(artifactId: string | undefined, title: string, form: JsonObject): CreateCanvasRequest {
  const rawComponents = form.components;
  const props: JsonObject = {
    components: Array.isArray(rawComponents) ? rawComponents : [],
    requireSubmit: form.requireSubmit === true,
  };
  const def = readFormDefinition(props);
  assertValidFormDefinition(def);
  return {
    ...(artifactId === undefined ? {} : { artifactId }),
    title,
    initialState: buildFormInitialState(def),
    surfaceKind: "browser",
    viewKind: "browser-host-artifact",
    view: {
      kind: "browser-host-artifact",
      bridgeVersion: 1,
      host: "local-browser-host",
      fallback: "terminal-render",
      transport: "http-json",
      rendererId: CANVAS_BROWSER_RENDERER_ID,
      rendererVersion: CANVAS_BROWSER_RENDERER_VERSION,
      props,
    },
    browserRendererId: CANVAS_BROWSER_RENDERER_ID,
    browserRendererVersion: CANVAS_BROWSER_RENDERER_VERSION,
    stateSchema: buildFormStateSchema(),
    actions: buildFormActions(def),
  };
}
