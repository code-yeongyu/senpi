import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const fixture = fileURLToPath(new URL("./issue-12060-permission-worker-exit-fixture.ts", import.meta.url));

// oh-my-openagent#12060: a path rule starts this worker even with --no-tools.
it.each([
	{ name: "Node", command: process.execPath },
	{ name: "Bun", command: "bun" },
])(
	"allows natural exit after a permission rule resolves on $name",
	async ({ command }) => {
		const home = mkdtempSync(join(tmpdir(), "permission-worker-exit-"));
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
		const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
		try {
			const result = await exited;
			expect(stdout, stderr).toBe("RESOLVED\n");
			expect(result, "The idle permission worker kept the process alive").toEqual({ code: 0, signal: null });
		} finally {
			clearTimeout(deadline);
			child.kill("SIGKILL");
			rmSync(home, { recursive: true, force: true });
		}
	},
	15_000,
);
