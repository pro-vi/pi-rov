import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { formatStatus, helpText, renderMdToolResult } from "./src/content.js";
import { MD_TOOL_PROMPTS } from "./src/prompts.js";
import { MdtoolsRuntime, resolveToolPath } from "./src/runtime.js";
import type { MdResultEnvelope } from "./src/types.js";
import { UsageTracker, fileIdentity } from "./src/usage.js";

// Session-lived usage instrumentation (consumer-generic schema; see usage.ts).
const usageTracker = new UsageTracker();

function mutationGuardedResult(envelope: MdResultEnvelope): boolean | undefined {
	if (envelope.status !== "ok") return undefined;
	const data: unknown = envelope.data;
	if (typeof data !== "object" || data === null || !("guarded" in data)) return undefined;
	const guarded = (data as { guarded: unknown }).guarded;
	return typeof guarded === "boolean" ? guarded : undefined;
}

async function tracked(
	tool: string,
	cwd: string,
	params: { file?: string; expectEtag?: string },
	run: () => Promise<MdResultEnvelope>,
): Promise<Awaited<ReturnType<typeof renderMdToolResult>>> {
	const start = performance.now();
	const envelope = await run();
	const rendered = await renderMdToolResult(envelope);
	const resolvedPath = await fileIdentity(params.file !== undefined ? resolveToolPath(cwd, params.file) : undefined);
	const guardedResult = mutationGuardedResult(envelope);
	usageTracker.record(
		usageTracker.buildLine({
			tool,
			...(resolvedPath !== undefined ? { resolvedPath } : {}),
			guarded: params.expectEtag !== undefined,
			...(guardedResult !== undefined ? { guardedResult } : {}),
			ok: envelope.status === "ok",
			...(envelope.status !== "ok" && envelope.error !== undefined ? { errorCode: envelope.error.code } : {}),
			durationMs: performance.now() - start,
			outputBytes: rendered.content[0]?.text.length ?? 0,
		}),
	);
	return rendered;
}

const COMMANDS = ["status", "help"];

const MarkdownFile = Type.String({
	description: "Markdown file path. Relative paths resolve from the current Pi working directory; a leading @ is ignored.",
});

const Heading = Type.String({ description: "Exact Markdown heading text to match." });
const Occurrence = Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed occurrence for duplicate headings." }));
const IgnoreCase = Type.Optional(Type.Boolean({ description: "Match headings case-insensitively." }));
const TaskStatusSchema = StringEnum(["pending", "done"] as const);
const MovePlacementSchema = StringEnum(["after", "before", "into"] as const);
const SectionLevelingSchema = StringEnum(["auto", "keep"] as const);

const OutlineParams = Type.Object({
	file: MarkdownFile,
});

const SectionParams = Type.Object({
	file: MarkdownFile,
	heading: Heading,
	occurrence: Occurrence,
	ignoreCase: IgnoreCase,
});

const TasksParams = Type.Object({
	file: MarkdownFile,
	status: Type.Optional(TaskStatusSchema),
});

const TableParams = Type.Object({
	file: MarkdownFile,
	index: Type.Optional(Type.Integer({ minimum: 0, description: "Block index of the table from md_blocks." })),
	select: Type.Optional(Type.String({ description: "Comma-separated column names or 0-based indices to project." })),
	where: Type.Optional(
		Type.Array(Type.String({ description: "Row filter such as col=val, col!=val, or col~=substr." }), {
			description: "Repeatable table row filters.",
		}),
	),
});

const BlocksParams = Type.Object({
	file: MarkdownFile,
});

const BlockParams = Type.Object({
	file: MarkdownFile,
	index: Type.Integer({ minimum: 0, description: "Block index from md_blocks." }),
});

const SetTaskParams = Type.Object({
	file: MarkdownFile,
	loc: Type.String({ description: "Task location from md_tasks output, e.g. 9.0 or 14.4.0." }),
	status: TaskStatusSchema,
	expectEtag: Type.Optional(
		Type.String({
			description:
				"Optional task etag from md_tasks (.tasks[].etag). The md binary verifies it in-process and fails closed if the task line changed since the read, or if identical duplicate tasks make the etag ambiguous.",
		}),
	),
});

const MoveSectionParams = Type.Object({
	file: MarkdownFile,
	source: Type.String({ description: "Source heading text." }),
	destination: Type.String({ description: "Destination heading text." }),
	placement: MovePlacementSchema,
	leveling: Type.Optional(SectionLevelingSchema),
	ignoreCase: IgnoreCase,
	sourceOccurrence: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed source occurrence." })),
	destinationOccurrence: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed destination occurrence." })),
});

const ReplaceSectionParams = Type.Object({
	file: MarkdownFile,
	heading: Heading,
	content: Type.String({ description: "Replacement Markdown content for the whole section." }),
	expectEtag: Type.Optional(
		Type.String({
			description:
				"Optional SECTION etag from md_outline entries (.etag) or md_section (.section.etag) — fingerprints the full section span, heading through body. The md binary verifies it in-process, atomically with the splice, and fails closed if the section changed since the read or if identical duplicate sections make the etag ambiguous.",
		}),
	),
	occurrence: Occurrence,
	ignoreCase: IgnoreCase,
});

// Session-scoped runtime singleton, keyed by cwd (and env override), so the
// schema handshake runs once per session instead of once per tool call.
let cachedRuntime: { key: string; instance: MdtoolsRuntime } | undefined;

function runtime(ctx: ExtensionContext): MdtoolsRuntime {
	const key = JSON.stringify([ctx.cwd, process.env.MD_BINARY_PATH ?? "", process.env.MDTOOLS_MD_BIN ?? ""]);
	if (cachedRuntime === undefined || cachedRuntime.key !== key) {
		cachedRuntime = { key, instance: new MdtoolsRuntime({ cwd: ctx.cwd }) };
	}
	return cachedRuntime.instance;
}

function emit(ctx: ExtensionContext, message: string, kind: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, kind);
		return;
	}
	console.log(message);
}

const mdOutlineTool = defineTool({
	name: "md_outline",
	label: "Markdown Outline",
	description: "Read a Markdown file's heading outline using mdtools/comrak and return JSON spans.",
	...MD_TOOL_PROMPTS.md_outline,
	parameters: OutlineParams,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return await tracked("md_outline", ctx.cwd, params, () => runtime(ctx).outline(params, signal));
	},
});

const mdSectionTool = defineTool({
	name: "md_section",
	label: "Markdown Section",
	description: "Read one Markdown section by exact heading text. Duplicate matches return ambiguous candidates unless occurrence is supplied.",
	...MD_TOOL_PROMPTS.md_section,
	parameters: SectionParams,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return await tracked("md_section", ctx.cwd, params, () => runtime(ctx).section(params, signal));
	},
});

const mdTasksTool = defineTool({
	name: "md_tasks",
	label: "Markdown Tasks",
	description: "List GFM checkbox tasks with structural locations, status, nearest heading, and source spans.",
	...MD_TOOL_PROMPTS.md_tasks,
	parameters: TasksParams,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return await tracked("md_tasks", ctx.cwd, params, () => runtime(ctx).tasks(params, signal));
	},
});

const mdTableTool = defineTool({
	name: "md_table",
	label: "Markdown Table",
	description: "Read Markdown table metadata or project rows by block index, selected columns, and filters.",
	...MD_TOOL_PROMPTS.md_table,
	parameters: TableParams,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return await tracked("md_table", ctx.cwd, params, () => runtime(ctx).table(params, signal));
	},
});

const mdBlocksTool = defineTool({
	name: "md_blocks",
	label: "Markdown Blocks",
	description: "List top-level Markdown blocks with spans, previews, and mdtools etags when supported by the installed md binary.",
	...MD_TOOL_PROMPTS.md_blocks,
	parameters: BlocksParams,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return await tracked("md_blocks", ctx.cwd, params, () => runtime(ctx).blocks(params, signal));
	},
});

const mdBlockTool = defineTool({
	name: "md_block",
	label: "Markdown Block",
	description: "Read one Markdown block by index with content and mdtools metadata.",
	...MD_TOOL_PROMPTS.md_block,
	parameters: BlockParams,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return await tracked("md_block", ctx.cwd, params, () => runtime(ctx).block(params, signal));
	},
});

const mdSetTaskTool = defineTool({
	name: "md_set_task",
	label: "Set Markdown Task",
	description: "Safely set a GFM checkbox task status by md_tasks structural loc. Mutates the file in place.",
	...MD_TOOL_PROMPTS.md_set_task,
	parameters: SetTaskParams,
	executionMode: "sequential",
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const file = resolveToolPath(ctx.cwd, params.file);
		return await withFileMutationQueue(file, async () => tracked("md_set_task", ctx.cwd, params, () => runtime(ctx).setTask(params, signal)));
	},
});

const mdMoveSectionTool = defineTool({
	name: "md_move_section",
	label: "Move Markdown Section",
	description:
		"Move a Markdown section before/after/into another heading using mdtools auto-releveling. Duplicate source/destination headings return candidates unless occurrences are supplied.",
	...MD_TOOL_PROMPTS.md_move_section,
	parameters: MoveSectionParams,
	executionMode: "sequential",
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const file = resolveToolPath(ctx.cwd, params.file);
		return await withFileMutationQueue(file, async () => tracked("md_move_section", ctx.cwd, params, () => runtime(ctx).moveSection(params, signal)));
	},
});

const mdReplaceSectionTool = defineTool({
	name: "md_replace_section",
	label: "Replace Markdown Section",
	description:
		"Replace a Markdown section by heading. Mutates in place; expectEtag (a section etag from md_outline/md_section) makes the binary fail closed on drift.",
	...MD_TOOL_PROMPTS.md_replace_section,
	parameters: ReplaceSectionParams,
	executionMode: "sequential",
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const file = resolveToolPath(ctx.cwd, params.file);
		return await withFileMutationQueue(file, async () => tracked("md_replace_section", ctx.cwd, params, () => runtime(ctx).replaceSection(params, signal)));
	},
});

export default function mdtoolsExtension(pi: ExtensionAPI): void {
	for (const tool of [
		mdOutlineTool,
		mdSectionTool,
		mdTasksTool,
		mdTableTool,
		mdBlocksTool,
		mdBlockTool,
		mdSetTaskTool,
		mdMoveSectionTool,
		mdReplaceSectionTool,
	]) {
		pi.registerTool(tool);
	}

	pi.registerCommand("mdtools", {
		description: "Show mdtools extension status and help",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			const items = COMMANDS.filter((command) => command.startsWith(normalized)).map((command) => ({
				value: command,
				label: command,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			switch (command) {
				case "":
				case "status":
					emit(ctx, formatStatus(await runtime(ctx).status()));
					return;
				case "help":
					emit(ctx, helpText());
					return;
				default:
					emit(ctx, `Unknown /mdtools argument: ${args}\n\n${helpText()}`, "warning");
			}
		},
	});
}
