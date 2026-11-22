import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { teardownChildProcessesAndRoots } from "../../helpers/process-teardown.ts";

const fixture = fileURLToPath(new URL("./issue-12060-permission-worker-exit-fixture.ts", import.meta.url));
const naturalExitDeadlineMs = 10_000;
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
	await teardownChildProcessesAndRoots(children, roots, 2_000);
});

// oh-my-openagent#12060: a path rule starts this worker even with --no-tools.
it.each([
	{ name: "Node", command: process.execPath },
	{ name: "Bun", command: "bun" },
])("allows natural exit after a permission rule resolves on $name", async ({ command }) => {
	const home = mkdtempSync(join(tmpdir(), "permission-worker-exit-"));
	roots.push(home);
	const child = spawn(command, [fixture], {
		cwd: home,
		env: {
			PATH: process.env.PATH,
			HOME: home,
			SENPI_CODING_AGENT_DIR: join(home, "agent"),
			TMPDIR: process.env.TMPDIR,
			NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
			BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (child.pid !== undefined) children.push(child);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (text: string) => {
		stdout += text;
	});
	child.stderr.setEncoding("utf8").on("data", (text: string) => {
		stderr += text;
	});
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	let deadline: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			exited,
			new Promise<never>((_resolve, reject) => {
				deadline = setTimeout(() => {
					reject(
						new Error(
							`Natural exit not observed after ${naturalExitDeadlineMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`,
						),
					);
				}, naturalExitDeadlineMs);
			}),
		]);
		expect(stdout, stderr).toBe("RESOLVED\n");
		expect(result, "The idle permission worker kept the process alive").toEqual({ code: 0, signal: null });
	} finally {
		clearTimeout(deadline);
	}
});
