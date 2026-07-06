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

interface HeadingCandidate extends MdCandidate {
	heading: string;
	occurrence: number;
	blockIndex: number;
}

interface HeadingLookupSuccess {
	ok: true;
	candidates: HeadingCandidate[];
}

interface HeadingLookupFailure {
	ok: false;
	result: MdResultEnvelope;
}

type HeadingLookupOutcome = HeadingLookupSuccess | HeadingLookupFailure;

interface HeadingSearchContext {
	entries: unknown[];
	etagByBlock: Map<number, string>;
}

interface HeadingContextSuccess {
	ok: true;
	context: HeadingSearchContext;
}

type HeadingContextOutcome = HeadingContextSuccess | HeadingLookupFailure;

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

	const envBin = env[MDTOOLS_ENV_BIN];
	if (envBin !== undefined && envBin.trim() !== "") {
		const resolved = await resolveNamedBinary(envBin.trim(), env, options.cwd);
		searched.push(envBin.trim());
		if (resolved !== undefined) return { found: true, path: resolved, source: "env", searched };
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

function classifyFailureStatus(stderr: string): "ambiguous" | "failed" {
	const normalized = stderr.toLowerCase();
	if (normalized.includes("ambiguous") || normalized.includes("multiple") || normalized.includes("more than one")) {
		return "ambiguous";
	}
	return "failed";
}

function errorMessage(execution: MdCommandExecution): string {
	const stderr = execution.stderr.trim();
	if (stderr.length > 0) return stderr.split("\n")[0] ?? stderr;
	if (execution.killed) return "md command timed out or was aborted";
	return `md exited with code ${execution.code ?? "unknown"}`;
}

function resultFromExecutionFailure(command: string, file: string | undefined, execution: MdCommandExecution): MdResultEnvelope {
	const status = classifyFailureStatus(execution.stderr);
	const error: MdResultEnvelope["error"] = {
		message: errorMessage(execution),
		exitCode: execution.code,
	};
	if (execution.stderr.trim().length > 0) error.stderr = execution.stderr;
	if (execution.code === 4) {
		error.hint = "Re-read the target with md_blocks or md_block to refresh current indices and etags, then retry.";
	}
	return {
		status,
		command,
		...(file !== undefined ? { file } : {}),
		error,
		meta: commandMeta(command, file, execution),
	};
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

function headingMatches(actual: string, expected: string, ignoreCase: boolean | undefined): boolean {
	return ignoreCase === true ? actual.toLocaleLowerCase() === expected.toLocaleLowerCase() : actual === expected;
}

function headingCandidateFromEntry(
	entry: unknown,
	searchedHeading: string,
	ignoreCase: boolean | undefined,
	occurrence: number,
	etagByBlock: Map<number, string>,
): HeadingCandidate | undefined {
	if (!isRecord(entry)) return undefined;
	const heading = entry.heading;
	if (!isRecord(heading)) return undefined;
	const text = stringValue(heading.text);
	const blockIndex = integerValue(heading.block_index, { min: 0 });
	if (text === undefined || blockIndex === undefined) return undefined;
	if (!headingMatches(text, searchedHeading, ignoreCase)) return undefined;
	const level = integerValue(heading.level, { min: 1, max: 6 });
	const etag = etagByBlock.get(blockIndex);
	return {
		role: "target",
		heading: text,
		occurrence,
		blockIndex,
		...(level !== undefined ? { level } : {}),
		...(etag !== undefined ? { etag } : {}),
		...(heading.span !== undefined ? { span: heading.span } : {}),
		snippet: `${"#".repeat(level ?? 1)} ${text}`,
	};
}

function extractBlockEtags(blocksData: Record<string, unknown>): Map<number, string> {
	const etags = new Map<number, string>();
	const blocks = blocksData.blocks;
	if (!Array.isArray(blocks)) return etags;
	for (const block of blocks) {
		if (!isRecord(block)) continue;
		const index = integerValue(block.index, { min: 0 });
		const etag = stringValue(block.etag);
		if (index !== undefined && etag !== undefined) etags.set(index, etag);
	}
	return etags;
}

function selectCandidate(
	candidates: HeadingCandidate[],
	occurrence: number | undefined,
	command: string,
	file: string,
	args: string[],
	cwd: string,
	role: "source" | "destination" | "target" = "target",
): { ok: true; candidate: HeadingCandidate } | { ok: false; result: MdResultEnvelope } {
	const withRole = candidates.map((candidate) => ({ ...candidate, role }));
	if (candidates.length === 0) {
		return {
			ok: false,
			result: {
				status: "failed",
				command,
				file,
				error: { message: `No ${role} heading matched.` },
				meta: unresolvedMeta(args, cwd),
			},
		};
	}
	if (occurrence === undefined && candidates.length > 1) {
		return {
			ok: false,
			result: {
				status: "ambiguous",
				command,
				file,
				candidates: withRole,
				error: { message: `Multiple ${role} headings matched; pass ${role === "target" ? "occurrence" : `${role}Occurrence`}.` },
				meta: unresolvedMeta(args, cwd),
			},
		};
	}
	const selectedOccurrence = occurrence ?? 1;
	const candidate = candidates[selectedOccurrence - 1];
	if (candidate === undefined) {
		return {
			ok: false,
			result: {
				status: "failed",
				command,
				file,
				candidates: withRole,
				error: { message: `${role} occurrence ${selectedOccurrence} is out of range.` },
				meta: unresolvedMeta(args, cwd),
			},
		};
	}
	return { ok: true, candidate: { ...candidate, role } };
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

	async status(): Promise<MdtoolsStatus> {
		return {
			binary: await resolveMdBinary({ cwd: this.cwd, env: this.env, ...(this.binary !== undefined ? { explicit: this.binary } : {}) }),
			cwd: this.cwd,
		};
	}

	async outline(params: OutlineParams, signal?: AbortSignal): Promise<MdResultEnvelope> {
		const file = resolveToolPath(this.cwd, params.file);
		return await this.runJson("md_outline", ["outline", "--json", file], file, signal);
	}

	async section(params: SectionParams, signal?: AbortSignal): Promise<MdResultEnvelope> {
		const file = resolveToolPath(this.cwd, params.file);
		const args = this.sectionArgs(params, file);
		const candidates = await this.findHeadingCandidates("md_section", file, params.heading, params.ignoreCase, args, signal, true);
		if (!candidates.ok) return candidates.result;
		const selected = selectCandidate(candidates.candidates, params.occurrence, "md_section", file, args, this.cwd);
		if (!selected.ok) return selected.result;
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
		const args = ["set-task", "--json", "--status", params.status, "-i", params.loc, file];
		return await this.runJson("md_set_task", args, file, signal);
	}

	async moveSection(params: MoveSectionParams, signal?: AbortSignal): Promise<MdResultEnvelope> {
		const file = resolveToolPath(this.cwd, params.file);
		const args = this.moveSectionArgs(params, file);
		const headingContext = await this.loadHeadingSearchContext("md_move_section", file, args, signal, true);
		if (!headingContext.ok) return headingContext.result;

		const selectedSource = selectCandidate(
			this.headingCandidatesFromContext(headingContext.context, params.source, params.ignoreCase),
			params.sourceOccurrence,
			"md_move_section",
			file,
			args,
			this.cwd,
			"source",
		);
		if (!selectedSource.ok) return selectedSource.result;

		const selectedDestination = selectCandidate(
			this.headingCandidatesFromContext(headingContext.context, params.destination, params.ignoreCase),
			params.destinationOccurrence,
			"md_move_section",
			file,
			args,
			this.cwd,
			"destination",
		);
		if (!selectedDestination.ok) return selectedDestination.result;

		return await this.runJson("md_move_section", args, file, signal);
	}

	async replaceSection(params: ReplaceSectionParams, signal?: AbortSignal): Promise<MdResultEnvelope> {
		const file = resolveToolPath(this.cwd, params.file);
		const args = this.replaceSectionArgs(params, file, "<tempfile>");
		const candidates = await this.findHeadingCandidates("md_replace_section", file, params.heading, params.ignoreCase, args, signal, true);
		if (!candidates.ok) return candidates.result;
		const selected = selectCandidate(candidates.candidates, params.occurrence, "md_replace_section", file, args, this.cwd);
		if (!selected.ok) return selected.result;

		if (params.expectEtag !== undefined) {
			if (selected.candidate.etag === undefined) {
				return {
					status: "failed",
					command: "md_replace_section",
					file,
					candidates: [selected.candidate],
					error: {
						message: "Cannot verify expectEtag because md_blocks did not return etags.",
						hint: "Upgrade mdtools to a version whose md blocks --json includes per-block etag fields.",
					},
					meta: unresolvedMeta(args, this.cwd),
				};
			}
			if (selected.candidate.etag !== params.expectEtag) {
				return {
					status: "failed",
					command: "md_replace_section",
					file,
					candidates: [selected.candidate],
					error: {
						message: `Heading block etag mismatch: expected ${params.expectEtag}, found ${selected.candidate.etag}.`,
						hint: "Re-read md_blocks for current etags, then retry with the fresh expectEtag.",
					},
					meta: unresolvedMeta(args, this.cwd),
				};
			}
		}

		const tempDir = await mkdtemp(join(tmpdir(), "pi-mdtools-"));
		const contentPath = join(tempDir, "section.md");
		try {
			await writeFile(contentPath, params.content, "utf8");
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
		args.push(params.heading, file);
		return args;
	}

	private async findHeadingCandidates(
		command: string,
		file: string,
		heading: string,
		ignoreCase: boolean | undefined,
		originalArgs: string[],
		signal: AbortSignal | undefined,
		includeEtags: boolean,
	): Promise<HeadingLookupOutcome> {
		const context = await this.loadHeadingSearchContext(command, file, originalArgs, signal, includeEtags);
		if (!context.ok) return context;
		return { ok: true, candidates: this.headingCandidatesFromContext(context.context, heading, ignoreCase) };
	}

	private async loadHeadingSearchContext(
		command: string,
		file: string,
		originalArgs: string[],
		signal: AbortSignal | undefined,
		includeEtags: boolean,
	): Promise<HeadingContextOutcome> {
		const outline = await this.runJsonData("md_outline", ["outline", "--json", file], file, signal);
		if (!outline.ok) return { ok: false, result: { ...outline.result, command, meta: unresolvedMeta(originalArgs, this.cwd) } };

		let etagByBlock = new Map<number, string>();
		if (includeEtags) {
			const blocks = await this.runJsonData("md_blocks", ["blocks", "--json", file], file, signal);
			if (blocks.ok) etagByBlock = extractBlockEtags(blocks.data);
		}

		const entries = outline.data.entries;
		if (!Array.isArray(entries)) {
			return {
				ok: false,
				result: {
					status: "failed",
					command,
					file,
					error: { message: "md outline JSON did not contain an entries array." },
					meta: unresolvedMeta(originalArgs, this.cwd),
				},
			};
		}

		return { ok: true, context: { entries, etagByBlock } };
	}

	private headingCandidatesFromContext(
		context: HeadingSearchContext,
		heading: string,
		ignoreCase: boolean | undefined,
	): HeadingCandidate[] {
		const candidates: HeadingCandidate[] = [];
		let occurrence = 1;
		for (const entry of context.entries) {
			const candidate = headingCandidateFromEntry(entry, heading, ignoreCase, occurrence, context.etagByBlock);
			if (candidate !== undefined) {
				candidates.push(candidate);
				occurrence += 1;
			}
		}
		return candidates;
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
				result: {
					status: "failed",
					command,
					...(file !== undefined ? { file } : {}),
					error: {
						message: "mdtools binary not found.",
						hint: "Install mdtools so `md` is on PATH, or set MDTOOLS_MD_BIN to the md executable path.",
					},
					meta: unresolvedMeta(args, this.cwd),
				},
			};
		}

		const execution = await this.runner({
			binary: resolution.path,
			args,
			cwd: this.cwd,
			timeoutMs: this.timeoutMs,
			...(signal !== undefined ? { signal } : {}),
		});
		if (execution.killed) {
			return { ok: false, result: resultFromExecutionFailure(command, file, execution) };
		}
		if (execution.code !== 0) {
			return { ok: false, result: resultFromExecutionFailure(command, file, execution) };
		}

		const parsed = parseJsonObject(execution.stdout);
		if (!parsed.ok) {
			return {
				ok: false,
				result: {
					status: "failed",
					command,
					...(file !== undefined ? { file } : {}),
					error: { message: `Failed to parse md JSON output: ${parsed.message}` },
					meta: commandMeta(command, file, execution),
				},
			};
		}

		return { ok: true, data: parsed.data, execution };
	}
}
