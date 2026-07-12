export interface MdToolPrompt {
	promptSnippet: string;
	promptGuidelines: string[];
}

const STRUCTURAL_READ_GUIDELINES = [
	"Use md_outline, md_section, md_tasks, md_table, md_blocks, or md_block for structural Markdown reads instead of grep when headings, tasks, tables, block spans, or etags matter.",
	"Use md_* tool candidates and error.nextAction to recover from ambiguous or stale Markdown targets before retrying a mutation.",
] as const;

const STRUCTURAL_MUTATION_GUIDELINES = [
	"Use md_set_task, md_move_section, and md_replace_section for structural Markdown mutations; keep Pi edit for generic text edits.",
	"Use md_blocks before md_replace_section when drift safety matters, then pass the selected heading block etag as expectEtag.",
] as const;

export const MD_TOOL_PROMPTS = {
	md_outline: {
		promptSnippet: "Read Markdown heading outlines with mdtools/comrak JSON spans.",
		promptGuidelines: [
			"Use md_outline when you need the current Markdown heading tree, heading spans, or duplicate-heading context.",
			...STRUCTURAL_READ_GUIDELINES,
		],
	},
	md_section: {
		promptSnippet: "Read one Markdown section by heading with ambiguity candidates.",
		promptGuidelines: [
			"Use md_section when you need a section's body by heading; if it returns ambiguous candidates, retry with occurrence.",
			...STRUCTURAL_READ_GUIDELINES,
		],
	},
	md_tasks: {
		promptSnippet: "List GFM task checkboxes with structural locs and headings.",
		promptGuidelines: [
			"Use md_tasks before md_set_task so you mutate by the current structural task loc, not by line number.",
			...STRUCTURAL_READ_GUIDELINES,
		],
	},
	md_table: {
		promptSnippet: "Read or project Markdown tables structurally.",
		promptGuidelines: [
			"Use md_table when Markdown table rows or columns matter; prefer select/where over ad hoc text filtering.",
			...STRUCTURAL_READ_GUIDELINES,
		],
	},
	md_blocks: {
		promptSnippet: "List Markdown blocks with spans, previews, and etags.",
		promptGuidelines: [
			"Use md_blocks when you need Markdown block indices, previews, spans, or etags for drift-safe edits.",
			...STRUCTURAL_READ_GUIDELINES,
		],
	},
	md_block: {
		promptSnippet: "Read one Markdown block by index.",
		promptGuidelines: [
			"Use md_block when you already have a block index and need that block's exact content or metadata.",
			...STRUCTURAL_READ_GUIDELINES,
		],
	},
	md_set_task: {
		promptSnippet: "Set a Markdown task checkbox by structural loc.",
		promptGuidelines: [
			"Use md_set_task only with a loc from current md_tasks output; on E_BAD_LOC, choose from candidates or re-run md_tasks.",
			...STRUCTURAL_MUTATION_GUIDELINES,
		],
	},
	md_move_section: {
		promptSnippet: "Move Markdown sections structurally with auto-releveling and ambiguity checks.",
		promptGuidelines: [
			"Use md_move_section for section relocation; if headings are duplicated, retry with sourceOccurrence and destinationOccurrence from candidates.",
			...STRUCTURAL_MUTATION_GUIDELINES,
		],
	},
	md_replace_section: {
		promptSnippet: "Replace Markdown sections by heading with optional etag drift guard.",
		promptGuidelines: [
			"Use md_replace_section for whole-section replacement; pass expectEtag from md_blocks when stale-target safety matters.",
			...STRUCTURAL_MUTATION_GUIDELINES,
		],
	},
} satisfies Record<string, MdToolPrompt>;
