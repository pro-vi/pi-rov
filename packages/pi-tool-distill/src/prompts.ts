import type { DistillPromptRequest } from "./types.js";

export const DISTILL_PROMPT_VERSION = 1;

export function synthesizeQuestion(toolName: string, input: Record<string, unknown>): string {
  const command = typeof input.command === "string" ? input.command : "";
  if (toolName === "bash" && /\b(test|vitest|jest|pytest|cargo test|go test|pnpm test|npm test)\b/i.test(command)) {
    return "Did the command pass? If not, list failing tests, exact error messages, and relevant file paths/line numbers.";
  }
  if (toolName === "bash" && /\b(rg|grep|find)\b/i.test(command)) {
    return "Return the matches grouped by likely relevance. Preserve exact file paths and line numbers.";
  }
  if (toolName === "bash" && /\b(git status|git log)\b/i.test(command)) {
    return "Summarize repository state or commit history. Preserve branch names, changed file paths, and commit hashes.";
  }
  if (toolName === "web_search") {
    return "Extract the answer-relevant claims and preserve source URLs, titles, and dates when present.";
  }
  if (toolName.startsWith("reddit_")) {
    return "Summarize opinion patterns and preserve subreddit names, post numbers, and quoted evidence when available.";
  }
  return "Compress this tool result for a coding agent. Preserve exact evidence needed for the next implementation or research step.";
}

export function buildDistillPrompt(request: DistillPromptRequest): string {
  const input = JSON.stringify(request.event.input, null, 2);
  const maxChars = request.settings.maxSummaryChars;
  return [
    "You compress tool output for another coding model.",
    "The raw output is saved separately and can be expanded later, but your card must preserve the important evidence needed for the next step.",
    "",
    "Rules:",
    "- Answer only from the tool output.",
    "- Preserve exact file paths, line numbers, URLs, error names, test names, branch names, commit hashes, and command exit facts.",
    "- Do not invent fixes or conclusions not supported by the output.",
    "- Use concise markdown with exactly these sections: ## Outcome, ## Verbatim evidence, ## Omitted, ## Uncertainty.",
    "- In Verbatim evidence, quote or copy the smallest exact snippets that matter.",
    "- In Omitted, name categories of data you dropped, not every omitted line.",
    `- Keep the whole card under ${maxChars} characters.`,
    "",
    `Tool: ${request.event.toolName}`,
    `Question: ${request.question}`,
    "Tool input:",
    input,
    "",
    "Tool output:",
    "<tool-output>",
    request.rawText,
    "</tool-output>",
  ].join("\n");
}
