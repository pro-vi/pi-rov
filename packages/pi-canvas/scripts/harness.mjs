#!/usr/bin/env node
import { HARNESS_SCENARIO_IDS, runHarnessScenario } from "../src/harness.ts";

const args = process.argv.slice(2);
const scenarioIndex = args.indexOf("--scenario");
const expectIndex = args.indexOf("--expect");

if (scenarioIndex === -1 || !args[scenarioIndex + 1]) {
  console.error("Usage: npm run eval:harness -- --scenario <id> [--expect pass|fail]");
  process.exit(2);
}

const scenarioId = args[scenarioIndex + 1];
const expected = expectIndex === -1 ? "pass" : args[expectIndex + 1];

if (expected !== "pass" && expected !== "fail") {
  console.error("--expect must be pass or fail");
  process.exit(2);
}

if (!HARNESS_SCENARIO_IDS.includes(scenarioId)) {
  console.error(`unknown scenario "${scenarioId}" (valid: ${HARNESS_SCENARIO_IDS.join(", ")})`);
  process.exit(2);
}

const run = await runHarnessScenario({ scenarioId });
console.log(`${run.scenarioId}: ${run.verdict}`);
console.log(JSON.stringify({ runId: run.runId, verdict: run.verdict, successGateSatisfied: run.successGateSatisfied }, null, 2));

if (run.verdict !== expected) {
  process.exit(1);
}
