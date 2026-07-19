export interface MdToolPrompt {
	promptSnippet: string;
	promptGuidelines: string[];
}

// Budget note: pi dedupes promptGuidelines by exact string across tools, so
// shared bullets cost once. The deduped snippet+guideline surface is capped
// at ~400 tokens by test/usage.test.ts — trim here, never raise the cap
// without deciding to spend context.

const STRUCTURAL_READ_GUIDELINES = [
	"Prefer md_outline/md_section/md_tasks/md_table/md_blocks/md_block over grep for Markdown structure (headings, tasks, tables, spans, etags).",
	"On ambiguous or stale Markdown targets, follow error.nextAction and candidates[] before retrying.",
] as const;

const STRUCTURAL_MUTATION_GUIDELINES = [
	"Use md_set_task, md_move_section, and md_replace_section for structural Markdown edits; keep Pi edit for plain text.",
	"Pass expectEtag for drift-safe Markdown edits (section etags: md_outline/md_section; task etags: md_tasks); stale or duplicate-ambiguous etags fail closed — re-read and retry.",
] as const;

export const MD_TOOL_PROMPTS = {
	md_outline: {
		promptSnippet: "Read Markdown heading outlines with spans and section etags.",
		promptGuidelines: [...STRUCTURAL_READ_GUIDELINES],
	},
	md_section: {
		promptSnippet: "Read one Markdown section by heading text.",
		promptGuidelines: [...STRUCTURAL_READ_GUIDELINES],
	},
	md_tasks: {
		promptSnippet: "List GFM task checkboxes with structural locs and etags.",
		promptGuidelines: ["Run md_tasks before md_set_task: mutate by current loc, never by line number.", ...STRUCTURAL_READ_GUIDELINES],
	},
	md_table: {
		promptSnippet: "Read or project Markdown tables structurally.",
		promptGuidelines: [...STRUCTURAL_READ_GUIDELINES],
	},
	md_blocks: {
		promptSnippet: "List Markdown blocks with spans, previews, and etags.",
		promptGuidelines: [...STRUCTURAL_READ_GUIDELINES],
	},
	md_block: {
		promptSnippet: "Read one Markdown block by index.",
		promptGuidelines: [...STRUCTURAL_READ_GUIDELINES],
	},
	md_set_task: {
		promptSnippet: "Set a Markdown task checkbox by structural loc.",
		promptGuidelines: ["On E_BAD_LOC, pick a fresh loc from candidates[] or re-run md_tasks.", ...STRUCTURAL_MUTATION_GUIDELINES],
	},
	md_move_section: {
		promptSnippet: "Move Markdown sections with auto-releveling.",
		promptGuidelines: [
			"On duplicate headings, retry md_move_section with sourceOccurrence/destinationOccurrence from candidates[].",
			...STRUCTURAL_MUTATION_GUIDELINES,
		],
	},
	md_replace_section: {
		promptSnippet: "Replace a Markdown section by heading, with etag drift guard.",
		promptGuidelines: [...STRUCTURAL_MUTATION_GUIDELINES],
	},
} satisfies Record<string, MdToolPrompt>;
