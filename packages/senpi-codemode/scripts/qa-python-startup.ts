import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PythonKernel } from "../src/kernels/py/kernel.ts";
import type { PythonStartupStage } from "../src/kernels/py/startup.ts";

// The compiled executable uses the same sidecar resolver and Python transport
// as the shipped engine. A new bytecode-cache root exercises cold imports.
const root = await mkdtemp(join(tmpdir(), "senpi-python-bootstrap-"));
try {
	for (const label of ["cold", "warm"]) {
		const begin = performance.now();
		const stages: { readonly stage: PythonStartupStage; readonly elapsedMs: number }[] = [];
		try {
			const kernel = await PythonKernel.start({
				interpreterPath: process.platform === "win32" ? "python" : "python3",
				sessionId: `startup-qa-${label}`,
				cwd: root,
				connection: { port: 1, token: "fixture" },
				env: { PYTHONPYCACHEPREFIX: join(root, "pycache") },
				onStartupProgress(stage) {
					stages.push({ stage, elapsedMs: performance.now() - begin });
				},
				onMessage(message) {
					if (message.type === "text" && message.stream === "stderr") process.stderr.write(message.data);
				},
			});
			const readyMs = performance.now() - begin;
			try {
				const result = await kernel.run({ cellId: label, code: "2 + 2", timeoutMs: 5_000 });
				if (!result.ok || result.valueRepr !== "4") throw new Error(`Python QA failed: ${JSON.stringify(result)}`);
				console.log("WORKING python-startup", JSON.stringify({ label, readyMs, stages, result: result.valueRepr }));
			} finally {
				await kernel.close();
			}
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			console.error(
				"WORKING python-startup",
				JSON.stringify({
					label,
					stages,
					failedMs: performance.now() - begin,
					errorName: error.name,
					error: error.message,
				}),
			);
			process.exitCode = 1;
		}
	}
} finally {
	await rm(root, { recursive: true, force: true });
}
