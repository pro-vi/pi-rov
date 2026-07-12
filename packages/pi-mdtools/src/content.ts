import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";

import type { MdResultEnvelope } from "./types.js";

export interface PiTextToolResult<TDetails> {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails;
}

export async function renderMdToolResult(envelope: MdResultEnvelope): Promise<PiTextToolResult<MdResultEnvelope>> {
	const initialText = JSON.stringify(envelope, null, 2);
	const truncation = truncateHead(initialText, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	if (!truncation.truncated) {
		return {
			content: [{ type: "text", text: initialText }],
			details: envelope,
		};
	}

	const tempDir = await mkdtemp(join(tmpdir(), "pi-mdtools-result-"));
	const fullOutputPath = join(tempDir, "result.json");
	await writeFile(fullOutputPath, initialText, "utf8");

	const truncatedEnvelope: MdResultEnvelope = {
		...envelope,
		meta: {
			...envelope.meta,
			truncated: true,
			fullOutputPath,
		},
	};
	const truncatedText = truncateHead(JSON.stringify(truncatedEnvelope, null, 2), {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	const notice = [
		`[mdtools result truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`,
		`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`,
		`Full JSON saved to: ${fullOutputPath}]`,
	].join(" ");

	return {
		content: [{ type: "text", text: `${truncatedText.content}\n\n${notice}` }],
		details: truncatedEnvelope,
	};
}

export function formatStatus(status: { binary: { found: boolean; path?: string; source?: string; searched: string[] }; cwd: string }): string {
	if (status.binary.found) {
		return [
			"mdtools for Pi",
			`status: ready`,
			`binary: ${status.binary.path ?? "unknown"}`,
			`source: ${status.binary.source ?? "unknown"}`,
			`cwd: ${status.cwd}`,
		].join("\n");
	}
	return [
		"mdtools for Pi",
		"status: md binary not found",
		"install: cargo install mdtools, ensure `md` is on PATH, or set MDTOOLS_MD_BIN=/path/to/md",
		`searched: ${status.binary.searched.join(", ") || "none"}`,
		`cwd: ${status.cwd}`,
	].join("\n");
}

export function helpText(): string {
	return [
		"mdtools for Pi exposes the Rust md binary as typed structural Markdown tools.",
		"",
		"Tools:",
		"- md_outline(file)",
		"- md_section(file, heading, occurrence?, ignoreCase?)",
		"- md_tasks(file, status?)",
		"- md_table(file, index?, select?, where?)",
		"- md_blocks(file)",
		"- md_block(file, index)",
		"- md_set_task(file, loc, status)",
		"- md_move_section(file, source, destination, placement)",
		"- md_replace_section(file, heading, content, expectEtag?)",
		"",
		"Recovery contract:",
		"- failed/ambiguous results include error.code and error.nextAction",
		"- ambiguous heading targets include candidates[]; retry with occurrence/sourceOccurrence/destinationOccurrence",
		"- stale task locs include current task candidates[]; retry md_set_task with a fresh loc from md_tasks",
		"- stale expectEtag values fail closed; re-run md_blocks and retry with the fresh etag",
		"",
		"Commands:",
		"/mdtools status",
		"/mdtools help",
	].join("\n");
}
