import { appendFile, mkdir, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/// pi-mdtools usage instrumentation: one JSONL line per md_* tool call.
///
/// The schema is CONSUMER-GENERIC by contract: no bench task IDs, modes, or
/// scorer vocabulary, ever — a downstream adapter owns domain mapping (the
/// pi_audit_adapter.py pattern). Privacy: no document content, no headings,
/// no paths; files appear only as an 8-char hash of the resolved path.
///
/// Default sink: ~/.local/share/pi-mdtools/usage.jsonl
/// Override with PI_MDTOOLS_USAGE_LOG=/path; disable with PI_MDTOOLS_USAGE_LOG="".

export const USAGE_SCHEMA = "pi-mdtools-usage.v1";

/// Session provenance: one opaque id per extension process, so lines from
/// the same session can be grouped without leaking anything.
export const SESSION_ID = randomUUID();
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
	session: string;
	tool: string;
	kind: "query" | "mutation";
	ok: boolean;
	errorCode?: string;
	/// An etag expectation was ATTEMPTED (derived from validated tool input:
	/// stale-etag failures produce no MutationResult to read it from).
	guarded: boolean;
	/// Cross-check from a successful MutationResult.guarded, when present.
	guardedResult?: boolean;
	/// Query on a file previously mutated in this session (the re-query
	/// pattern the tool is designed around).
	requeried: boolean;
	durationMs: number;
	outputBytes: number;
	fileHash?: string;
}

/// Hash of the RESOLVED path (not just basename): distinct files with the
/// same name never collide, and the emitted value still leaks no path text.
export function hashFileRef(resolvedPath: string | undefined): string | undefined {
	if (resolvedPath === undefined) return undefined;
	return createHash("sha256").update(resolvedPath).digest("hex").slice(0, 8);
}

/// Canonical file identity for tracking: symlink and referent are the SAME
/// document (the md binary canonicalizes before mutating), so telemetry must
/// agree. Falls back to the lexical path when realpath fails (missing file).
export async function fileIdentity(lexicalPath: string | undefined): Promise<string | undefined> {
	if (lexicalPath === undefined) return undefined;
	try {
		return await realpath(lexicalPath);
	} catch {
		return lexicalPath;
	}
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
		/// RESOLVED absolute path; identity is tracked on this in memory only,
		/// and the emitted line carries just its hash.
		resolvedPath?: string;
		guarded: boolean;
		guardedResult?: boolean;
		ok: boolean;
		errorCode?: string;
		durationMs: number;
		outputBytes: number;
		now?: Date;
	}): UsageLine {
		const kind = TOOL_KIND[input.tool] ?? "query";
		const requeried =
			kind === "query" && input.resolvedPath !== undefined && this.mutatedFiles.has(input.resolvedPath);
		if (kind === "mutation" && input.ok && input.resolvedPath !== undefined) {
			this.mutatedFiles.add(input.resolvedPath);
		}
		const fileHash = hashFileRef(input.resolvedPath);
		return {
			schema: USAGE_SCHEMA,
			ts: (input.now ?? new Date()).toISOString(),
			session: SESSION_ID,
			tool: input.tool,
			kind,
			ok: input.ok,
			...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
			guarded: input.guarded,
			...(input.guardedResult !== undefined ? { guardedResult: input.guardedResult } : {}),
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
