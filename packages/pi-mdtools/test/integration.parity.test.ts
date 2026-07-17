import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { DIAGNOSTIC_TO_ERROR_CODE, MdtoolsRuntime, REQUIRED_CAPABILITIES } from "../src/runtime.js";
import type { MdCommandRequest, MdCommandRunner } from "../src/types.js";

/// Cross-repo parity: drives the REAL md binary. Opt-in:
///   MD_BINARY=/path/to/md npm run test:parity
/// Skipped (loudly) when MD_BINARY is unset so unit CI stays hermetic.
const MD_BINARY = process.env.MD_BINARY;
const enabled = MD_BINARY !== undefined && MD_BINARY.trim() !== "";

function realSchema(): Record<string, unknown> {
	const out = spawnSync(MD_BINARY as string, ["schema", "--json"], { encoding: "utf8" });
	assert.equal(out.status, 0, out.stderr);
	return JSON.parse(out.stdout) as Record<string, unknown>;
}

async function realRuntime(): Promise<{ runtime: MdtoolsRuntime; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pi-mdtools-parity-"));
	return { runtime: new MdtoolsRuntime({ cwd: dir, binary: MD_BINARY as string }), dir };
}

const DUP_DOC = "# Doc\n\n## Setup\n\nsame body\n\n## Setup\n\nsame body\n\n## Other\n\ndifferent\n";

test("parity: every subcommand and flag the adapter emits exists in md schema", { skip: !enabled }, async () => {
	// Record every argv the runtime can produce by exercising all tools with
	// every optional flag set, against a recording fake runner.
	const calls: MdCommandRequest[] = [];
	const recorder: MdCommandRunner = async (request) => {
		calls.push(request);
		return {
			binary: request.binary,
			args: request.args,
			cwd: request.cwd,
			code: 0,
			stdout: JSON.stringify({ schema_version: "mdtools.v1", entries: [], results: [], blocks: [] }),
			stderr: "",
			killed: false,
		};
	};
	const rt = new MdtoolsRuntime({ cwd: "/work", binary: process.execPath, runner: recorder });
	await rt.outline({ file: "doc.md" });
	await rt.section({ file: "doc.md", heading: "H", ignoreCase: true, occurrence: 2 });
	await rt.tasks({ file: "doc.md", status: "pending" });
	await rt.table({ file: "doc.md", index: 1, select: "a,b", where: ["a=1"] });
	await rt.blocks({ file: "doc.md" });
	await rt.block({ file: "doc.md", index: 0 });
	await rt.setTask({ file: "doc.md", loc: "0.0", status: "done", expectEtag: "aa" });
	await rt.moveSection({
		file: "doc.md",
		source: "A",
		destination: "B",
		placement: "into",
		leveling: "keep",
		ignoreCase: true,
		sourceOccurrence: 1,
		destinationOccurrence: 2,
	});
	await rt.replaceSection({ file: "doc.md", heading: "H", content: "x", expectEtag: "aa", ignoreCase: true, occurrence: 1 });

	const schema = realSchema();
	const commands = schema.commands as Array<{ name: string; flags: Array<{ long: string }> }>;
	const flagsByCommand = new Map<string, Set<string>>();
	for (const command of commands) {
		flagsByCommand.set(command.name, new Set(command.flags.map((f) => f.long)));
	}
	const globalFlags = new Set((schema.global_flags as Array<{ long: string }>).map((f) => f.long));

	for (const call of calls) {
		const [subcommand, ...rest] = call.args;
		if (subcommand === "schema") continue;
		const known = flagsByCommand.get(subcommand as string);
		assert.ok(known !== undefined, `adapter emits unknown subcommand ${subcommand}`);
		for (const arg of rest) {
			if (!arg.startsWith("--")) continue;
			assert.ok(
				known.has(arg) || globalFlags.has(arg),
				`adapter emits ${subcommand} flag ${arg} that md schema does not list`,
			);
		}
	}
});

test("parity: DIAGNOSTIC_TO_ERROR_CODE is total over md's diagnostic table", { skip: !enabled }, () => {
	const schema = realSchema();
	const diagnostics = schema.diagnostic_codes as Array<{ code: string }>;
	assert.ok(diagnostics.length >= 20);
	for (const diagnostic of diagnostics) {
		assert.ok(
			DIAGNOSTIC_TO_ERROR_CODE[diagnostic.code] !== undefined,
			`md diagnostic ${diagnostic.code} has no adapter mapping; add it to DIAGNOSTIC_TO_ERROR_CODE`,
		);
	}
});

test("parity: handshake against the real binary is current", { skip: !enabled }, async () => {
	const { runtime } = await realRuntime();
	const handshake = await runtime.handshake();
	assert.equal(handshake.verdict, "current", JSON.stringify(handshake));
	for (const capability of REQUIRED_CAPABILITIES) {
		assert.ok(handshake.capabilities?.includes(capability));
	}
});

test("parity: behavioral roundtrips hit the exact adapter codes", { skip: !enabled }, async () => {
	const { runtime, dir } = await realRuntime();
	const doc = join(dir, "doc.md");
	await writeFile(doc, DUP_DOC, "utf8");

	// heading not found -> outline-projection candidates with etags
	let result = await runtime.section({ file: doc, heading: "Nowhere" });
	assert.equal(result.error?.code, "E_HEADING_NOT_FOUND");
	assert.deepEqual(
		result.candidates?.map((c) => c.heading),
		["Doc", "Setup", "Setup", "Other"],
	);
	assert.ok(result.candidates?.every((c) => typeof c.etag === "string"));

	// duplicate headings -> ambiguous with binary-computed occurrences
	result = await runtime.section({ file: doc, heading: "Setup" });
	assert.equal(result.status, "ambiguous");
	assert.equal(result.error?.code, "E_AMBIGUOUS_HEADING");
	assert.deepEqual(
		result.candidates?.map((c) => c.occurrence),
		[1, 2],
	);

	// occurrence out of range -> distinct code
	result = await runtime.section({ file: doc, heading: "Setup", occurrence: 9 });
	assert.equal(result.error?.code, "E_OCCURRENCE_OUT_OF_RANGE");

	// non-ASCII ignore-case is decided by the binary, not the adapter
	const accents = join(dir, "accents.md");
	await writeFile(accents, "# CAFÉ\n\nbody\n", "utf8");
	result = await runtime.section({ file: accents, heading: "café", ignoreCase: true });
	assert.equal(result.status, "ok", JSON.stringify(result.error ?? {}));

	// bad loc -> E_BAD_LOC with current task candidates
	const tasksDoc = join(dir, "tasks.md");
	await writeFile(tasksDoc, "- [ ] alpha\n- [x] beta\n", "utf8");
	result = await runtime.setTask({ file: tasksDoc, loc: "9.9", status: "done" });
	assert.equal(result.error?.code, "E_BAD_LOC");
	assert.deepEqual(
		result.candidates?.map((c) => c.loc),
		["0.0", "0.1"],
	);

	// stale etag -> E_ETAG_MISMATCH with the binary's hint
	result = await runtime.setTask({ file: tasksDoc, loc: "0.0", status: "done", expectEtag: "0000000000000000" });
	assert.equal(result.error?.code, "E_ETAG_MISMATCH");
	assert.ok((result.error?.hint ?? "").length > 0);

	// identical duplicate sections + shared etag -> fails closed as ambiguous
	const sectionRead = await runtime.section({ file: doc, heading: "Setup", occurrence: 1 });
	assert.equal(sectionRead.status, "ok");
	const sectionEtag = (sectionRead.data as { section?: { etag?: string } })?.section?.etag;
	assert.ok(typeof sectionEtag === "string");
	result = await runtime.replaceSection({
		file: doc,
		heading: "Setup",
		occurrence: 1,
		content: "## Setup\n\nnew body\n",
		expectEtag: sectionEtag,
	});
	assert.equal(result.error?.code, "E_ETAG_AMBIGUOUS");
	assert.equal(result.status, "ambiguous");

	// fresh unique etag -> mutation succeeds with guarded flag in payload
	const otherRead = await runtime.section({ file: doc, heading: "Other" });
	const otherEtag = (otherRead.data as { section?: { etag?: string } })?.section?.etag;
	assert.ok(typeof otherEtag === "string");
	result = await runtime.replaceSection({
		file: doc,
		heading: "Other",
		content: "## Other\n\nreplaced\n",
		expectEtag: otherEtag,
	});
	assert.equal(result.status, "ok", JSON.stringify(result.error ?? {}));
	assert.equal((result.data as { guarded?: boolean })?.guarded, true);
	assert.equal((result.data as { changed?: boolean })?.changed, true);
});
