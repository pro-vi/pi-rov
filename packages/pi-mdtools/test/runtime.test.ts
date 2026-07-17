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
	capabilities: ["error_envelope", "section_etag", "task_etag"],
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
	const stdout = envelope("occurrence_out_of_range", {}, {
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
	const notFound = envelope("heading_not_found", {}, { role: "target", total_matches: 0 });
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
	const badLoc = envelope("invalid_task_loc", {}, { loc: "bogus" });
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
	const stdout = envelope("space_weather", {});
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

test("expectEtag wires through to --expect-etag for set-task and replace-section", async () => {
	const ok = JSON.stringify({ schema_version: "mdtools.v1", changed: true });
	const { runtime, calls } = fakeRuntime(withSchema(SCHEMA_OK, (request) => execution(request, ok)));
	await runtime.setTask({ file: "doc.md", loc: "0.0", status: "done", expectEtag: "abcd" });
	const setTaskCall = calls.find((c) => c.args[0] === "set-task");
	assert.ok(setTaskCall?.args.includes("--expect-etag"));
	assert.ok(setTaskCall?.args.includes("abcd"));

	await runtime.replaceSection({ file: "doc.md", heading: "Alpha", content: "x", expectEtag: "efef" });
	const replaceCall = calls.find((c) => c.args[0] === "replace-section");
	assert.ok(replaceCall?.args.includes("--expect-etag"));
	assert.ok(replaceCall?.args.includes("efef"));
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
