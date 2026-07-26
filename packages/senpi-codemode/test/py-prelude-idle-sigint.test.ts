import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasPython3 } from "./py-kernel/fixtures.ts";

const preludePath = join(dirname(fileURLToPath(import.meta.url)), "../src/kernels/py/prelude.py");

function sendFrame(child: ReturnType<typeof spawn>, message: unknown): void {
	child.stdin?.write(`${JSON.stringify(message)}\n`);
}

async function readFrame(child: ReturnType<typeof spawn>): Promise<Record<string, unknown>> {
	const [chunk] = (await once(child.stdout!, "data")) as [Buffer];
	const line = chunk.toString("utf8").split("\n").find(Boolean);
	if (line === undefined) throw new Error("no prelude frame");
	return JSON.parse(line) as Record<string, unknown>;
}

describe.skipIf(!(await hasPython3()))("Python prelude idle SIGINT guard", () => {
	it("keeps the runner alive when SIGINT arrives while it is idle on stdin", async () => {
		const child = spawn("python3", [preludePath], { stdio: ["pipe", "pipe", "inherit"] });
		try {
			sendFrame(child, {
				type: "init",
				sessionId: "idle-sigint",
				connection: { port: 1, token: "t", parallelPoolWidth: 2 },
			});
			const ready = await readFrame(child);
			expect(ready.type).toBe("ready");

			sendFrame(child, { type: "run", cellId: "cell-1", code: "marker = 'alive'\nresult = 1 + 1" });
			const first = await readFrame(child);
			expect(first).toMatchObject({ type: "result", cellId: "cell-1", ok: true });

			// The cell finished and the runner is back in its stdin-read loop. A stray
			// SIGINT (a late or duplicated interrupt) must not kill it here.
			child.kill("SIGINT");
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(child.exitCode, "idle runner must survive a stray SIGINT").toBeNull();
			expect(child.signalCode, "idle runner must not be signalled to death").toBeNull();

			sendFrame(child, { type: "run", cellId: "cell-2", code: "result = marker" });
			const second = await readFrame(child);
			expect(second).toMatchObject({ type: "result", cellId: "cell-2", ok: true });
		} finally {
			child.kill("SIGKILL");
		}
	});

	it("still interrupts a running cell when SIGINT arrives mid-execution", async () => {
		const child = spawn("python3", [preludePath], { stdio: ["pipe", "pipe", "inherit"] });
		try {
			sendFrame(child, {
				type: "init",
				sessionId: "exec-sigint",
				connection: { port: 1, token: "t", parallelPoolWidth: 2 },
			});
			const ready = await readFrame(child);
			expect(ready.type).toBe("ready");

			sendFrame(child, { type: "run", cellId: "cell-3", code: "while True:\n    pass" });
			await new Promise((resolve) => setTimeout(resolve, 300));
			child.kill("SIGINT");

			const interrupted = await readFrame(child);
			expect(interrupted).toMatchObject({ type: "result", cellId: "cell-3", ok: false });
			expect(child.exitCode).toBeNull();
		} finally {
			child.kill("SIGKILL");
		}
	});
});
