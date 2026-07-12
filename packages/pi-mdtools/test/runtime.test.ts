import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MdtoolsRuntime, resolveToolPath } from "../src/runtime.js";
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

const outlineJson = {
	schema_version: "mdtools.v1",
	file: "/work/doc.md",
	entries: [
		{ heading: { level: 1, text: "Alpha", block_index: 0, span: { line_start: 1, line_end: 1 } } },
		{ heading: { level: 2, text: "Beta", block_index: 2, span: { line_start: 5, line_end: 5 } } },
		{ heading: { level: 1, text: "Alpha", block_index: 4, span: { line_start: 9, line_end: 9 } } },
	],
};

const blocksJson = {
	schema_version: "mdtools.v1",
	file: "/work/doc.md",
	blocks: [
		{ index: 0, kind: "Heading", etag: "etag-alpha-1", span: {}, preview: "# Alpha" },
		{ index: 2, kind: "Heading", etag: "etag-beta", span: {}, preview: "## Beta" },
		{ index: 4, kind: "Heading", etag: "etag-alpha-2", span: {}, preview: "# Alpha" },
	],
};

const tasksJson = {
	schema_version: "mdtools.v1",
	results: [
		{
			file: "/work/doc.md",
			tasks: [
				{
					loc: "2.0",
					block_index: 2,
					child_path: [0],
					task_index: 0,
					status: "pending",
					depth: 0,
					nearest_heading: "Beta",
					nearest_heading_block_index: 2,
					span: {},
					summary_text: "Ship the thing",
				},
			],
		},
	],
};

test("resolveToolPath resolves relative paths and strips leading @", () => {
	assert.equal(resolveToolPath("/repo", "@docs/a.md"), "/repo/docs/a.md");
	assert.equal(resolveToolPath("/repo", "/tmp/a.md"), "/tmp/a.md");
});

test("outline shells out to md outline --json and returns parsed data", async () => {
	const { runtime, calls } = fakeRuntime((request) => execution(request, JSON.stringify({ schema_version: "mdtools.v1", entries: [] })));

	const result = await runtime.outline({ file: "doc.md" });

	assert.equal(result.status, "ok");
	assert.deepEqual(calls[0]?.args, ["outline", "--json", "/work/doc.md"]);
	assert.deepEqual(result.data, { schema_version: "mdtools.v1", entries: [] });
});

test("malformed md JSON returns a stable parse recovery code", async () => {
	const { runtime } = fakeRuntime((request) => execution(request, "not-json"));

	const result = await runtime.outline({ file: "doc.md" });

	assert.equal(result.status, "failed");
	assert.equal(result.error?.code, "E_MD_JSON_PARSE");
	assert.match(result.error?.nextAction ?? "", /md binary/);
});

test("section returns ambiguous candidates before reading duplicate headings", async () => {
	const { runtime, calls } = fakeRuntime((request) => {
		if (request.args[0] === "outline") return execution(request, JSON.stringify(outlineJson));
		if (request.args[0] === "blocks") return execution(request, JSON.stringify(blocksJson));
		return execution(request, JSON.stringify({ unexpected: request.args[0] }));
	});

	const result = await runtime.section({ file: "doc.md", heading: "Alpha" });

	assert.equal(result.status, "ambiguous");
	assert.equal(result.error?.code, "E_AMBIGUOUS_HEADING");
	assert.match(result.error?.nextAction ?? "", /occurrence/);
	assert.equal(result.candidates?.length, 2);
	assert.equal(result.candidates?.[0]?.etag, "etag-alpha-1");
	assert.deepEqual(calls.map((call) => call.args[0]), ["outline", "blocks"]);
});

test("section occurrence disambiguates and invokes md section", async () => {
	const { runtime, calls } = fakeRuntime((request) => {
		if (request.args[0] === "outline") return execution(request, JSON.stringify(outlineJson));
		if (request.args[0] === "blocks") return execution(request, JSON.stringify(blocksJson));
		return execution(request, JSON.stringify({ schema_version: "mdtools.v1", content: "# Alpha\nsecond" }));
	});

	const result = await runtime.section({ file: "doc.md", heading: "Alpha", occurrence: 2 });

	assert.equal(result.status, "ok");
	assert.deepEqual(calls[2]?.args, ["section", "--json", "--occurrence", "2", "Alpha", "/work/doc.md"]);
});

test("setTask preflights current tasks, then mutates in place with structural loc and status", async () => {
	const { runtime, calls } = fakeRuntime((request) => {
		if (request.args[0] === "tasks") return execution(request, JSON.stringify(tasksJson));
		return execution(request, JSON.stringify({ schema_version: "mdtools.v1", command: "SetTask", changed: true }));
	});

	const result = await runtime.setTask({ file: "doc.md", loc: "2.0", status: "done" });

	assert.equal(result.status, "ok");
	assert.deepEqual(calls.map((call) => call.args[0]), ["tasks", "set-task"]);
	assert.deepEqual(calls[1]?.args, ["set-task", "--json", "--status", "done", "-i", "2.0", "/work/doc.md"]);
});

test("setTask returns current task candidates for a stale loc", async () => {
	const { runtime, calls } = fakeRuntime((request) => {
		if (request.args[0] === "tasks") return execution(request, JSON.stringify(tasksJson));
		return execution(request, JSON.stringify({ schema_version: "mdtools.v1", command: "SetTask", changed: true }));
	});

	const result = await runtime.setTask({ file: "doc.md", loc: "99.0", status: "done" });

	assert.equal(result.status, "failed");
	assert.equal(result.error?.code, "E_BAD_LOC");
	assert.match(result.error?.nextAction ?? "", /md_tasks/);
	assert.equal(result.candidates?.[0]?.loc, "2.0");
	assert.equal(result.candidates?.[0]?.heading, "Beta");
	assert.deepEqual(calls.map((call) => call.args[0]), ["tasks"]);
});

test("setTask reports schema mismatch when task preflight has unexpected shape", async () => {
	const { runtime, calls } = fakeRuntime((request) => {
		if (request.args[0] === "tasks") return execution(request, JSON.stringify({ schema_version: "mdtools.v1", results: [{ file: "/work/doc.md" }] }));
		return execution(request, JSON.stringify({ schema_version: "mdtools.v1", command: "SetTask", changed: true }));
	});

	const result = await runtime.setTask({ file: "doc.md", loc: "2.0", status: "done" });

	assert.equal(result.status, "failed");
	assert.equal(result.error?.code, "E_MD_SCHEMA_MISMATCH");
	assert.deepEqual(calls.map((call) => call.args[0]), ["tasks"]);
});

test("replaceSection fails closed on expectEtag mismatch", async () => {
	const { runtime, calls } = fakeRuntime((request) => {
		if (request.args[0] === "outline") return execution(request, JSON.stringify(outlineJson));
		if (request.args[0] === "blocks") return execution(request, JSON.stringify(blocksJson));
		return execution(request, JSON.stringify({ changed: true }));
	});

	const result = await runtime.replaceSection({ file: "doc.md", heading: "Beta", content: "## Beta\nnew", expectEtag: "stale" });

	assert.equal(result.status, "failed");
	assert.equal(result.error?.code, "E_ETAG_MISMATCH");
	assert.match(result.error?.message ?? "", /etag mismatch/);
	assert.match(result.error?.nextAction ?? "", /md_blocks/);
	assert.deepEqual(calls.map((call) => call.args[0]), ["outline", "blocks"]);
});

test("replaceSection writes content to a temp file and invokes replace-section", async () => {
	const { runtime, calls } = fakeRuntime((request) => {
		if (request.args[0] === "outline") return execution(request, JSON.stringify(outlineJson));
		if (request.args[0] === "blocks") return execution(request, JSON.stringify(blocksJson));
		return execution(request, JSON.stringify({ schema_version: "mdtools.v1", command: "ReplaceSection", changed: true }));
	});

	const result = await runtime.replaceSection({
		file: "doc.md",
		heading: "Beta",
		content: "## Beta\nnew",
		expectEtag: "etag-beta",
	});

	assert.equal(result.status, "ok");
	assert.equal(calls[2]?.args[0], "replace-section");
	assert.deepEqual(calls[2]?.args.slice(0, 4), ["replace-section", "--json", "-i", "--from"]);
	assert.equal(calls[2]?.args.at(-2), "Beta");
	assert.equal(calls[2]?.args.at(-1), "/work/doc.md");
});

test("moveSection checks source and destination ambiguity before invoking md", async () => {
	const { runtime, calls } = fakeRuntime((request) => {
		if (request.args[0] === "outline") return execution(request, JSON.stringify(outlineJson));
		if (request.args[0] === "blocks") return execution(request, JSON.stringify(blocksJson));
		return execution(request, JSON.stringify({ schema_version: "mdtools.v1", command: "MoveSection", changed: true }));
	});

	const result = await runtime.moveSection({
		file: "doc.md",
		source: "Alpha",
		sourceOccurrence: 1,
		destination: "Beta",
		placement: "after",
	});

	assert.equal(result.status, "ok");
	assert.deepEqual(calls.map((call) => call.args[0]), ["outline", "blocks", "move-section"]);
	assert.deepEqual(calls[2]?.args, [
		"move-section",
		"--json",
		"-i",
		"--source-occurrence",
		"1",
		"--auto-level",
		"--after",
		"Beta",
		"Alpha",
		"/work/doc.md",
	]);
});

test("real md status reports configured binary when executable", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mdtools-test-"));
	try {
		const fakeMd = join(dir, "md");
		await writeFile(fakeMd, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });

		const runtime = new MdtoolsRuntime({ cwd: dir, binary: fakeMd, runner: async (request) => execution(request, "{}") });
		const status = await runtime.status();

		assert.equal(status.binary.found, true);
		assert.equal(status.binary.path, fakeMd);
		assert.equal(status.binary.source, "explicit");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
