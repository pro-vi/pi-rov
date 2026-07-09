#!/usr/bin/env node
import { runEvalCli } from "../src/eval/cli.ts";

process.exitCode = await runEvalCli(process.argv.slice(2));
