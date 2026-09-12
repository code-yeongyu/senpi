import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { JavaScriptKernel, JavaScriptKernelMode } from "../src/kernels/js/context-manager.ts";
import { parseJavaScriptResult, runJavaScriptCell, withJavaScriptKernel } from "./eval/js-kernel-harness.ts";

const childCell = [
	"const childProcess = process.getBuiltinModule('node:child_process');",
	"const child = childProcess.spawnSync(process.execPath, [",
	"  '-e',",
	"  'process.stdout.write(String(process.env.PI_SESSION_ID ?? \"\"))',",
	"]);",
	"return String(child.stdout ?? '');",
].join("\n");

// Bun.spawnSync without an explicit env inherits the OS environ, not the worker's process.env;
// the shell capture must pin the worker view for it. Skipped where the cell runtime is not Bun.
const bunSpawnSyncCell = [
	"if (typeof Bun === 'undefined' || typeof Bun.spawnSync !== 'function') return 'not-bun';",
	"const child = Bun.spawnSync([process.execPath, '-e', 'process.stdout.write(String(process.env.PI_SESSION_ID ?? \"\"))']);",
	"return new TextDecoder().decode(child.stdout);",
].join("\n");

async function cellValue(kernel: JavaScriptKernel, code: string): Promise<unknown> {
	const run = await runJavaScriptCell(kernel, code);
	return parseJavaScriptResult(run.result);
}

describe("JavaScriptKernel session environment", () => {
	it.each([
		{
			name: "worker",
			expectedMode: "worker",
			workerEntryUrl: new URL("../src/kernels/js/worker-entry.js", import.meta.url),
		},
		{
			name: "inline fallback",
			expectedMode: "inline",
			workerEntryUrl: pathToFileURL(join(process.cwd(), "missing-session-env-worker.js")),
		},
	] satisfies readonly {
		readonly name: string;
		readonly expectedMode: JavaScriptKernelMode;
		readonly workerEntryUrl: URL;
	}[])(
		"exposes PI_SESSION_ID to env(), process.env, and child processes in the $name kernel",
		async ({ expectedMode, workerEntryUrl }) => {
			await withJavaScriptKernel(
				async (kernel) => {
					const helperValue = await cellValue(kernel, 'return env("PI_SESSION_ID")');
					// The inline fallback is decided by the first spawn attempt, so the mode is
					// observable only after a cell has run.
					expect(kernel.mode).toBe(expectedMode);
					expect(helperValue).toBe("js-session-env-77");

					const processValue = await cellValue(kernel, "return process.env.PI_SESSION_ID ?? null");
					expect(processValue).toBe("js-session-env-77");

					const childValue = await cellValue(kernel, childCell);
					expect(childValue).toBe("js-session-env-77");

					const bunSyncValue = await cellValue(kernel, bunSpawnSyncCell);
					expect(bunSyncValue === "not-bun" || bunSyncValue === "js-session-env-77").toBe(true);
					if (Object.hasOwn(globalThis, "Bun")) expect(bunSyncValue).toBe("js-session-env-77");
				},
				{
					sessionEnv: { PI_SESSION_ID: "js-session-env-77", PI_PROVIDER: "fake", PI_MODEL: "fake-model" },
					workerEntryUrl,
				},
			);
		},
	);

	it("clears inherited PI_* values the active session does not set", async () => {
		const previousFile = process.env.PI_SESSION_FILE;
		const previousId = process.env.PI_SESSION_ID;
		process.env.PI_SESSION_FILE = "stale-session-file.jsonl";
		process.env.PI_SESSION_ID = "stale-session-id";
		try {
			await withJavaScriptKernel(
				async (kernel) => {
					const id = await cellValue(kernel, "return process.env.PI_SESSION_ID ?? null");
					expect(id).toBe("js-fresh-session");

					const sessionFile = await cellValue(kernel, "return process.env.PI_SESSION_FILE ?? null");
					expect(sessionFile).toBeNull();
				},
				{ sessionEnv: { PI_SESSION_ID: "js-fresh-session" } },
			);
		} finally {
			if (previousId === undefined) delete process.env.PI_SESSION_ID;
			else process.env.PI_SESSION_ID = previousId;
			if (previousFile === undefined) delete process.env.PI_SESSION_FILE;
			else process.env.PI_SESSION_FILE = previousFile;
		}
	});

	it("follows the active session when a new kernel starts for another session", async () => {
		await withJavaScriptKernel(
			async (kernel) => {
				const id = await cellValue(kernel, 'return env("PI_SESSION_ID")');
				expect(id).toBe("js-session-a");
			},
			{ sessionEnv: { PI_SESSION_ID: "js-session-a" } },
		);

		await withJavaScriptKernel(
			async (kernel) => {
				const id = await cellValue(kernel, 'return env("PI_SESSION_ID")');
				expect(id).toBe("js-session-b");
			},
			{ sessionEnv: { PI_SESSION_ID: "js-session-b" } },
		);
	});

	it("re-applies the session environment after a kernel reset", async () => {
		await withJavaScriptKernel(
			async (kernel) => {
				await kernel.reset();
				const id = await cellValue(kernel, 'return env("PI_SESSION_ID")');
				expect(id).toBe("js-reset-session");
			},
			{ sessionEnv: { PI_SESSION_ID: "js-reset-session" } },
		);
	});
});
