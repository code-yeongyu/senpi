import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { resolveJavaScriptProcessCommand } from "../src/kernels/js/process-worker.ts";
import { closeProcessFixtures, kernels, trackedTempRoot } from "./js-process-fixtures.ts";

it("awaits a fixture kernel child before removing its cwd (#3064)", async () => {
	const root = await trackedTempRoot("senpi-process-fixture-proof-");
	const kernel = new JavaScriptKernel({
		sessionId: "fixture-cleanup-proof",
		cwd: root,
		parallelPoolWidth: 1,
		isolation: "process",
		processExecPath: resolveJavaScriptProcessCommand(undefined, process.platform, "bun", ""),
	});
	kernels.add(kernel);
	await expect(kernel.run({ cellId: "ready", code: "return 1", timeoutMs: 10_000 })).resolves.toMatchObject({
		ok: true,
	});
	const pid = kernel.processPid;
	if (pid === undefined) throw new Error("fixture kernel has no child pid");
	await closeProcessFixtures();
	expect(existsSync(root)).toBe(false);
	expect(() => process.kill(pid, 0)).toThrow();
}, 20_000);
