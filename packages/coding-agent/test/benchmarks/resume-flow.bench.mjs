import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

const { runResumeFlowBench } = await import("./resume-flow-harness.ts");
try {
	await runResumeFlowBench(process.argv.slice(2));
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
