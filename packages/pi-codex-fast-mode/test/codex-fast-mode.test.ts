import assert from "node:assert/strict";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	buildCodexFastModeOptions,
	createFastModeState,
	decideFastMode,
	PRIORITY_SERVICE_TIER,
	recordFastModeDecision,
	shouldShowFastModeStatus,
} from "../index.js";

function codexResponsesModel(
	overrides: Partial<Model<"openai-codex-responses">> = {},
): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.5",
		name: "GPT 5.5",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1,
		maxTokens: 1,
		...overrides,
	};
}

function nonCodexModel(): Model<Api> {
	return {
		id: "gpt-5.1",
		name: "GPT 5.1",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1,
		maxTokens: 1,
	};
}

test("off mode never injects priority", () => {
	const state = createFastModeState("off");
	const model = codexResponsesModel();
	const decision = decideFastMode(state, model);
	const options = buildCodexFastModeOptions(model, undefined, decision.apply);

	assert.deepEqual(decision, { apply: false, reason: "disabled" });
	assert.equal(options.serviceTier, undefined);
});

test("auto mode injects priority for known OpenAI Codex fast-capable models", () => {
	const state = createFastModeState("auto");
	const model = codexResponsesModel({ id: "gpt-5.4" });
	const decision = decideFastMode(state, model);
	const options = buildCodexFastModeOptions(model, { maxTokens: 123 }, decision.apply);

	assert.deepEqual(decision, { apply: true, reason: "eligible" });
	assert.equal(options.serviceTier, PRIORITY_SERVICE_TIER);
	assert.equal(options.maxTokens, 123);
});

test("auto mode skips non-openai-codex providers even on the Codex Responses API", () => {
	const state = createFastModeState("auto");
	const model = codexResponsesModel({ provider: "openai" });
	const decision = decideFastMode(state, model);
	const options = buildCodexFastModeOptions(model, undefined, decision.apply);

	assert.deepEqual(decision, { apply: false, reason: "not-codex-provider" });
	assert.equal(options.serviceTier, undefined);
});

test("auto mode skips unknown Codex Responses models", () => {
	const state = createFastModeState("auto");
	const model = codexResponsesModel({ id: "gpt-next" });
	const decision = decideFastMode(state, model);
	const options = buildCodexFastModeOptions(model, undefined, decision.apply);

	assert.deepEqual(decision, { apply: false, reason: "unknown-model" });
	assert.equal(options.serviceTier, undefined);
});

test("force mode injects priority for any Codex Responses model", () => {
	const state = createFastModeState("force");
	const model = codexResponsesModel({ id: "gpt-next", provider: "openai" });
	const decision = decideFastMode(state, model);
	const options = buildCodexFastModeOptions(model, undefined, decision.apply);

	assert.deepEqual(decision, { apply: true, reason: "forced" });
	assert.equal(options.serviceTier, PRIORITY_SERVICE_TIER);
});

test("non-Codex APIs are never eligible", () => {
	const state = createFastModeState("force");
	const decision = decideFastMode(state, nonCodexModel());

	assert.deepEqual(decision, { apply: false, reason: "not-codex-api" });
});

test("decision recording counts applied and skipped requests", () => {
	const state = createFastModeState("auto");
	const appliedModel = codexResponsesModel();
	const skippedModel = codexResponsesModel({ id: "gpt-next" });

	recordFastModeDecision(state, appliedModel, true, "eligible");
	recordFastModeDecision(state, skippedModel, false, "unknown-model");

	assert.equal(state.applied, 1);
	assert.equal(state.skipped, 1);
	assert.equal(state.lastDecision?.model, "openai-codex/gpt-next");
	assert.equal(state.lastDecision?.reason, "unknown-model");
});

test("status marker only appears when active model can receive fast mode", () => {
	assert.equal(shouldShowFastModeStatus(createFastModeState("off"), codexResponsesModel()), false);
	assert.equal(shouldShowFastModeStatus(createFastModeState("auto"), codexResponsesModel()), true);
	assert.equal(
		shouldShowFastModeStatus(createFastModeState("auto"), codexResponsesModel({ id: "gpt-next" })),
		false,
	);
	assert.equal(
		shouldShowFastModeStatus(createFastModeState("force"), codexResponsesModel({ id: "gpt-next" })),
		true,
	);
	assert.equal(shouldShowFastModeStatus(createFastModeState("force"), nonCodexModel()), false);
});
