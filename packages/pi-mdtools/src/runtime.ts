import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";

import type {
	BlockParams,
	BlocksParams,
	MdBinaryResolution,
	MdCandidate,
	MdCommandExecution,
	MdErrorCode,
	MdCommandRequest,
	MdCommandRunner,
	MdResultEnvelope,
	MdtoolsStatus,
	MoveSectionParams,
	OutlineParams,
	ReplaceSectionParams,
	SectionParams,
	SetTaskParams,
	TableParams,
	TasksParams,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
/// Primary override, plus the originally-shipped name kept as a
/// compatibility alias so existing installs keep working.
const MDTOOLS_ENV_BIN_PRIMARY = "MD_BINARY_PATH";
const MDTOOLS_ENV_BIN = "MDTOOLS_MD_BIN";

interface RuntimeOptions {
	cwd: string;
	binary?: string;
	env?: NodeJS.ProcessEnv;
	runner?: MdCommandRunner;
	timeoutMs?: number;
}

interface RunJsonSuccess {
	ok: true;
	data: Record<string, unknown>;
	execution: MdCommandExecution;
}

interface RunJsonFailure {
	ok: false;
	result: MdResultEnvelope;
}

type RunJsonOutcome = RunJsonSuccess | RunJsonFailure;

export const MDTOOLS_SCHEMA_VERSION = "mdtools.v1";

/// Capabilities the handshake requires before the binary counts as
/// "current". A version match without these is "legacy".
export const REQUIRED_CAPABILITIES = ["error_envelope", "section_etag"] as const;

/// Total mapping from the binary's serialized DiagnosticCode to the adapter
/// error code. Exported so the parity suite can prove totality against
/// `md schema --json`'s diagnostic_codes list. An unmapped code at runtime
/// falls back to E_MD_COMMAND_FAILED with the raw code kept visible in the
/// message — never silently.
export const DIAGNOSTIC_TO_ERROR_CODE: Record<string, MdErrorCode> = {
	io_open_failed: "E_MD_COMMAND_FAILED",
	parse_failed: "E_MD_COMMAND_FAILED",
	frontmatter_parse_failed: "E_MD_COMMAND_FAILED",
	heading_not_found: "E_HEADING_NOT_FOUND",
	occurrence_out_of_range: "E_OCCURRENCE_OUT_OF_RANGE",
	block_index_out_of_range: "E_MD_COMMAND_FAILED",
	duplicate_heading_match: "E_AMBIGUOUS_HEADING",
	invalid_selector: "E_MD_COMMAND_FAILED",
	invalid_utf8_on_stdin: "E_MD_COMMAND_FAILED",
	invalid_key_path: "E_MD_COMMAND_FAILED",
	frontmatter_field_conflict: "E_MD_COMMAND_FAILED",
	no_tables_in_document: "E_MD_COMMAND_FAILED",
	table_not_a_table: "E_MD_COMMAND_FAILED",
	column_not_found: "E_MD_COMMAND_FAILED",
	table_row_not_found: "E_MD_COMMAND_FAILED",
	invalid_table_row: "E_MD_COMMAND_FAILED",
	task_item_not_found: "E_BAD_LOC",
	not_a_task_list: "E_BAD_LOC",
	invalid_task_loc: "E_BAD_LOC",
	etag_mismatch: "E_ETAG_MISMATCH",
	etag_ambiguous: "E_ETAG_AMBIGUOUS",
	multi_file_failure: "E_MD_COMMAND_FAILED",
};

/// Decoded projection of the binary's structured error envelope. The adapter
/// NEVER re-derives any of this from stderr prose or exit codes when an
/// envelope is present — the binary owns matching and error semantics.
interface DecodedBinaryError {
	diagnosticCode: string;
	errorCode: MdErrorCode;
	status: "ambiguous" | "failed";
	message: string;
	hint?: string;
	role?: "target" | "source" | "destination";
	requestedOccurrence?: number;
	totalMatches?: number;
	matches?: Array<{ blockIndex: number; occurrence: number; line: number }>;
	expectedEtag?: string;
	foundEtag?: string;
	loc?: string;
	schemaVersionOk: boolean;
}

function decodeBinaryErrorEnvelope(stdout: string): DecodedBinaryError | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || !isRecord(parsed.error)) return undefined;
	const err = parsed.error;
	const diagnosticCode = stringValue(err.code);
	const message = stringValue(err.message);
	if (diagnosticCode === undefined || message === undefined) return undefined;

	const errorCode = DIAGNOSTIC_TO_ERROR_CODE[diagnosticCode] ?? "E_MD_COMMAND_FAILED";
	const status: "ambiguous" | "failed" =
		diagnosticCode === "duplicate_heading_match" || diagnosticCode === "etag_ambiguous" ? "ambiguous" : "failed";

	const decoded: DecodedBinaryError = {
		diagnosticCode,
		errorCode,
		status,
		message: DIAGNOSTIC_TO_ERROR_CODE[diagnosticCode] !== undefined ? message : `${message} (unmapped md diagnostic: ${diagnosticCode})`,
		schemaVersionOk: parsed.schema_version === MDTOOLS_SCHEMA_VERSION,
	};
	const hint = stringValue(err.hint);
	if (hint !== undefined) decoded.hint = hint;

	const context = err.context;
	if (isRecord(context)) {
		const role = stringValue(context.role);
		if (role === "target" || role === "source" || role === "destination") decoded.role = role;
		const requested = integerValue(context.requested_occurrence, { min: 1 });
		if (requested !== undefined) decoded.requestedOccurrence = requested;
		const total = integerValue(context.total_matches, { min: 0 });
		if (total !== undefined) decoded.totalMatches = total;
		if (Array.isArray(context.matches)) {
			const matches: Array<{ blockIndex: number; occurrence: number; line: number }> = [];
			for (const m of context.matches) {
				if (!isRecord(m)) continue;
				const blockIndex = integerValue(m.block_index, { min: 0 });
				const occurrence = integerValue(m.occurrence, { min: 1 });
				const line = integerValue(m.line, { min: 1 });
				if (blockIndex !== undefined && occurrence !== undefined && line !== undefined) {
					matches.push({ blockIndex, occurrence, line });
				}
			}
			if (matches.length > 0) decoded.matches = matches;
		}
		const expectedEtag = stringValue(context.expected_etag);
		if (expectedEtag !== undefined) decoded.expectedEtag = expectedEtag;
		const foundEtag = stringValue(context.found_etag);
		if (foundEtag !== undefined) decoded.foundEtag = foundEtag;
		const loc = stringValue(context.loc);
		if (loc !== undefined) decoded.loc = loc;
	}
	return decoded;
}

/// The flag the model should pass to disambiguate, given the failed role.
function occurrenceParamForRole(role: "target" | "source" | "destination" | undefined): string {
	if (role === "source") return "sourceOccurrence";
	if (role === "destination") return "destinationOccurrence";
	return "occurrence";
}


function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerValue(value: unknown, options: { min?: number; max?: number } = {}): number | undefined {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined;
	if (options.min !== undefined && value < options.min) return undefined;
	const max = options.max ?? Number.MAX_SAFE_INTEGER;
	if (value > max) return undefined;
	return value;
}

function taskStatusValue(value: unknown): "pending" | "done" | undefined {
	return value === "pending" || value === "done" ? value : undefined;
}

function normalizeMaybeAtPath(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

export function resolveToolPath(cwd: string, path: string): string {
	const normalized = normalizeMaybeAtPath(path);
	if (normalized === "~") return homedir();
	if (normalized.startsWith("~/")) return join(homedir(), normalized.slice(2));
	return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

function commandMeta(_command: string, _file: string | undefined, execution: MdCommandExecution): MdResultEnvelope["meta"] {
	return {
		binary: execution.binary,
		args: execution.args,
		cwd: execution.cwd,
	};
}

function unresolvedMeta(args: string[], cwd: string): MdResultEnvelope["meta"] {
	return { args, cwd };
}

const DEFAULT_NEXT_ACTIONS: Record<MdErrorCode, string> = {
	E_MD_BINARY_MISSING: "Install mdtools so `md` is on PATH, or set MDTOOLS_MD_BIN to the md executable path, then retry.",
	E_MD_COMMAND_ABORTED:
		"The command was aborted mid-flight and the mutation MAY have committed (atomic, never partial). Re-read the file with md_outline or md_tasks before any retry.",
	E_MD_COMMAND_FAILED: "Read error.stderr for the mdtools failure, refresh the structural target with the relevant md_* read tool, then retry.",
	E_MD_JSON_PARSE: "Run /mdtools status to confirm the md binary, then retry or inspect the md command output outside Pi.",
	E_MD_SCHEMA_MISMATCH: "Upgrade mdtools or re-run the matching md_* read tool; the installed md JSON shape did not match pi-mdtools expectations.",
	E_ETAG_MISMATCH: "Re-read md_blocks for current etags, then retry with the fresh expectEtag.",
	E_ETAG_UNAVAILABLE: "Upgrade mdtools to a version whose md blocks --json includes per-block etag fields, or retry without expectEtag if drift safety is not required.",
	E_HEADING_NOT_FOUND: "Run md_outline for the current heading tree, then retry with an exact heading text.",
	E_AMBIGUOUS_HEADING: "Choose one candidates[].occurrence value and retry with occurrence, sourceOccurrence, or destinationOccurrence as appropriate.",
	E_OCCURRENCE_OUT_OF_RANGE: "Choose an occurrence value from candidates[] and retry.",
	E_BAD_LOC: "Run md_tasks for current task locs, choose one candidates[].loc value, then retry md_set_task.",
	E_ETAG_AMBIGUOUS:
		"Multiple identical targets share this etag, so the guard cannot prove identity. Re-query and target one explicitly by occurrence/index, or edit one duplicate first.",
	E_MD_VERSION_UNSUPPORTED:
		"The installed md binary predates the structured error contract. Upgrade mdtools (cargo install --path <mdtools-repo> or reinstall from a release), then retry.",
};

function mdError(
	code: MdErrorCode,
	message: string,
	options: { exitCode?: number | null; stderr?: string; hint?: string; nextAction?: string } = {},
): NonNullable<MdResultEnvelope["error"]> {
	const error: NonNullable<MdResultEnvelope["error"]> = {
		code,
		message,
		nextAction: options.nextAction ?? DEFAULT_NEXT_ACTIONS[code],
	};
	if (options.exitCode !== undefined) error.exitCode = options.exitCode;
	if (options.stderr !== undefined && options.stderr.trim().length > 0) error.stderr = options.stderr;
	if (options.hint !== undefined && options.hint.trim().length > 0) error.hint = options.hint;
	return error;
}

function resultWithError(options: {
	status: "ambiguous" | "failed";
	command: string;
	file?: string;
	meta: MdResultEnvelope["meta"];
	code: MdErrorCode;
	message: string;
	candidates?: MdCandidate[];
	exitCode?: number | null;
	stderr?: string;
	hint?: string;
	nextAction?: string;
}): MdResultEnvelope {
	return {
		status: options.status,
		command: options.command,
		...(options.file !== undefined ? { file: options.file } : {}),
		...(options.candidates !== undefined ? { candidates: options.candidates } : {}),
		error: mdError(options.code, options.message, {
			...(options.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
			...(options.stderr !== undefined ? { stderr: options.stderr } : {}),
			...(options.hint !== undefined ? { hint: options.hint } : {}),
			...(options.nextAction !== undefined ? { nextAction: options.nextAction } : {}),
		}),
		meta: options.meta,
	};
}

function unresolvedResultWithError(options: {
	status: "ambiguous" | "failed";
	command: string;
	file?: string;
	args: string[];
	cwd: string;
	code: MdErrorCode;
	message: string;
	candidates?: MdCandidate[];
	hint?: string;
	nextAction?: string;
}): MdResultEnvelope {
	return resultWithError({
		status: options.status,
		command: options.command,
		...(options.file !== undefined ? { file: options.file } : {}),
		meta: unresolvedMeta(options.args, options.cwd),
		code: options.code,
		message: options.message,
		...(options.candidates !== undefined ? { candidates: options.candidates } : {}),
		...(options.hint !== undefined ? { hint: options.hint } : {}),
		...(options.nextAction !== undefined ? { nextAction: options.nextAction } : {}),
	});
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function expandCandidatePath(path: string, cwd: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return isAbsolute(path) ? path : resolve(cwd, path);
}

async function resolveNamedBinary(name: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string | undefined> {
	if (name.includes("/")) {
		const expanded = expandCandidatePath(name, cwd);
		return (await isExecutable(expanded)) ? expanded : undefined;
	}

	const pathEntries = (env.PATH ?? "").split(delimiter).filter((entry) => entry.length > 0);
	for (const entry of pathEntries) {
		const candidate = join(entry, name);
		if (await isExecutable(candidate)) return candidate;
	}
	return undefined;
}

export async function resolveMdBinary(options: {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	explicit?: string;
}): Promise<MdBinaryResolution> {
	const env = options.env ?? process.env;
	const searched: string[] = [];

	if (options.explicit !== undefined && options.explicit.trim() !== "") {
		const resolved = await resolveNamedBinary(options.explicit.trim(), env, options.cwd);
		searched.push(options.explicit.trim());
		if (resolved !== undefined) return { found: true, path: resolved, source: "explicit", searched };
	}

	for (const envName of [MDTOOLS_ENV_BIN_PRIMARY, MDTOOLS_ENV_BIN]) {
		const envBin = env[envName];
		if (envBin !== undefined && envBin.trim() !== "") {
			const resolved = await resolveNamedBinary(envBin.trim(), env, options.cwd);
			searched.push(envBin.trim());
			if (resolved !== undefined) return { found: true, path: resolved, source: "env", searched };
		}
	}

	const pathEntries = (env.PATH ?? "").split(delimiter).filter((entry) => entry.length > 0);
	for (const entry of pathEntries) {
		const candidate = join(entry, "md");
		searched.push(candidate);
		if (await isExecutable(candidate)) return { found: true, path: candidate, source: "path", searched };
	}

	for (const candidate of unique([join(homedir(), ".cargo/bin/md"), join(homedir(), ".local/bin/md")])) {
		searched.push(candidate);
		if (await isExecutable(candidate)) return { found: true, path: candidate, source: "fallback", searched };
	}

	return { found: false, searched };
}

export const spawnMdCommand: MdCommandRunner = async (request: MdCommandRequest): Promise<MdCommandExecution> => {
	return await new Promise<MdCommandExecution>((resolveExecution) => {
		const child = spawn(request.binary, request.args, {
			cwd: request.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let killReason: "timeout" | "abort" | undefined;
		let hardKillTimeout: NodeJS.Timeout | undefined;

		const terminate = (reason: "timeout" | "abort") => {
			if (killed) return;
			killed = true;
			killReason = reason;
			child.kill("SIGTERM");
			hardKillTimeout = setTimeout(() => {
				child.kill("SIGKILL");
			}, 1_000);
		};

		const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const timeout = setTimeout(() => terminate("timeout"), timeoutMs);

		const abort = () => {
			terminate("abort");
		};

		request.signal?.addEventListener("abort", abort, { once: true });

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		child.on("error", (error) => {
			clearTimeout(timeout);
			if (hardKillTimeout !== undefined) clearTimeout(hardKillTimeout);
			request.signal?.removeEventListener("abort", abort);
			resolveExecution({
				binary: request.binary,
				args: request.args,
				cwd: request.cwd,
				code: null,
				stdout,
				stderr: stderr.length > 0 ? stderr : error.message,
				killed,
			});
		});

		child.on("close", (code) => {
			clearTimeout(timeout);
			if (hardKillTimeout !== undefined) clearTimeout(hardKillTimeout);
			request.signal?.removeEventListener("abort", abort);
			const stderrText = stderr.length > 0 ? stderr : killed && killReason === "abort" ? "Aborted by signal" : killed ? `Timed out after ${timeoutMs}ms` : stderr;
			resolveExecution({
				binary: request.binary,
				args: request.args,
				cwd: request.cwd,
				code,
				stdout,
				stderr: stderrText,
				killed,
			});
		});
	});
};

function errorMessage(execution: MdCommandExecution): string {
	const stderr = execution.stderr.trim();
	if (stderr.length > 0) return stderr.split("\n")[0] ?? stderr;
	if (execution.killed) return "md command timed out or was aborted";
	return `md exited with code ${execution.code ?? "unknown"}`;
}

/// Failure shaping when NO structured envelope is present on stdout. This is
/// the legacy-binary path only: no stderr sniffing, no exit-code guessing —
/// a conflict-class exit on a legacy binary maps to an explicit
/// upgrade-required code rather than a fabricated etag/ambiguity story.
function legacyFailureResult(
	command: string,
	file: string | undefined,
	execution: MdCommandExecution,
	legacyBinary: boolean,
): MdResultEnvelope {
	const code: MdErrorCode = execution.killed
		? "E_MD_COMMAND_ABORTED"
		: legacyBinary && execution.code === 4
			? "E_MD_VERSION_UNSUPPORTED"
			: "E_MD_COMMAND_FAILED";
	return resultWithError({
		status: "failed",
		command,
		...(file !== undefined ? { file } : {}),
		meta: commandMeta(command, file, execution),
		code,
		message: errorMessage(execution),
		exitCode: execution.code,
		...(execution.stderr.trim().length > 0 ? { stderr: execution.stderr } : {}),
	});
}

function parseJsonObject(stdout: string): { ok: true; data: Record<string, unknown> } | { ok: false; message: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "unknown JSON parse error";
		return { ok: false, message };
	}
	if (!isRecord(parsed)) {
		return { ok: false, message: "md returned JSON that was not an object" };
	}
	return { ok: true, data: parsed };
}

/// Pure PROJECTION of md outline entries into candidates: every heading,
/// verbatim, with its section etag. No matching, no case folding — the
/// adapter never decides whether a heading "matches"; that is the binary's
/// job (ADR 0001 extended from parsing to matching).
function headingListingFromOutline(
	data: Record<string, unknown>,
	role: "target" | "source" | "destination",
): MdCandidate[] {
	const entries = data.entries;
	if (!Array.isArray(entries)) return [];
	const candidates: MdCandidate[] = [];
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		const heading = entry.heading;
		if (!isRecord(heading)) continue;
		const text = stringValue(heading.text);
		const blockIndex = integerValue(heading.block_index, { min: 0 });
		if (text === undefined || blockIndex === undefined) continue;
		const level = integerValue(heading.level, { min: 1, max: 6 });
		const etag = stringValue(entry.etag);
		candidates.push({
			role,
			heading: text,
			blockIndex,
			...(level !== undefined ? { level } : {}),
			...(etag !== undefined ? { etag } : {}),
			snippet: `${"#".repeat(level ?? 1)} ${text}`,
		});
	}
	return candidates;
}

function taskCandidateFromEntry(entry: unknown): MdCandidate | undefined {
	if (!isRecord(entry)) return undefined;
	const loc = stringValue(entry.loc);
	const status = taskStatusValue(entry.status);
	if (loc === undefined || status === undefined) return undefined;
	const blockIndex = integerValue(entry.block_index, { min: 0 });
	const taskIndex = integerValue(entry.task_index, { min: 0 });
	const heading = stringValue(entry.nearest_heading);
	const summary = stringValue(entry.summary_text);
	return {
		role: "task",
		loc,
		status,
		...(blockIndex !== undefined ? { blockIndex } : {}),
		...(taskIndex !== undefined ? { taskIndex } : {}),
		...(heading !== undefined ? { heading } : {}),
		...(entry.span !== undefined ? { span: entry.span } : {}),
		...(summary !== undefined && summary.length > 0 ? { snippet: summary } : {}),
	};
}

function taskCandidatesFromData(data: Record<string, unknown>): MdCandidate[] | undefined {
	const results = data.results;
	if (!Array.isArray(results)) return undefined;
	const candidates: MdCandidate[] = [];
	for (const result of results) {
		if (!isRecord(result)) return undefined;
		const tasks = result.tasks;
		if (!Array.isArray(tasks)) return undefined;
		for (const task of tasks) {
			const candidate = taskCandidateFromEntry(task);
			if (candidate === undefined) return undefined;
			candidates.push(candidate);
		}
	}
	return candidates;
}


export class MdtoolsRuntime {
	private readonly cwd: string;
	private readonly binary: string | undefined;
	private readonly env: NodeJS.ProcessEnv;
	private readonly runner: MdCommandRunner;
	private readonly timeoutMs: number;

	constructor(options: RuntimeOptions) {
		this.cwd = options.cwd;
		this.binary = options.binary;
		this.env = options.env ?? process.env;
		this.runner = options.runner ?? spawnMdCommand;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	private handshakePromise: Promise<import("./types.js").MdHandshake> | undefined;

	async status(): Promise<MdtoolsStatus> {
		return {
			binary: await resolveMdBinary({ cwd: this.cwd, env: this.env, ...(this.binary !== undefined ? { explicit: this.binary } : {}) }),
			cwd: this.cwd,
			handshake: await this.handshake(),
		};
	}

	/// One-shot per runtime (the runtime is session-scoped): probe
	/// `md schema --json`. "current" requires the schema version AND the
	/// required capability set; version-match-with-missing-capability is
	/// "legacy".
	async handshake(): Promise<import("./types.js").MdHandshake> {
		this.handshakePromise ??= this.probeHandshake();
		return await this.handshakePromise;
	}

	private async probeHandshake(): Promise<import("./types.js").MdHandshake> {
		const resolution = await resolveMdBinary({ cwd: this.cwd, env: this.env, ...(this.binary !== undefined ? { explicit: this.binary } : {}) });
		if (!resolution.found || resolution.path === undefined) return { verdict: "missing" };
		const execution = await this.runner({
			binary: resolution.path,
			args: ["schema", "--json"],
			cwd: this.cwd,
			timeoutMs: this.timeoutMs,
		});
		if (execution.code !== 0) return { verdict: "legacy" };
		const parsed = parseJsonObject(execution.stdout);
		if (!parsed.ok) return { verdict: "legacy" };
		const schemaVersion = stringValue(parsed.data.schema_version);
		const binaryVersion = stringValue(parsed.data.binary_version);
		const capabilities = Array.isArray(parsed.data.capabilities)
			? parsed.data.capabilities.filter((c): c is string => typeof c === "string")
			: [];
		const current =
			schemaVersion === MDTOOLS_SCHEMA_VERSION && REQUIRED_CAPABILITIES.every((cap) => capabilities.includes(cap));
		return {
			verdict: current ? "current" : "legacy",
			...(binaryVersion !== undefined ? { binaryVersion } : {}),
			...(schemaVersion !== undefined ? { schemaVersion } : {}),
			capabilities,
		};
	}

	async outline(params: OutlineParams, signal?: AbortSignal): Promise<MdResultEnvelope> {
		const file = resolveToolPath(this.cwd, params.file);
		return await this.runJson("md_outline", ["outline", "--json", file], file, signal);
	}

	async section(params: SectionParams, signal?: AbortSignal): Promise<MdResultEnvelope> {
		const file = resolveToolPath(this.cwd, params.file);
		const args = this.sectionArgs(params, file);
		return await this.runJson("md_section", args, file, signal);
	}

	async tasks(params: TasksParams, signal?: AbortSignal): Promise<MdResultEnvelope> {
		const file = resolveToolPath(this.cwd, params.file);
		const args = ["tasks", "--json"];
		if (params.status !== undefined) args.push("--status", params.status);
		args.push(file);
		return await this.runJson("md_tasks", args, file, signal);
	}

	async table(params: TableParams, signal?: AbortSignal): Promise<MdResultEnvelope> {
		const file = resolveToolPath(this.cwd, params.file);
		const args = ["table", "--json"];
		if (params.index !== undefined) args.push("--index", String(params.index));
		if (params.select !== undefined && params.select.trim() !== "") args.push("--select", params.select);
		for (const filter of params.where ?? []) {
			args.push("--where", filter);
		}
		args.push(file);
		return await this.runJson("md_table", args, file, signal);
	}

	async blocks(params: BlocksParams, signal?: AbortSignal): Promise<MdResultEnvelope> {
		const file = resolveToolPath(this.cwd, params.file);
		return await this.runJson("md_blocks", ["blocks", "--json", file], file, signal);
	}

	async block(params: BlockParams, signal?: AbortSignal): Promise<MdResultEnvelope> {
		const file = resolveToolPath(this.cwd, params.file);
		return await this.runJson("md_block", ["block", "--json", String(params.index), file], file, signal);
	}

	async setTask(params: SetTaskParams, signal?: AbortSignal): Promise<MdResultEnvelope> {
		const file = resolveToolPath(this.cwd, params.file);
		const args = ["set-task", "--json", "--status", params.status, "-i"];
		if (params.expectEtag !== undefined) args.push("--expect-etag", params.expectEtag);
		args.push(params.loc, file);
		return await this.runJson("md_set_task", args, file, signal);
	}

	async moveSection(params: MoveSectionParams, signal?: AbortSignal): Promise<MdResultEnvelope> {
		const file = resolveToolPath(this.cwd, params.file);
		const args = this.moveSectionArgs(params, file);
		return await this.runJson("md_move_section", args, file, signal);
	}

	async replaceSection(params: ReplaceSectionParams, signal?: AbortSignal): Promise<MdResultEnvelope> {
		const file = resolveToolPath(this.cwd, params.file);
		// expectEtag passes straight through to the binary's --expect-etag:
		// a real section-span guard verified in-process by md (atomic with
		// the splice), replacing the old TS heading-block compare that was
		// both weaker (heading line only) and racy (separate process).
		const tempDir = await mkdtemp(join(tmpdir(), "pi-mdtools-"));
		const contentPath = join(tempDir, "section.md");
		try {
			await writeFile(contentPath, params.content, "utf8");
			if (signal?.aborted) {
				return unresolvedResultWithError({
					status: "failed",
					command: "md_replace_section",
					file,
					args: [],
					cwd: this.cwd,
					code: "E_MD_COMMAND_ABORTED",
					message: "Aborted before the md command started; the file is untouched.",
				});
			}
			const realArgs = this.replaceSectionArgs(params, file, contentPath);
			return await this.runJson("md_replace_section", realArgs, file, signal);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	}

	private sectionArgs(params: SectionParams, file: string): string[] {
		const args = ["section", "--json"];
		if (params.ignoreCase === true) args.push("--ignore-case");
		if (params.occurrence !== undefined) args.push("--occurrence", String(params.occurrence));
		args.push(params.heading, file);
		return args;
	}

	private moveSectionArgs(params: MoveSectionParams, file: string): string[] {
		const args = ["move-section", "--json", "-i"];
		if (params.ignoreCase === true) args.push("--ignore-case");
		if (params.sourceOccurrence !== undefined) args.push("--source-occurrence", String(params.sourceOccurrence));
		if (params.destinationOccurrence !== undefined) args.push("--dest-occurrence", String(params.destinationOccurrence));
		if (params.leveling === "keep") args.push("--keep-level");
		else args.push("--auto-level");
		args.push(`--${params.placement}`, params.destination, params.source, file);
		return args;
	}

	private replaceSectionArgs(params: ReplaceSectionParams, file: string, contentPath: string): string[] {
		const args = ["replace-section", "--json", "-i", "--from", contentPath];
		if (params.ignoreCase === true) args.push("--ignore-case");
		if (params.occurrence !== undefined) args.push("--occurrence", String(params.occurrence));
		if (params.expectEtag !== undefined) args.push("--expect-etag", params.expectEtag);
		args.push(params.heading, file);
		return args;
	}

	/// Best-effort structural read for failure-candidate enrichment. Raw
	/// runner + parse; any failure returns undefined (never recursive, never
	/// masks the original error).
	private async tryReadJson(args: string[], signal: AbortSignal | undefined): Promise<Record<string, unknown> | undefined> {
		if (signal?.aborted) return undefined;
		const resolution = await resolveMdBinary({ cwd: this.cwd, env: this.env, ...(this.binary !== undefined ? { explicit: this.binary } : {}) });
		if (!resolution.found || resolution.path === undefined) return undefined;
		const execution = await this.runner({
			binary: resolution.path,
			args,
			cwd: this.cwd,
			timeoutMs: this.timeoutMs,
			...(signal !== undefined ? { signal } : {}),
		});
		if (execution.killed || execution.code !== 0) return undefined;
		const parsed = parseJsonObject(execution.stdout);
		return parsed.ok ? parsed.data : undefined;
	}

	private async runJson(
		command: string,
		args: string[],
		file: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<MdResultEnvelope> {
		const outcome = await this.runJsonData(command, args, file, signal);
		if (!outcome.ok) return outcome.result;
		return {
			status: "ok",
			command,
			...(file !== undefined ? { file } : {}),
			data: outcome.data,
			meta: commandMeta(command, file, outcome.execution),
		};
	}

	private async runJsonData(
		command: string,
		args: string[],
		file: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<RunJsonOutcome> {
		const resolution = await resolveMdBinary({ cwd: this.cwd, env: this.env, ...(this.binary !== undefined ? { explicit: this.binary } : {}) });
		if (!resolution.found || resolution.path === undefined) {
			return {
				ok: false,
				result: unresolvedResultWithError({
					status: "failed",
					command,
					...(file !== undefined ? { file } : {}),
					args,
					cwd: this.cwd,
					code: "E_MD_BINARY_MISSING",
					message: "mdtools binary not found.",
					hint: "Install mdtools so `md` is on PATH, or set MDTOOLS_MD_BIN to the md executable path.",
				}),
			};
		}

		const execution = await this.runner({
			binary: resolution.path,
			args,
			cwd: this.cwd,
			timeoutMs: this.timeoutMs,
			...(signal !== undefined ? { signal } : {}),
		});
		if (execution.killed || execution.code !== 0) {
			return { ok: false, result: await this.failureResult(command, file, execution, signal) };
		}

		const parsed = parseJsonObject(execution.stdout);
		if (!parsed.ok) {
			return {
				ok: false,
				result: resultWithError({
					status: "failed",
					command,
					...(file !== undefined ? { file } : {}),
					meta: commandMeta(command, file, execution),
					code: "E_MD_JSON_PARSE",
					message: `Failed to parse md JSON output: ${parsed.message}`,
				}),
			};
		}

		// Version-gate the boundary before any field decode: the one token
		// designed to fail fast on a shape change must actually be read.
		const schemaVersion = parsed.data.schema_version;
		if (schemaVersion !== MDTOOLS_SCHEMA_VERSION) {
			return {
				ok: false,
				result: resultWithError({
					status: "failed",
					command,
					...(file !== undefined ? { file } : {}),
					meta: commandMeta(command, file, execution),
					code: "E_MD_SCHEMA_MISMATCH",
					message: `md returned schema_version ${JSON.stringify(schemaVersion ?? null)}; pi-mdtools requires ${MDTOOLS_SCHEMA_VERSION}.`,
				}),
			};
		}

		return { ok: true, data: parsed.data, execution };
	}

	/// Shape a nonzero-exit execution into the recovery envelope. The
	/// binary's structured error envelope is authoritative; the adapter only
	/// projects it (and enriches candidates with best-effort listings). No
	/// envelope means abort, or a legacy binary.
	private async failureResult(
		command: string,
		file: string | undefined,
		execution: MdCommandExecution,
		signal: AbortSignal | undefined,
	): Promise<MdResultEnvelope> {
		if (execution.killed) {
			return legacyFailureResult(command, file, execution, false);
		}
		const decoded = decodeBinaryErrorEnvelope(execution.stdout);
		if (decoded === undefined) {
			const handshake = await this.handshake();
			return legacyFailureResult(command, file, execution, handshake.verdict !== "current");
		}
		if (!decoded.schemaVersionOk) {
			return resultWithError({
				status: "failed",
				command,
				...(file !== undefined ? { file } : {}),
				meta: commandMeta(command, file, execution),
				code: "E_MD_SCHEMA_MISMATCH",
				message: `md error envelope carried an unexpected schema_version; pi-mdtools requires ${MDTOOLS_SCHEMA_VERSION}.`,
				exitCode: execution.code,
			});
		}

		const role = decoded.role ?? "target";
		let candidates: MdCandidate[] | undefined;
		if (decoded.matches !== undefined) {
			candidates = decoded.matches.map((m) => ({
				role,
				occurrence: m.occurrence,
				blockIndex: m.blockIndex,
				line: m.line,
			}));
		} else if (decoded.errorCode === "E_HEADING_NOT_FOUND" && file !== undefined) {
			const outline = await this.tryReadJson(["outline", "--json", file], signal);
			if (outline !== undefined) candidates = headingListingFromOutline(outline, role);
		} else if (decoded.errorCode === "E_BAD_LOC" && file !== undefined) {
			const tasks = await this.tryReadJson(["tasks", "--json", file], signal);
			if (tasks !== undefined) {
				const taskCandidates = taskCandidatesFromData(tasks);
				if (taskCandidates !== undefined) candidates = taskCandidates;
			}
		}

		const occurrenceParam = occurrenceParamForRole(decoded.role);
		let nextAction: string | undefined;
		if (decoded.errorCode === "E_AMBIGUOUS_HEADING" || decoded.errorCode === "E_OCCURRENCE_OUT_OF_RANGE") {
			nextAction = `Choose one candidates[].occurrence value and retry with ${occurrenceParam}.`;
		}

		return resultWithError({
			status: decoded.status,
			command,
			...(file !== undefined ? { file } : {}),
			meta: commandMeta(command, file, execution),
			code: decoded.errorCode,
			message: decoded.message,
			exitCode: execution.code,
			...(candidates !== undefined && candidates.length > 0 ? { candidates } : {}),
			...(execution.stderr.trim().length > 0 ? { stderr: execution.stderr } : {}),
			...(decoded.hint !== undefined ? { hint: decoded.hint } : {}),
			...(nextAction !== undefined ? { nextAction } : {}),
		});
	}
}
