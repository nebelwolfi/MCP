#!/usr/bin/env node
import { parseArgs } from "./config.js";
import { runCleanup, runMergeOnly, runMain } from "./orchestrator.js";

const config = parseArgs(process.argv);

if (config.cleanup) {
  runCleanup(config).catch((e) => {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
} else if (config.mergeOnly) {
  runMergeOnly(config).catch((e) => {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
} else {
  runMain(config).catch((e) => {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
