import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	clampThinkingLevel,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type ModelThinkingLevel,
	streamOpenAICodexResponses,
	type OpenAICodexResponsesOptions,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export type Mode = "off" | "auto" | "force";
export type DecisionReason =
	| "disabled"
	| "not-codex-api"
	| "not-codex-provider"
	| "unknown-model"
	| "eligible"
	| "forced";

export interface FastModeState {
	mode: Mode;
	applied: number;
	skipped: number;
	lastDecision?: {
		model: string;
		reason: DecisionReason;
		applied: boolean;
		at: number;
	};
}

const STATUS_KEY = "codex-fast-mode";
export const PRIORITY_SERVICE_TIER: NonNullable<OpenAICodexResponsesOptions["serviceTier"]> = "priority";
const FAST_CAPABLE_CODEX_MODELS = new Set(["gpt-5.4", "gpt-5.5"]);
const COMMANDS = ["status", "on", "auto", "force", "off", "toggle", "help"];

export function createFastModeState(mode: Mode = "off"): FastModeState {
	return {
		mode,
		applied: 0,
		skipped: 0,
	};
}

const state = createFastModeState();

function isCodexResponsesModel(model: Model<Api>): model is Model<"openai-codex-responses"> {
	return model.api === "openai-codex-responses";
}

function isKnownFastCapableModel(model: Model<"openai-codex-responses">): boolean {
	return FAST_CAPABLE_CODEX_MODELS.has(model.id);
}

function modelLabel(model: Model<Api> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "none";
}

function toReasoningEffort(
	level: ModelThinkingLevel | undefined,
): OpenAICodexResponsesOptions["reasoningEffort"] | undefined {
	if (!level || level === "off") {
		return undefined;
	}
	return level;
}

export function decideFastMode(
	fastModeState: Pick<FastModeState, "mode">,
	model: Model<Api>,
): { apply: boolean; reason: DecisionReason } {
	if (fastModeState.mode === "off") {
		return { apply: false, reason: "disabled" };
	}
	if (!isCodexResponsesModel(model)) {
		return { apply: false, reason: "not-codex-api" };
	}
	if (fastModeState.mode === "force") {
		return { apply: true, reason: "forced" };
	}
	if (model.provider !== "openai-codex") {
		return { apply: false, reason: "not-codex-provider" };
	}
	if (isKnownFastCapableModel(model)) {
		return { apply: true, reason: "eligible" };
	}
	return { apply: false, reason: "unknown-model" };
}

export function recordFastModeDecision(
	fastModeState: FastModeState,
	model: Model<Api>,
	applied: boolean,
	reason: DecisionReason,
): void {
	if (applied) {
		fastModeState.applied += 1;
	} else if (fastModeState.mode !== "off") {
		fastModeState.skipped += 1;
	}
	fastModeState.lastDecision = {
		model: modelLabel(model),
		reason,
		applied,
		at: Date.now(),
	};
}

export function buildCodexFastModeOptions(
	model: Model<"openai-codex-responses">,
	options: SimpleStreamOptions | undefined,
	applyFastMode: boolean,
): OpenAICodexResponsesOptions {
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = toReasoningEffort(clampedReasoning);
	const next: OpenAICodexResponsesOptions = {
		...options,
	};
	if (reasoningEffort !== undefined) {
		next.reasoningEffort = reasoningEffort;
	}
	if (applyFastMode) {
		next.serviceTier = PRIORITY_SERVICE_TIER;
	}
	return next;
}

function streamCodexWithOptionalFastMode(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	if (!isCodexResponsesModel(model)) {
		throw new Error(`codex-fast-mode received non-Codex model: ${model.api}`);
	}
	const decision = decideFastMode(state, model);
	recordFastModeDecision(state, model, decision.apply, decision.reason);
	return streamOpenAICodexResponses(model, context, buildCodexFastModeOptions(model, options, decision.apply));
}

export function shouldShowFastModeStatus(
	fastModeState: Pick<FastModeState, "mode">,
	currentModel?: Model<Api>,
): boolean {
	if (fastModeState.mode === "off" || !currentModel) {
		return false;
	}
	if (currentModel.provider !== "openai-codex" || !isCodexResponsesModel(currentModel)) {
		return false;
	}
	return fastModeState.mode === "force" || isKnownFastCapableModel(currentModel);
}

function lastDecisionText(): string {
	if (!state.lastDecision) {
		return "last request: none";
	}
	const result = state.lastDecision.applied ? "applied fast" : `skipped (${state.lastDecision.reason})`;
	return `last request: ${result} for ${state.lastDecision.model}`;
}

function statusText(ctx: ExtensionContext): string {
	return [
		"Codex fast mode",
		`mode: ${state.mode}`,
		`current model: ${modelLabel(ctx.model)}`,
		`requests: ${state.applied} applied, ${state.skipped} skipped`,
		lastDecisionText(),
	].join("\n");
}

function helpText(): string {
	return [
		"Codex fast mode injects OpenAI Responses service_tier=priority for Pi's openai-codex-responses provider.",
		"Commands:",
		"/codex-fast status  Show current mode and last request decision.",
		"/codex-fast on      Enable auto mode for known Codex fast-capable models.",
		"/codex-fast force   Enable priority for any openai-codex-responses model.",
		"/codex-fast off     Disable injection.",
		"/codex-fast toggle  Toggle off/auto.",
		"Flag: pi --codex-fast enables auto mode at startup.",
	].join("\n");
}

function updateStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, shouldShowFastModeStatus(state, ctx.model) ? ctx.ui.theme.fg("success", "fast") : undefined);
}

function emit(ctx: ExtensionContext, text: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(text, type);
		return;
	}
	console.log(text);
}

function setMode(mode: Mode, ctx: ExtensionCommandContext): void {
	state.mode = mode;
	updateStatus(ctx);
	emit(ctx, statusText(ctx));
}

export default function codexFastModeExtension(pi: ExtensionAPI): void {
	pi.registerFlag("codex-fast", {
		type: "boolean",
		default: false,
		description: "Enable Codex fast mode for known fast-capable Codex models.",
	});

	pi.registerProvider("codex-fast-mode-runtime", {
		api: "openai-codex-responses",
		streamSimple: streamCodexWithOptionalFastMode,
	});

	pi.on("session_start", (_event, ctx) => {
		if (pi.getFlag("codex-fast") === true) {
			state.mode = "auto";
		}
		updateStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("before_provider_request", (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.registerCommand("codex-fast", {
		description: "Toggle OpenAI Codex fast mode",
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
					updateStatus(ctx);
					emit(ctx, statusText(ctx));
					return;
				case "on":
				case "auto":
					setMode("auto", ctx);
					return;
				case "force":
					setMode("force", ctx);
					return;
				case "off":
					setMode("off", ctx);
					return;
				case "toggle":
					setMode(state.mode === "off" ? "auto" : "off", ctx);
					return;
				case "help":
					emit(ctx, helpText());
					return;
				default:
					emit(ctx, `Unknown /codex-fast argument: ${args}\n\n${helpText()}`, "warning");
			}
		},
	});
}
