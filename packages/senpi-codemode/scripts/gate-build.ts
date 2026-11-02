import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureTargetBuild, recordTargetBuild } from "./gate-build-inputs.ts";
import { runProcess } from "./gate-process.ts";

async function main(): Promise<void> {
	const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../../..", import.meta.url)));
	const target = resolve(root, "packages/senpi-codemode");
	const inputs = await captureTargetBuild(target);
	const result = await runProcess(["bun", "run", "build"], root);
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	if (result.exitCode === 0) await recordTargetBuild(target, inputs);
	process.exitCode = result.exitCode;
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
