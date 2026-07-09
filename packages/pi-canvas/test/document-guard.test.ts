import assert from "node:assert/strict";
import { test } from "node:test";
import { guardDocumentHtml, wrapSandboxedDocument } from "../src/document-guard.js";

test("guardDocumentHtml blocks every external reference form", () => {
  assert.equal(guardDocumentHtml('<script src="https://evil.example/x.js"></script>').ok, false);
  assert.equal(guardDocumentHtml('<link rel="stylesheet" href="https://cdn.example/x.css">').ok, false);
  assert.equal(guardDocumentHtml("<style>@import url(other.css);</style>").ok, false);
  assert.equal(guardDocumentHtml('<img src="https://tracker.example/pixel.png">').ok, false);
  assert.equal(guardDocumentHtml("<style>body{background:url(https://x.example/y.png)}</style>").ok, false);
});

test("guardDocumentHtml accepts self-contained content", () => {
  const clean =
    '<style>@media (prefers-color-scheme: dark){body{background:#000}}</style><h1>Hi</h1><img src="data:image/png;base64,AAAA">';
  const result = guardDocumentHtml(clean);
  assert.equal(result.ok, true);
  assert.equal(result.findings.filter((f) => f.severity === "block").length, 0);
});

test("guardDocumentHtml warns (but does not block) on content with no dark-theme handling", () => {
  const result = guardDocumentHtml("<h1>plain light-only content</h1>");
  assert.equal(result.ok, true);
  assert.ok(result.findings.some((f) => f.code === "no-dark-theme" && f.severity === "warn"));
});

test("wrapSandboxedDocument stamps the strict CSP and keeps the content", () => {
  const doc = wrapSandboxedDocument("<h1>variant</h1>", "Title");
  assert.match(doc, /Content-Security-Policy/);
  assert.match(doc, /connect-src 'none'/);
  assert.match(doc, /<h1>variant<\/h1>/);
});
