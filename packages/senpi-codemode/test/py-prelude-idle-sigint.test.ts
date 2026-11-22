import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeBridgeFrame, isKernelToHostMessage, type KernelToHostMessage } from "../src/bridge/protocol.ts";
import { hasPython3 } from "./py-kernel/fixtures.ts";

const preludePath = join(dirname(fileURLToPath(import.meta.url)), "../src/kernels/py/prelude.py");

function sendFrame(child: ReturnType<typeof spawn>, message: unknown): void {
	child.stdin?.write(`${JSON.stringify(message)}\n`);
}

async function readFrame(
	frames: AsyncIterator<string>,
	expectedType: KernelToHostMessage["type"],
): Promise<KernelToHostMessage> {
	for (;;) {
		const frame = await frames.next();
		if (frame.done) throw new Error("prelude exited before the expected frame");
		const decoded = decodeBridgeFrame(`${frame.value}\n`);
		if (!decoded.ok) throw new Error(decoded.error.message);
		if (!isKernelToHostMessage(decoded.message)) throw new Error("unexpected host frame");
		if (decoded.message.type === "init-failed") throw new Error(decoded.message.error.message);
		if (decoded.message.type !== expectedType) continue;
		return decoded.message;
	}
}

describe.skipIf(!(await hasPython3()))("Python prelude idle SIGINT guard", () => {
	it("keeps the runner alive when SIGINT arrives while it is idle on stdin", async () => {
		const child = spawn("python3", [preludePath], { stdio: ["pipe", "pipe", "inherit"] });
		const reader = createInterface({ input: child.stdout });
		const frames = reader[Symbol.asyncIterator]();
		try {
			sendFrame(child, {
				type: "init",
				sessionId: "idle-sigint",
				connection: { port: 1, token: "t", parallelPoolWidth: 2 },
			});
			const ready = await readFrame(frames, "ready");
			expect(ready.type).toBe("ready");

			sendFrame(child, { type: "run", cellId: "cell-1", code: "marker = 'alive'\nresult = 1 + 1" });
			const first = await readFrame(frames, "result");
			expect(first).toMatchObject({ type: "result", cellId: "cell-1", ok: true });

			// The cell finished and the runner is back in its stdin-read loop. A stray
			// SIGINT (a late or duplicated interrupt) must not kill it here.
			child.kill("SIGINT");
			sendFrame(child, { type: "run", cellId: "cell-2", code: "result = marker" });
			const second = await readFrame(frames, "result");
			expect(second).toMatchObject({ type: "result", cellId: "cell-2", ok: true });
		} finally {
			const exited = once(child, "close");
			child.kill("SIGKILL");
			await exited;
			reader.close();
		}
	});

	it("still interrupts a running cell when SIGINT arrives mid-execution", async () => {
		const child = spawn("python3", [preludePath], { stdio: ["pipe", "pipe", "inherit"] });
		const reader = createInterface({ input: child.stdout });
		const frames = reader[Symbol.asyncIterator]();
		try {
			sendFrame(child, {
				type: "init",
				sessionId: "exec-sigint",
				connection: { port: 1, token: "t", parallelPoolWidth: 2 },
			});
			const ready = await readFrame(frames, "ready");
			expect(ready.type).toBe("ready");

			sendFrame(child, { type: "run", cellId: "cell-3", code: "display('RUNNING')\nwhile True:\n    pass" });
			expect(await readFrame(frames, "display")).toMatchObject({ type: "display", mimeType: "text/plain" });
			child.kill("SIGINT");

			const interrupted = await readFrame(frames, "result");
			expect(interrupted).toMatchObject({ type: "result", cellId: "cell-3", ok: false });
			expect(child.exitCode).toBeNull();
		} finally {
			const exited = once(child, "close");
			child.kill("SIGKILL");
			await exited;
			reader.close();
		}
	});
});
