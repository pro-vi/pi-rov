import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/// pi-mdtools usage instrumentation: one JSONL line per md_* tool call.
///
/// The schema is CONSUMER-GENERIC by contract: no bench task IDs, modes, or
/// scorer vocabulary, ever — a downstream adapter owns domain mapping (the
/// pi_audit_adapter.py pattern). Privacy: no document content, no headings,
/// no paths; files appear only as an 8-char hash of the basename.
///
/// Default sink: ~/.local/share/pi-mdtools/usage.jsonl
/// Override with PI_MDTOOLS_USAGE_LOG=/path; disable with PI_MDTOOLS_USAGE_LOG="".

export const USAGE_SCHEMA = "pi-mdtools-usage.v1";
export const USAGE_LOG_ENV = "PI_MDTOOLS_USAGE_LOG";

/// Static per-tool classification — tool identity, not string parsing.
export const TOOL_KIND: Record<string, "query" | "mutation"> = {
	md_outline: "query",
	md_section: "query",
	md_tasks: "query",
	md_table: "query",
	md_blocks: "query",
	md_block: "query",
	md_set_task: "mutation",
	md_move_section: "mutation",
	md_replace_section: "mutation",
};

export interface UsageLine {
	schema: typeof USAGE_SCHEMA;
	ts: string;
	tool: string;
	kind: "query" | "mutation";
	ok: boolean;
	errorCode?: string;
	/// An etag expectation was ATTEMPTED (derived from validated tool input:
	/// stale-etag failures produce no MutationResult to read it from).
	guarded: boolean;
	/// Query on a file previously mutated in this session (the re-query
	/// pattern the tool is designed around).
	requeried: boolean;
	durationMs: number;
	outputBytes: number;
	fileHash?: string;
}

export function hashFileRef(filePath: string | undefined): string | undefined {
	if (filePath === undefined) return undefined;
	return createHash("sha256").update(basename(filePath)).digest("hex").slice(0, 8);
}

export function usageLogPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const override = env[USAGE_LOG_ENV];
	if (override !== undefined) {
		const trimmed = override.trim();
		return trimmed === "" ? undefined : trimmed;
	}
	return join(homedir(), ".local/share/pi-mdtools/usage.jsonl");
}

/// Session-lived tracker for the re-query signal.
export class UsageTracker {
	private readonly mutatedFiles = new Set<string>();

	buildLine(input: {
		tool: string;
		file?: string;
		guarded: boolean;
		ok: boolean;
		errorCode?: string;
		durationMs: number;
		outputBytes: number;
		now?: Date;
	}): UsageLine {
		const kind = TOOL_KIND[input.tool] ?? "query";
		const fileHash = hashFileRef(input.file);
		const requeried = kind === "query" && fileHash !== undefined && this.mutatedFiles.has(fileHash);
		if (kind === "mutation" && input.ok && fileHash !== undefined) {
			this.mutatedFiles.add(fileHash);
		}
		return {
			schema: USAGE_SCHEMA,
			ts: (input.now ?? new Date()).toISOString(),
			tool: input.tool,
			kind,
			ok: input.ok,
			...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
			guarded: input.guarded,
			requeried,
			durationMs: Math.round(input.durationMs),
			outputBytes: input.outputBytes,
			...(fileHash !== undefined ? { fileHash } : {}),
		};
	}

	/// Fire-and-forget append; failures are swallowed (instrumentation must
	/// never affect the tool call).
	record(line: UsageLine, env: NodeJS.ProcessEnv = process.env): void {
		const path = usageLogPath(env);
		if (path === undefined) return;
		void (async () => {
			await mkdir(dirname(path), { recursive: true });
			await appendFile(path, `${JSON.stringify(line)}\n`, "utf8");
		})().catch(() => {});
	}
}
