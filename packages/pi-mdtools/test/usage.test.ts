import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TOOL_KIND, USAGE_SCHEMA, UsageTracker, hashFileRef, usageLogPath } from "../src/usage.js";
import { MD_TOOL_PROMPTS } from "../src/prompts.js";

test("every registered tool has a static kind", () => {
	for (const tool of Object.keys(MD_TOOL_PROMPTS)) {
		assert.ok(TOOL_KIND[tool] === "query" || TOOL_KIND[tool] === "mutation", `missing kind for ${tool}`);
	}
});

test("requeried fires only for the SAME resolved file, not same basenames", () => {
	const tracker = new UsageTracker();
	const mutation = tracker.buildLine({
		tool: "md_set_task",
		resolvedPath: "/work/notes.md",
		guarded: true,
		ok: true,
		durationMs: 5,
		outputBytes: 100,
	});
	assert.equal(mutation.kind, "mutation");
	assert.equal(mutation.requeried, false);

	const requery = tracker.buildLine({
		tool: "md_tasks",
		resolvedPath: "/work/notes.md",
		guarded: false,
		ok: true,
		durationMs: 3,
		outputBytes: 50,
	});
	assert.equal(requery.requeried, true);

	// same basename, different directory: NOT a re-query (review M9)
	const sameBasenameElsewhere = tracker.buildLine({
		tool: "md_tasks",
		resolvedPath: "/elsewhere/notes.md",
		guarded: false,
		ok: true,
		durationMs: 3,
		outputBytes: 50,
	});
	assert.equal(sameBasenameElsewhere.requeried, false);

	const otherFile = tracker.buildLine({
		tool: "md_tasks",
		resolvedPath: "/work/other.md",
		guarded: false,
		ok: true,
		durationMs: 3,
		outputBytes: 50,
	});
	assert.equal(otherFile.requeried, false);
});

test("failed mutations do not mark the file as mutated", () => {
	const tracker = new UsageTracker();
	tracker.buildLine({
		tool: "md_replace_section",
		resolvedPath: "/work/doc.md",
		guarded: true,
		ok: false,
		errorCode: "E_ETAG_MISMATCH",
		durationMs: 5,
		outputBytes: 80,
	});
	const query = tracker.buildLine({
		tool: "md_outline",
		resolvedPath: "/work/doc.md",
		guarded: false,
		ok: true,
		durationMs: 2,
		outputBytes: 40,
	});
	assert.equal(query.requeried, false);
});

test("lines carry no paths or content: file is an 8-char basename hash", () => {
	const tracker = new UsageTracker();
	const line = tracker.buildLine({
		tool: "md_section",
		resolvedPath: "/very/secret/path/Design Notes.md",
		guarded: false,
		ok: true,
		durationMs: 1,
		outputBytes: 10,
	});
	const serialized = JSON.stringify(line);
	assert.ok(!serialized.includes("/very/secret"), "no directory components");
	assert.ok(!serialized.includes("Design Notes"), "no basename plaintext");
	assert.match(line.fileHash ?? "", /^[0-9a-f]{8}$/);
	assert.equal(line.schema, USAGE_SCHEMA);
	assert.match(line.session, /^[0-9a-f-]{36}$/);
	assert.equal(hashFileRef("/very/secret/path/Design Notes.md"), line.fileHash);
	// distinct directories, same basename -> distinct hashes
	assert.notEqual(hashFileRef("/a/Design Notes.md"), line.fileHash);
});

test("kill switch disables the sink; explicit path wins", async () => {
	assert.equal(usageLogPath({ PI_MDTOOLS_USAGE_LOG: "" }), undefined);
	assert.equal(usageLogPath({ PI_MDTOOLS_USAGE_LOG: "/tmp/x.jsonl" }), "/tmp/x.jsonl");
	assert.ok(usageLogPath({})?.endsWith(".local/share/pi-mdtools/usage.jsonl"));
});

test("record appends parseable JSONL to the configured sink", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mdtools-usage-"));
	const sink = join(dir, "usage.jsonl");
	const tracker = new UsageTracker();
	const line = tracker.buildLine({
		tool: "md_tasks",
		resolvedPath: "/work/doc.md",
		guarded: false,
		ok: true,
		durationMs: 2,
		outputBytes: 42,
	});
	tracker.record(line, { PI_MDTOOLS_USAGE_LOG: sink });
	// record is fire-and-forget; give the write a beat
	await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
	const contents = await readFile(sink, "utf8");
	const parsed = JSON.parse(contents.trim());
	assert.equal(parsed.tool, "md_tasks");
	assert.equal(parsed.schema, USAGE_SCHEMA);
});

test("prompt budget: deduped snippet+guideline cost stays under the cap", () => {
	// pi dedupes promptGuidelines by exact string across tools, so the real
	// system-prompt cost is snippets plus UNIQUE guidelines. Budget target:
	// ~400 tokens at the ~4 chars/token heuristic.
	const uniqueGuidelines = new Set<string>();
	let chars = 0;
	for (const prompt of Object.values(MD_TOOL_PROMPTS)) {
		chars += prompt.promptSnippet.length;
		for (const guideline of prompt.promptGuidelines) uniqueGuidelines.add(guideline);
	}
	for (const guideline of uniqueGuidelines) chars += guideline.length;
	const approxTokens = Math.ceil(chars / 4);
	assert.ok(
		approxTokens <= 400,
		`prompt surface ~${approxTokens} tokens (${chars} chars) exceeds the 400-token budget; trim snippets/guidelines or consolidate shared bullets`,
	);
});

test("fileIdentity: symlink and referent share one identity; missing files fall back", async () => {
	const { fileIdentity } = await import("../src/usage.js");
	const { mkdtemp: makeTemp, writeFile: write, symlink } = await import("node:fs/promises");
	const { tmpdir: osTmp } = await import("node:os");
	const dir = await makeTemp(join(tmpdir(), "pi-mdtools-ident-"));
	const real = join(dir, "real.md");
	const link = join(dir, "link.md");
	await write(real, "# doc\n", "utf8");
	await symlink(real, link);

	const viaLink = await fileIdentity(link);
	const viaReal = await fileIdentity(real);
	assert.equal(viaLink, viaReal, "symlink and referent are the same document");

	const missing = join(dir, "nope.md");
	assert.equal(await fileIdentity(missing), missing, "missing files fall back to the lexical path");
	assert.equal(await fileIdentity(undefined), undefined);
});
