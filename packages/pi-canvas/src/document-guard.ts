// Sandbox guard for model-authored display content (plan U5).
//
// `design-variant` and `html-embed` widgets carry HTML the model wrote. It is
// display-only and rendered in a sandboxed, token-free iframe, but we still keep
// it self-contained: no external references (which would defeat the CSP and phone
// home), bounded size. Blocking findings stop the content from rendering; warn
// findings are advisory (surfaced, not fatal). The wrapper stamps each document
// with the reserved strict CSP so a `file://` export carries its own policy too.

import { HTML_IFRAME_STRICT_CSP } from "./html-iframe-bridge.js";

export interface DocumentGuardFinding {
  code: string;
  severity: "block" | "warn";
  message: string;
}

export interface DocumentGuardResult {
  ok: boolean;
  findings: DocumentGuardFinding[];
}

const MAX_DOCUMENT_BYTES = 200_000;

const EXTERNAL_CHECKS: { re: RegExp; code: string; message: string }[] = [
  { re: /<script[^>]*\bsrc\s*=/i, code: "external-script", message: "external <script src> is not allowed" },
  { re: /<link[^>]*\brel\s*=\s*["']?stylesheet/i, code: "external-stylesheet", message: "external stylesheet <link> is not allowed" },
  { re: /@import\b/i, code: "css-import", message: "@import is not allowed" },
  { re: /\b(?:src|href)\s*=\s*["']?https?:\/\//i, code: "external-ref", message: "external http(s) reference is not allowed" },
  { re: /url\(\s*["']?https?:\/\//i, code: "external-url", message: "external url() reference is not allowed" },
];

/** Validate self-containment of variant / embed content. Blocking findings ⇒ do not render. */
export function guardDocumentHtml(html: string): DocumentGuardResult {
  const findings: DocumentGuardFinding[] = [];
  if (html.length > MAX_DOCUMENT_BYTES) {
    findings.push({ code: "too-large", severity: "block", message: `content exceeds ${MAX_DOCUMENT_BYTES} bytes` });
  }
  for (const check of EXTERNAL_CHECKS) {
    if (check.re.test(html)) findings.push({ code: check.code, severity: "block", message: check.message });
  }
  if (!/prefers-color-scheme|data-theme|--pc-/.test(html)) {
    findings.push({ code: "no-dark-theme", severity: "warn", message: "content does not adapt to dark mode" });
  }
  return { ok: findings.every((finding) => finding.severity !== "block"), findings };
}

function escapeDocText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Wrap guarded content in a self-contained document that carries the strict CSP. */
export function wrapSandboxedDocument(html: string, title: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${HTML_IFRAME_STRICT_CSP}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeDocText(title)}</title></head><body>${html}</body></html>`
  );
}
