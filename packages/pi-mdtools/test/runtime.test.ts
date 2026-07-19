import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { DIAGNOSTIC_TO_ERROR_CODE, MdtoolsRuntime, resolveToolPath } from "../src/runtime.js";
import type { MdCommandExecution, MdCommandRequest, MdCommandRunner } from "../src/types.js";

function execution(request: MdCommandRequest, stdout: string, overrides: Partial<MdCommandExecution> = {}): MdCommandExecution {
	return {
		binary: request.binary,
		args: request.args,
		cwd: request.cwd,
		code: 0,
		stdout,
		stderr: "",
		killed: false,
		started: true,
		...overrides,
	};
}

function fakeRuntime(handler: (request: MdCommandRequest) => MdCommandExecution | Promise<MdCommandExecution>) {
	const calls: MdCommandRequest[] = [];
	const runner: MdCommandRunner = async (request) => {
		calls.push(request);
		return await handler(request);
	};
	return {
		calls,
		runtime: new MdtoolsRuntime({
			cwd: "/work",
			binary: process.execPath,
			runner,
		}),
	};
}

const SCHEMA_OK = JSON.stringify({
	schema_version: "mdtools.v1",
	binary_version: "0.1.0",
	capabilities: [
		"error_envelope",
		"section_etag",
		"task_etag",
		"outline_etag",
		"occurrence_context",
		"etag_ambiguity_fail_closed",
		"guarded_flag",
		"atomic_write",
	],
	commands: [],
	diagnostic_codes: [],
});

const SCHEMA_LEGACY_CAPS = JSON.stringify({
	schema_version: "mdtools.v1",
	binary_version: "0.1.0",
	capabilities: ["error_envelope"],
	commands: [],
	diagnostic_codes: [],
});

function envelope(code: string, extra: Record<string, unknown> = {}, context: Record<string, unknown> | undefined = undefined): string {
	return JSON.stringify({
		schema_version: "mdtools.v1",
		error: {
			code,
			exit_code: 4,
			message: `synthetic ${code}`,
			hint: `hint for ${code}`,
			...(context !== undefined ? { context } : {}),
			...extra,
		},
	});
}

const SPAN = { line_start: 1, line_end: 1, byte_start: 0, byte_end: 5 };

/// A well-formed MutationResult receipt (mirrors Rust src/model.rs: PascalCase
/// command/disposition, required target + invariant). The runtime accepts a
/// mutation as "completed" only against a shape like this.
function receipt(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		schema_version: "mdtools.v1",
		file: "/work/doc.md",
		command: "SetTask",
		target: { TaskItem: { kind: "TaskItem", loc: "0.0", block_index: 1, child_path: [0], span: SPAN } },
		disposition: "Replaced",
		changed: true,
		guarded: false,
		line_endings: "Lf",
		invariant: { preserves_non_target_bytes: true, target_span_before: null, target_span_after: null },
		content: null,
		...overrides,
	});
}

/// Route a request: `md schema` gets the handshake payload; everything else
/// goes to the per-test handler.
function withSchema(schemaStdout: string, handler: (request: MdCommandRequest) => MdCommandExecution) {
	return (request: MdCommandRequest): MdCommandExecution => {
		if (request.args[0] === "schema") return execution(request, schemaStdout);
		return handler(request);
	};
}

test("success payload passes through verbatim under the schema gate", async () => {
	const payload = { schema_version: "mdtools.v1", file: "/work/doc.md", entries: [] };
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, JSON.stringify(payload))));
	const result = await runtime.outline({ file: "doc.md" });
	assert.equal(result.status, "ok");
	assert.deepEqual(result.data, payload);
});

test("wrong schema_version on success payload fails closed before decode", async () => {
	const payload = { schema_version: "mdtools.v2", file: "/work/doc.md", entries: [] };
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, JSON.stringify(payload))));
	const result = await runtime.outline({ file: "doc.md" });
	assert.equal(result.status, "failed");
	assert.equal(result.error?.code, "E_MD_SCHEMA_MISMATCH");
	assert.match(result.error?.message ?? "", /mdtools\.v2/);
});

test("duplicate_heading_match envelope becomes ambiguous with binary-provided candidates", async () => {
	const stdout = envelope("duplicate_heading_match", {}, {
		role: "target",
		total_matches: 3,
		matches: [
			{ block_index: 0, occurrence: 1, line: 1 },
			{ block_index: 4, occurrence: 2, line: 9 },
			{ block_index: 8, occurrence: 3, line: 17 },
		],
	});
	const { runtime, calls } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, stdout, { code: 4 })));
	const result = await runtime.section({ file: "doc.md", heading: "Alpha" });
	assert.equal(result.status, "ambiguous");
	assert.equal(result.error?.code, "E_AMBIGUOUS_HEADING");
	assert.equal(result.candidates?.length, 3);
	assert.equal(result.candidates?.[1]?.occurrence, 2);
	assert.equal(result.candidates?.[1]?.blockIndex, 4);
	assert.match(result.error?.nextAction ?? "", /\boccurrence\b/);
	// no pre-flight reads: the section command is the only md invocation
	assert.deepEqual(
		calls.map((c) => c.args[0]).filter((a) => a !== "schema"),
		["section"],
	);
});

test("role source in the envelope steers advice to sourceOccurrence", async () => {
	const stdout = envelope("duplicate_heading_match", {}, {
		role: "source",
		total_matches: 2,
		matches: [
			{ block_index: 0, occurrence: 1, line: 1 },
			{ block_index: 4, occurrence: 2, line: 9 },
		],
	});
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, stdout, { code: 4 })));
	const result = await runtime.moveSection({
		file: "doc.md",
		source: "Alpha",
		destination: "Beta",
		placement: "into",
	});
	assert.equal(result.error?.code, "E_AMBIGUOUS_HEADING");
	assert.match(result.error?.nextAction ?? "", /sourceOccurrence/);
	assert.equal(result.candidates?.[0]?.role, "source");
});

test("occurrence_out_of_range maps to its own code with requested/total context", async () => {
	const stdout = envelope("occurrence_out_of_range", { exit_code: 1 }, {
		role: "destination",
		requested_occurrence: 9,
		total_matches: 2,
		matches: [
			{ block_index: 0, occurrence: 1, line: 1 },
			{ block_index: 4, occurrence: 2, line: 9 },
		],
	});
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, stdout, { code: 1 })));
	const result = await runtime.moveSection({
		file: "doc.md",
		source: "Alpha",
		destination: "Beta",
		placement: "into",
		destinationOccurrence: 9,
	});
	assert.equal(result.status, "failed");
	assert.equal(result.error?.code, "E_OCCURRENCE_OUT_OF_RANGE");
	assert.match(result.error?.nextAction ?? "", /destinationOccurrence/);
});

test("etag_mismatch and etag_ambiguous map distinctly", async () => {
	const mismatch = envelope("etag_mismatch", {}, { expected_etag: "aaaa", found_etag: "bbbb" });
	let { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, mismatch, { code: 4 })));
	let result = await runtime.setTask({ file: "doc.md", loc: "0.0", status: "done", expectEtag: "aaaa" });
	assert.equal(result.error?.code, "E_ETAG_MISMATCH");
	assert.equal(result.error?.hint, "hint for etag_mismatch");

	const ambiguous = envelope("etag_ambiguous", {}, { expected_etag: "aaaa", total_matches: 2 });
	({ runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, ambiguous, { code: 4 }))));
	result = await runtime.setTask({ file: "doc.md", loc: "0.0", status: "done", expectEtag: "aaaa" });
	assert.equal(result.status, "ambiguous");
	assert.equal(result.error?.code, "E_ETAG_AMBIGUOUS");
});

test("heading_not_found enriches candidates from a follow-up outline listing", async () => {
	const notFound = envelope("heading_not_found", { exit_code: 1 }, { role: "target", total_matches: 0 });
	const outline = JSON.stringify({
		schema_version: "mdtools.v1",
		file: "/work/doc.md",
		entries: [
			{ heading: { level: 1, text: "Alpha", block_index: 0 }, etag: "e1", section_span: {} },
			{ heading: { level: 2, text: "Beta", block_index: 2 }, etag: "e2", section_span: {} },
		],
	});
	const { runtime } = fakeRuntime(
		withSchema(SCHEMA_OK, (request) =>
			request.args[0] === "outline" ? execution(request, outline) : execution(request, notFound, { code: 1 }),
		),
	);
	const result = await runtime.section({ file: "doc.md", heading: "Gamma" });
	assert.equal(result.error?.code, "E_HEADING_NOT_FOUND");
	// pure projection: every current heading listed, no matching applied
	assert.deepEqual(
		result.candidates?.map((c) => c.heading),
		["Alpha", "Beta"],
	);
	assert.equal(result.candidates?.[0]?.etag, "e1");
});

test("bad loc enriches candidates from a follow-up tasks listing", async () => {
	const badLoc = envelope("invalid_task_loc", { exit_code: 3 }, { loc: "bogus" });
	const tasks = JSON.stringify({
		schema_version: "mdtools.v1",
		results: [
			{
				file: "/work/doc.md",
				tasks: [
					{ loc: "0.0", status: "pending", block_index: 0, task_index: 0, summary_text: "one", span: {} },
					{ loc: "0.1", status: "done", block_index: 0, task_index: 1, summary_text: "two", span: {} },
				],
			},
		],
	});
	const { runtime } = fakeRuntime(
		withSchema(SCHEMA_OK, (request) =>
			request.args[0] === "tasks" ? execution(request, tasks) : execution(request, badLoc, { code: 3 }),
		),
	);
	const result = await runtime.setTask({ file: "doc.md", loc: "bogus", status: "done" });
	assert.equal(result.error?.code, "E_BAD_LOC");
	assert.deepEqual(
		result.candidates?.map((c) => c.loc),
		["0.0", "0.1"],
	);
});

test("unmapped diagnostic codes stay visible, never silent", async () => {
	const stdout = envelope("space_weather", { exit_code: 1 });
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, stdout, { code: 1 })));
	const result = await runtime.outline({ file: "doc.md" });
	assert.equal(result.error?.code, "E_MD_COMMAND_FAILED");
	assert.match(result.error?.message ?? "", /space_weather/);
});

test("legacy binary: conflict exit without envelope maps to version-unsupported", async () => {
	const { runtime } = fakeRuntime((request) => {
		if (request.args[0] === "schema") return execution(request, "", { code: 2, stderr: "unknown subcommand" });
		return execution(request, "", { code: 4, stderr: "block 1 etag mismatch: ..." });
	});
	const result = await runtime.setTask({ file: "doc.md", loc: "0.0", status: "done", expectEtag: "aaaa" });
	assert.equal(result.error?.code, "E_MD_VERSION_UNSUPPORTED");
	assert.match(result.error?.nextAction ?? "", /[Uu]pgrade/);
});

test("aborted execution is indeterminate, not failed-clean", async () => {
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, "", { code: null, killed: true })));
	const result = await runtime.setTask({ file: "doc.md", loc: "0.0", status: "done" });
	assert.equal(result.error?.code, "E_MD_COMMAND_ABORTED");
	assert.match(result.error?.nextAction ?? "", /[Rr]e-read/);
});

test("handshake: current requires version AND capabilities; probes once", async () => {
	let schemaCalls = 0;
	const { runtime } = fakeRuntime((request) => {
		if (request.args[0] === "schema") {
			schemaCalls += 1;
			return execution(request, SCHEMA_OK);
		}
		return execution(request, JSON.stringify({ schema_version: "mdtools.v1" }));
	});
	assert.equal((await runtime.handshake()).verdict, "current");
	assert.equal((await runtime.handshake()).verdict, "current");
	assert.equal(schemaCalls, 1);
});

test("handshake: missing required capability is legacy even on a version match", async () => {
	const { runtime } = fakeRuntime(withSchema(SCHEMA_LEGACY_CAPS, (request) => execution(request, "{}")));
	const handshake = await runtime.handshake();
	assert.equal(handshake.verdict, "legacy");
	assert.equal(handshake.binaryVersion, "0.1.0");
});

test("expectEtag wires through as --expect-etag=<value> (no re-entry into option parsing)", async () => {
	const { runtime, calls } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, receipt())));
	await runtime.setTask({ file: "doc.md", loc: "0.0", status: "done", expectEtag: "abcd" });
	const setTaskCall = calls.find((c) => c.args[0] === "set-task");
	assert.ok(setTaskCall?.args.includes("--expect-etag=abcd"));
	// never the two-token form that a hyphen-leading value could hijack
	assert.ok(!setTaskCall?.args.includes("--expect-etag"));

	await runtime.replaceSection({ file: "doc.md", heading: "Alpha", content: "x", expectEtag: "efef" });
	const replaceCall = calls.find((c) => c.args[0] === "replace-section");
	assert.ok(replaceCall?.args.includes("--expect-etag=efef"));
	assert.ok(!replaceCall?.args.includes("--expect-etag"));
});

test("expectEtag: a hyphen-leading value rides as data, never a flag", async () => {
	const { runtime, calls } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, receipt())));
	await runtime.setTask({ file: "doc.md", loc: "0.0", status: "done", expectEtag: "--help" });
	const setTaskCall = calls.find((c) => c.args[0] === "set-task");
	assert.ok(setTaskCall?.args.includes("--expect-etag=--help"));
	assert.ok(!setTaskCall?.args.includes("--help"));
});

test("mutation outcome: a valid v1 receipt is completed", async () => {
	// receipt loc must match the requested loc (target identity binding)
	const r = receipt({
		command: "SetTask",
		target: { TaskItem: { kind: "TaskItem", loc: "1.0", block_index: 1, child_path: [0], span: SPAN } },
	});
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, r)));
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done" });
	assert.equal(result.status, "ok");
	assert.equal(result.mutationOutcome, "completed");
});

test("mutation outcome: schema-valid junk is indeterminate, not success", async () => {
	// exit 0, schema_version matches, but NOT a mutation receipt
	const junk = JSON.stringify({ schema_version: "mdtools.v1", entries: [] });
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, junk)));
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "indeterminate");
	assert.match(result.error?.nextAction ?? "", /re-read/i);
});

test("mutation outcome: started nonzero exit WITHOUT an envelope is indeterminate (not failed-clean)", async () => {
	// current binary, no error envelope on stdout, real nonzero exit code
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, "", { code: 101, stderr: "panic" })));
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "indeterminate");
	assert.equal(result.error?.code, "E_MD_COMMAND_ABORTED");
	assert.notEqual(result.error?.code, "E_MD_COMMAND_FAILED");
});

test("mutation outcome: a valid v1 error envelope is a clean rejection", async () => {
	const stdout = envelope("etag_mismatch", {}, { expected_etag: "aaaa", found_etag: "bbbb" });
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, stdout, { code: 4 })));
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done", expectEtag: "aaaa" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "rejected");
	assert.equal(result.error?.code, "E_ETAG_MISMATCH");
});

test("occurrence advice is rewritten to the role's Pi parameter (source)", async () => {
	const stdout = envelope("duplicate_heading_match", {}, {
		role: "source",
		total_matches: 2,
		matches: [
			{ block_index: 0, occurrence: 1, line: 1 },
			{ block_index: 2, occurrence: 2, line: 5 },
		],
	});
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, stdout, { code: 4 })));
	const result = await runtime.moveSection({ file: "doc.md", source: "Dup", destination: "D", placement: "into" });
	assert.equal(result.error?.code, "E_AMBIGUOUS_HEADING");
	assert.match(result.error?.nextAction ?? "", /sourceOccurrence/);
});

test("unknown/absent role preserves the binary hint (no fabricated target advice)", async () => {
	// duplicate_heading_match with NO role in context: the adapter must not
	// fabricate "retry with occurrence" — it preserves the binary's hint.
	const stdout = envelope("duplicate_heading_match", {}, { total_matches: 2 });
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, stdout, { code: 4 })));
	const result = await runtime.section({ file: "doc.md", heading: "Dup" });
	assert.equal(result.error?.code, "E_AMBIGUOUS_HEADING");
	assert.equal(result.error?.nextAction, "hint for duplicate_heading_match");
	assert.doesNotMatch(result.error?.nextAction ?? "", /retry with occurrence/i);
});

test("receipt is request-bound: a receipt for a DIFFERENT command is indeterminate", async () => {
	const wrong = receipt({ command: "ReplaceSection", target: { Section: {} } });
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, wrong)));
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "indeterminate");
});

test("receipt is request-bound: a receipt for a DIFFERENT file is indeterminate", async () => {
	const wrong = receipt({ file: "/work/other.md" });
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, wrong)));
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "indeterminate");
});

test("receipt is request-bound: a receipt for a DIFFERENT loc is indeterminate", async () => {
	const wrongLoc = receipt({
		command: "SetTask",
		target: { TaskItem: { kind: "TaskItem", loc: "9.0", block_index: 9, child_path: [0], span: SPAN } },
	});
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, wrongLoc)));
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "indeterminate");
});

test("receipt is request-bound: a guarded call whose receipt says guarded:false is indeterminate", async () => {
	const unguardedReceipt = receipt({
		command: "SetTask",
		guarded: false,
		target: { TaskItem: { kind: "TaskItem", loc: "1.0", block_index: 1, child_path: [0], span: SPAN } },
	});
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, unguardedReceipt)));
	// We asked for a guard (expectEtag); a receipt claiming guarded:false means
	// the guard silently did not apply — not an authoritative success.
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done", expectEtag: "abcd" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "indeterminate");
});

test("receipt is request-bound: ReplaceSection receipt for a different occurrence is indeterminate", async () => {
	// We asked for occurrence 2; a receipt for occurrence 1 is a different target.
	const wrong = receipt({
		command: "ReplaceSection",
		disposition: "Replaced",
		changed: true,
		target: {
			Section: {
				kind: "Section",
				selector: { kind: "HeadingText", heading_text: "Dup", occurrence: 1, match_mode: "Exact" },
				section: { span: SPAN, etag: "e" },
			},
		},
	});
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, wrong)));
	const result = await runtime.replaceSection({ file: "doc.md", heading: "Dup", occurrence: 2, content: "x" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "indeterminate");
});

test("receipt is request-bound: MoveSection receipt with a different placement is indeterminate", async () => {
	const wrong = receipt({
		command: "MoveSection",
		disposition: "Replaced",
		changed: true,
		target: {
			SectionMove: {
				kind: "SectionMove",
				source: { selector: { kind: "HeadingText", heading_text: "A", occurrence: null, match_mode: "Exact" }, section: { span: SPAN, etag: "e" } },
				destination: { selector: { kind: "HeadingText", heading_text: "B", occurrence: null, match_mode: "Exact" }, section: { span: SPAN, etag: "e" } },
				destination_mode: "after_sibling", // we asked for "into"
			},
		},
	});
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, wrong)));
	const result = await runtime.moveSection({ file: "doc.md", source: "A", destination: "B", placement: "into" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "indeterminate");
});

test("receipt with a non-null content (dry-run/stdout) is indeterminate — adapter mutations are in-place", async () => {
	const dryRun = receipt({
		command: "SetTask",
		content: "the whole rewritten document",
		target: { TaskItem: { kind: "TaskItem", loc: "1.0", block_index: 1, child_path: [0], span: SPAN } },
	});
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, dryRun)));
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "indeterminate");
});

test("receipt with a fractional u32 (block_index) is indeterminate", async () => {
	const bad = receipt({
		command: "SetTask",
		target: { TaskItem: { kind: "TaskItem", loc: "1.0", block_index: 1.5, child_path: [0], span: SPAN } },
	});
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, bad)));
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "indeterminate");
});

test("receipt with a null required task span is indeterminate", async () => {
	const bad = receipt({
		command: "SetTask",
		target: { TaskItem: { kind: "TaskItem", loc: "1.0", block_index: 1, child_path: [0], span: null } },
	});
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, bad)));
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "indeterminate");
});

test("receipt with a truncated section (matching selector, no section span/etag) is indeterminate", async () => {
	// Independent-review finding: a ReplaceSection receipt whose selector matches
	// but whose nested SectionEntry is truncated must not be accepted — the
	// binding depth must equal SetTask's (which validates span/block_index).
	const truncated = receipt({
		command: "ReplaceSection",
		disposition: "Replaced",
		changed: true,
		target: {
			Section: {
				kind: "Section",
				selector: { kind: "HeadingText", heading_text: "Alpha", occurrence: null, match_mode: "Exact" },
				// section deliberately omitted / truncated
			},
		},
	});
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, truncated)));
	const result = await runtime.replaceSection({ file: "doc.md", heading: "Alpha", content: "x" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "indeterminate");
});

test("lifecycle: started:false with exit 0 is not accepted as completed", async () => {
	// A runner that reports a (cached/forged) valid receipt WITHOUT spawning.
	const r = receipt({ command: "SetTask", target: { TaskItem: { kind: "TaskItem", loc: "1.0", block_index: 1, child_path: [0], span: SPAN } } });
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, r, { started: false })));
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "not_started");
});

test("receipt is request-bound: ReplaceSection receipt for a different heading is indeterminate", async () => {
	const wrong = receipt({
		command: "ReplaceSection",
		disposition: "Replaced",
		changed: true,
		target: { Section: { kind: "Section", selector: { kind: "HeadingText", heading_text: "Other", occurrence: null, match_mode: "Exact" }, section: { span: SPAN, etag: "e" } } },
	});
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, wrong)));
	const result = await runtime.replaceSection({ file: "doc.md", heading: "Alpha", content: "x" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "indeterminate");
});

test("receipt is request-bound: MoveSection receipt for different selectors is indeterminate", async () => {
	const wrong = receipt({
		command: "MoveSection",
		disposition: "Replaced",
		changed: true,
		target: {
			SectionMove: {
				kind: "SectionMove",
				source: { selector: { kind: "HeadingText", heading_text: "WrongSource", occurrence: null, match_mode: "Exact" }, section: { span: SPAN, etag: "e" } },
				destination: { selector: { kind: "HeadingText", heading_text: "WrongDest", occurrence: null, match_mode: "Exact" }, section: { span: SPAN, etag: "e" } },
			},
		},
	});
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, wrong)));
	const result = await runtime.moveSection({ file: "doc.md", source: "A", destination: "B", placement: "into" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "indeterminate");
});

test("a rejecting runner is classified indeterminate for mutations, never escapes", async () => {
	const runner = async (request: MdCommandRequest): Promise<MdCommandExecution> => {
		if (request.args[0] === "schema") return execution(request, SCHEMA_OK);
		throw new Error("injected runner rejection");
	};
	const runtime = new MdtoolsRuntime({ cwd: "/work", binary: process.execPath, runner });
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "indeterminate");
	assert.match(result.error?.message ?? "", /runner failed/i);
});

test("error envelope naming a different file is not authoritative", async () => {
	const stdout = JSON.stringify({
		schema_version: "mdtools.v1",
		file: "/work/other.md",
		error: { code: "etag_mismatch", exit_code: 4, message: "m", hint: "h" },
	});
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, stdout, { code: 4 })));
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done", expectEtag: "aaaa" });
	assert.equal(result.status, "failed");
	assert.notEqual(result.mutationOutcome, "rejected");
	assert.equal(result.mutationOutcome, "indeterminate");
});

test("capability gate: a mutation on a non-current binary is not_started, never spawned", async () => {
	// A legacy binary (missing a required capability) must fail BEFORE the write.
	const calls: string[] = [];
	const { runtime } = fakeRuntime((request) => {
		calls.push(request.args[0] as string);
		return request.args[0] === "schema" ? execution(request, SCHEMA_LEGACY_CAPS) : execution(request, receipt());
	});
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done", expectEtag: "aaaa" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "not_started");
	assert.equal(result.error?.code, "E_MD_VERSION_UNSUPPORTED");
	assert.match(result.error?.nextAction ?? "", /upgrade/i);
	assert.ok(!calls.includes("set-task"), "a non-current binary must never spawn the mutation");
});

test("indeterminate advice leads with re-read (schema-mismatch mutation)", async () => {
	const v2 = JSON.stringify({ schema_version: "mdtools.v2", file: "/work/doc.md", command: "SetTask" });
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, v2)));
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done" });
	assert.equal(result.mutationOutcome, "indeterminate");
	assert.match(result.error?.nextAction ?? "", /re-read/i);
});

test("E_ETAG_AMBIGUOUS occurrence advice is rewritten to the role's Pi parameter (source)", async () => {
	const stdout = envelope("etag_ambiguous", { exit_code: 4 }, { role: "source", expected_etag: "aaaa", total_matches: 2 });
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, stdout, { code: 4 })));
	const result = await runtime.moveSection({ file: "doc.md", source: "Dup", destination: "D", placement: "into" });
	assert.equal(result.error?.code, "E_ETAG_AMBIGUOUS");
	assert.match(result.error?.nextAction ?? "", /sourceOccurrence/);
});

test("receipt with an invalid line_endings value is indeterminate", async () => {
	// Everything else request-bound-correct; ONLY line_endings is out of range,
	// so this isolates the line_endings check.
	const badLineEndings = receipt({
		command: "SetTask",
		guarded: false,
		line_endings: "CR", // not one of Lf/Crlf/Mixed
		target: { TaskItem: { kind: "TaskItem", loc: "1.0", block_index: 1, child_path: [0], span: SPAN } },
	});
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, badLineEndings)));
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "indeterminate");
});

test("error envelope whose exit_code contradicts the child exit is not authoritative", async () => {
	// envelope claims exit 4 but the child exited 1: a crafted/wrong-binary
	// response must NOT be trusted as a clean rejection.
	const stdout = envelope("etag_mismatch", { exit_code: 4 }, { expected_etag: "aaaa", found_etag: "bbbb" });
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, stdout, { code: 1 })));
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done", expectEtag: "aaaa" });
	assert.equal(result.status, "failed");
	assert.notEqual(result.mutationOutcome, "rejected");
	assert.equal(result.mutationOutcome, "indeterminate");
});

test("lifecycle: a child that never spawns is not_started (untouched)", async () => {
	const { runtime } = fakeRuntime(
		withSchema(SCHEMA_OK, (request) => execution(request, "", { code: null, started: false, stderr: "spawn ENOENT" })),
	);
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "not_started");
	assert.match(result.error?.nextAction ?? "", /untouched/i);
});

test("lifecycle: replaceSection pre-abort is not_started", async () => {
	const controller = new AbortController();
	controller.abort();
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, receipt({ command: "ReplaceSection", target: { Section: {} } }))));
	const result = await runtime.replaceSection({ file: "doc.md", heading: "H", content: "x" }, controller.signal);
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "not_started");
});

test("recovery skips enrichment when the binary identity changed after the failure", async () => {
	const { mkdtemp: makeTemp, writeFile: write, chmod } = await import("node:fs/promises");
	const dir = await makeTemp(join(import.meta.dirname, "../node_modules/.tmp-rec-"));
	const binPath = join(dir, "md");
	await write(binPath, "#!/bin/sh\nexit 0\n", "utf8");
	await chmod(binPath, 0o755);

	const notFound = envelope("heading_not_found", { exit_code: 1 }, { role: "target", total_matches: 0 });
	const outline = JSON.stringify({ schema_version: "mdtools.v1", entries: [{ heading: { text: "Real", block_index: 0, level: 1 }, etag: "e" }] });
	const runner = async (request: MdCommandRequest): Promise<MdCommandExecution> => {
		if (request.args[0] === "schema") return execution(request, SCHEMA_OK);
		if (request.args[0] === "section") {
			// Replace the binary IN PLACE before enrichment can run.
			await write(binPath, "#!/bin/sh\n# replaced\nexit 0\n", "utf8");
			return execution(request, notFound, { code: 1 });
		}
		return execution(request, outline); // enrichment outline (must NOT run)
	};
	const runtime = new MdtoolsRuntime({ cwd: "/work", binary: binPath, runner });
	const result = await runtime.section({ file: "doc.md", heading: "Nope" });
	assert.equal(result.error?.code, "E_HEADING_NOT_FOUND");
	assert.equal(result.candidates, undefined, "enrichment must be skipped when identity changed under us");
});

test("each adapter-required capability is enforced: missing any one ⇒ legacy", async () => {
	const { REQUIRED_CAPABILITIES } = await import("../src/runtime.js");
	for (const missing of REQUIRED_CAPABILITIES) {
		const caps = REQUIRED_CAPABILITIES.filter((c) => c !== missing);
		const schema = JSON.stringify({ schema_version: "mdtools.v1", binary_version: "0.1.0", capabilities: caps, commands: [], diagnostic_codes: [] });
		const { runtime } = fakeRuntime(withSchema(schema, (request) => execution(request, "{}")));
		const handshake = await runtime.handshake();
		assert.equal(handshake.verdict, "legacy", `a binary missing ${missing} must be legacy, not current`);
	}
});

test("status does not invent a verdict when identity cannot be observed", async () => {
	const { mkdtemp: makeTemp, writeFile: write, chmod } = await import("node:fs/promises");
	const dir = await makeTemp(join(import.meta.dirname, "../node_modules/.tmp-st-"));
	const binPath = join(dir, "md");
	await write(binPath, "#!/bin/sh\nexit 0\n", "utf8");
	await chmod(binPath, 0o755);
	let counter = 0;
	const runner = async (request: MdCommandRequest): Promise<MdCommandExecution> => {
		if (request.args[0] === "schema") {
			counter += 1;
			await write(binPath, `#!/bin/sh\n# rev ${counter}\nexit 0\n`, "utf8"); // churn every probe
			return execution(request, SCHEMA_OK);
		}
		return execution(request, "{}");
	};
	const runtime = new MdtoolsRuntime({ cwd: "/work", binary: binPath, runner });
	const status = await runtime.status();
	assert.equal(status.binary.found, true);
	assert.equal(status.handshake, undefined, "an unobservable binary must not be labeled with an invented verdict");
});

test("mutation outcome: pre-start abort is not_started (untouched)", async () => {
	const controller = new AbortController();
	controller.abort();
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, receipt())));
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done" }, controller.signal);
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "not_started");
	assert.equal(result.error?.code, "E_MD_COMMAND_ABORTED");
});

test("mutation outcome: exit-0 unparseable output is indeterminate", async () => {
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, "not json at all")));
	const result = await runtime.setTask({ file: "doc.md", loc: "1.0", status: "done" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "indeterminate");
});

test("mutating tools issue exactly one md call — no pre-flight reads", async () => {
	const ok = JSON.stringify({ schema_version: "mdtools.v1", changed: true });
	const { runtime, calls } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, ok)));
	await runtime.moveSection({ file: "doc.md", source: "A", destination: "B", placement: "into" });
	assert.deepEqual(
		calls.map((c) => c.args[0]).filter((a) => a !== "schema"),
		["move-section"],
	);
});

test("no second matcher: runtime.ts contains no case-folding or matching calls", async () => {
	const source = await readFile(join(import.meta.dirname, "../src/runtime.ts"), "utf8");
	for (const banned of ["toLocaleLowerCase", "toLowerCase", "localeCompare"]) {
		assert.ok(!source.includes(banned), `src/runtime.ts must not contain ${banned}: the binary owns matching`);
	}
});

test("DIAGNOSTIC_TO_ERROR_CODE has no accidental gaps for conflict-class codes", () => {
	assert.equal(DIAGNOSTIC_TO_ERROR_CODE.etag_mismatch, "E_ETAG_MISMATCH");
	assert.equal(DIAGNOSTIC_TO_ERROR_CODE.etag_ambiguous, "E_ETAG_AMBIGUOUS");
	assert.equal(DIAGNOSTIC_TO_ERROR_CODE.duplicate_heading_match, "E_AMBIGUOUS_HEADING");
});

test("resolveToolPath strips @ and resolves against cwd", () => {
	assert.equal(resolveToolPath("/work", "@doc.md"), "/work/doc.md");
	assert.equal(resolveToolPath("/work", "sub/doc.md"), "/work/sub/doc.md");
	assert.equal(resolveToolPath("/work", "/abs/doc.md"), "/abs/doc.md");
});

test("binary resolution precedence: MD_BINARY_PATH > MDTOOLS_MD_BIN > PATH", async () => {
	const { mkdtemp: makeTemp, writeFile: write, chmod } = await import("node:fs/promises");
	const { tmpdir: osTmp } = await import("node:os");
	const { resolveMdBinary } = await import("../src/runtime.js");
	const dir = await makeTemp(join(osTmp(), "pi-mdtools-resolve-"));
	const make = async (name: string) => {
		const p = join(dir, name);
		await write(p, "#!/bin/sh\nexit 0\n", "utf8");
		await chmod(p, 0o755);
		return p;
	};
	const primary = await make("md-primary");
	const alias = await make("md-alias");
	const pathDir = join(dir, "bin");
	const { mkdir } = await import("node:fs/promises");
	await mkdir(pathDir);
	const onPath = join(pathDir, "md");
	await write(onPath, "#!/bin/sh\nexit 0\n", "utf8");
	await chmod(onPath, 0o755);

	// both set: primary wins
	let res = await resolveMdBinary({ cwd: dir, env: { MD_BINARY_PATH: primary, MDTOOLS_MD_BIN: alias, PATH: pathDir } });
	assert.equal(res.path, primary);
	// alias alone still resolves (compatibility)
	res = await resolveMdBinary({ cwd: dir, env: { MDTOOLS_MD_BIN: alias, PATH: pathDir } });
	assert.equal(res.path, alias);
	// neither: PATH lookup
	res = await resolveMdBinary({ cwd: dir, env: { PATH: pathDir } });
	assert.equal(res.path, onPath);
});

test("a pre-aborted signal never spawns md and reports untouched", async () => {
	const controller = new AbortController();
	controller.abort();
	const { runtime, calls } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, "{}")));
	const result = await runtime.setTask({ file: "doc.md", loc: "0.0", status: "done" }, controller.signal);
	assert.equal(result.error?.code, "E_MD_COMMAND_ABORTED");
	assert.match(result.error?.nextAction ?? "", /untouched|nothing changed/i);
	assert.equal(calls.length, 0, "no md process may be spawned after cancellation");
});

test("handshake re-probes when the resolved binary identity changes", async () => {
	// Before the explicit binary exists, resolution falls back to whatever md
	// the machine has (PATH/fallback dirs) — the fake runner reports THAT
	// identity as legacy. Once the explicit binary appears, resolution flips
	// to it and the cached legacy verdict must be re-probed, not pinned.
	const { mkdtemp: makeTemp, writeFile: write, chmod } = await import("node:fs/promises");
	const dir = await makeTemp(join(import.meta.dirname, "../node_modules/.tmp-hs-"));
	const binPath = join(dir, "md");

	let schemaCalls = 0;
	const runner = async (request: MdCommandRequest): Promise<MdCommandExecution> => {
		if (request.args[0] === "schema") {
			schemaCalls += 1;
			return execution(request, request.binary === binPath ? SCHEMA_OK : SCHEMA_LEGACY_CAPS);
		}
		return execution(request, "{}");
	};
	const runtime = new MdtoolsRuntime({ cwd: "/work", binary: binPath, runner });

	const before = await runtime.handshake();
	assert.notEqual(before.verdict, "current", "system fallback binary must not read current");

	// install the explicit binary mid-session: the cached verdict must flip
	await write(binPath, "#!/bin/sh\nexit 0\n", "utf8");
	await chmod(binPath, 0o755);
	assert.equal((await runtime.handshake()).verdict, "current");
	// and stays cached for the same identity
	const probesAfterFlip = schemaCalls;
	assert.equal((await runtime.handshake()).verdict, "current");
	assert.equal(schemaCalls, probesAfterFlip);
});

test("in-place replacement with same size and restored mtime still invalidates (ctimeNs)", async () => {
	const { mkdtemp: makeTemp, writeFile: write, readFile: read, chmod, utimes, stat: statFile } = await import("node:fs/promises");
	const dir = await makeTemp(join(import.meta.dirname, "../node_modules/.tmp-id-"));
	const binPath = join(dir, "md");
	const legacyBody = "#!/bin/sh\nOLD\n";
	const currentBody = "#!/bin/sh\nNEW\n"; // identical byte length, same inode after rewrite
	assert.equal(legacyBody.length, currentBody.length);
	await write(binPath, legacyBody, "utf8");
	await chmod(binPath, 0o755);
	const original = await statFile(binPath);

	const runner = async (request: MdCommandRequest): Promise<MdCommandExecution> => {
		if (request.args[0] === "schema") {
			const body = await read(binPath, "utf8");
			return execution(request, body.includes("NEW") ? SCHEMA_OK : SCHEMA_LEGACY_CAPS);
		}
		return execution(request, "{}");
	};
	const runtime = new MdtoolsRuntime({ cwd: "/work", binary: binPath, runner });
	assert.notEqual((await runtime.handshake()).verdict, "current");

	// Overwrite in place (same inode, same size), then restore the old mtime:
	// the attacker's "looks unchanged" move. ctime cannot be set back, so the
	// identity key must still change and force a re-probe.
	await write(binPath, currentBody, "utf8");
	await utimes(binPath, original.atime, original.mtime);
	assert.equal((await runtime.handshake()).verdict, "current", "ctime change must force a re-probe despite restored mtime + same size");
});

test("a churning binary yields an unstable pre-start result and never spawns a mutation", async () => {
	const { mkdtemp: makeTemp, writeFile: write, chmod } = await import("node:fs/promises");
	const dir = await makeTemp(join(import.meta.dirname, "../node_modules/.tmp-churn-"));
	const binPath = join(dir, "md");
	await write(binPath, "#!/bin/sh\nexit 0\n", "utf8");
	await chmod(binPath, 0o755);

	let counter = 0;
	const mutationSpawns: string[] = [];
	const runner = async (request: MdCommandRequest): Promise<MdCommandExecution> => {
		if (request.args[0] === "schema") {
			// self-replace DURING every probe so identity never stabilizes
			counter += 1;
			await write(binPath, `#!/bin/sh\n# rev ${counter}\nexit 0\n`, "utf8");
			return execution(request, SCHEMA_OK);
		}
		mutationSpawns.push(request.args[0] as string);
		return execution(request, receipt());
	};
	const runtime = new MdtoolsRuntime({ cwd: "/work", binary: binPath, runner });
	const result = await runtime.setTask({ file: "doc.md", loc: "0.0", status: "done" });
	assert.equal(result.status, "failed");
	assert.equal(result.mutationOutcome, "not_started");
	assert.equal(mutationSpawns.length, 0, "a churning binary must never spawn the mutation");
});

test("status reports the resolution it actually probed (one observation)", async () => {
	const { runtime } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, "{}")));
	const status = await runtime.status();
	assert.equal(status.binary.found, true);
	assert.equal(status.handshake?.verdict, "current");
});

test("recovery classification and enrichment reuse the observed context (no re-resolve/re-handshake)", async () => {
	// Encodes U2's verification: no fresh resolveBinary() or handshake() occurs
	// inside failure classification or enrichment. acquireStableContext (which
	// legitimately resolves) is defined ABOVE tryReadJson, so it is excluded.
	const source = await readFile(join(import.meta.dirname, "../src/runtime.ts"), "utf8");
	// tryReadJson body (enrichment): up to the next method.
	const tryReadStart = source.indexOf("private async tryReadJson");
	const tryReadBody = source.slice(tryReadStart, source.indexOf("private async runJson", tryReadStart));
	// failureResult body (classification): to end of class.
	const failureBody = source.slice(source.indexOf("private async failureResult"));
	for (const [name, body] of [
		["tryReadJson", tryReadBody],
		["failureResult", failureBody],
	] as const) {
		assert.ok(body.length > 0, `${name} region not found`);
		assert.ok(!body.includes("this.resolveBinary("), `${name} must not re-resolve the binary`);
		assert.ok(!body.includes("this.handshake("), `${name} must not re-handshake`);
		assert.ok(!body.includes("this.acquireStableContext("), `${name} must reuse the passed context, not acquire a new one`);
	}
});
