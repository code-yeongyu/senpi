import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Deterministic micro-benchmark for senpi#2525: emitContext + the context-hook
// pipeline over 10,000 synthetic uncompacted messages. Not part of the default
// suite (no timing assertions); run manually:
//   bun packages/coding-agent/test/benchmarks/context-hook-pipeline.bench.mjs
//   node packages/coding-agent/test/benchmarks/context-hook-pipeline.bench.mjs

const entry = fileURLToPath(import.meta.url);
const hasTsx = process.execArgv.some((arg) => arg === "tsx" || arg.includes("tsx"));

if (!hasTsx) {
	const result = spawnSync(process.execPath, ["--import", "tsx", entry, ...process.argv.slice(2)], {
		stdio: "inherit",
		env: process.env,
	});
	if (result.error) {
		console.error(result.error);
		process.exit(1);
	}
	process.exit(result.status === null ? 1 : result.status);
}

const { runContextHookPipelineBench } = await import("./context-hook-pipeline-bench.ts");
try {
	await runContextHookPipelineBench(process.argv.slice(2));
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
