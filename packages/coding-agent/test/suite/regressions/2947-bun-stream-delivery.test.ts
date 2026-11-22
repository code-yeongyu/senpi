import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { captureStdoutWhenDroppable } from "../../../src/cli/print-then-exit.ts";

// senpi#2947: under Bun, output a streaming command queues ahead of a slow pipe reader is dropped at
// process.exit. captureStdoutWhenDroppable is the CLI's route for streaming commands: collect under
// Bun+pipe, stream elsewhere. The child runs the real helper under Bun with a pipe stdout; the reader
// consumes strictly after the child exits, so every line must already have been delivered.

const STREAMED_LINES = 4000;

function bunOnPath(): string | undefined {
	try {
		return execFileSync("which", ["bun"], { encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

const bun = bunOnPath();

it.skipIf(bun === undefined)(
	"a streaming command delivers every line under Bun (senpi#2947)",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "senpi-2947-"));
		try {
			const childScript = `
			const { captureStdoutWhenDroppable, exitAfterOutput } = await import(${JSON.stringify(join(process.cwd(), "src/cli/print-then-exit.ts"))});
			await exitAfterOutput(
				(await captureStdoutWhenDroppable(() => {
					for (let i = 0; i < ${STREAMED_LINES}; i++) console.log("progress line " + i);
				})).output,
				0,
			);
		`;
			await writeFile(join(dir, "child.mjs"), childScript);
			const child = spawn(bun as string, [join(dir, "child.mjs")], { stdio: ["ignore", "pipe", "pipe"] });
			let childErr = "";
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				childErr += chunk;
			});
			let out = "";
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				out += chunk;
			});
			const [code] = await once(child, "exit");
			// Pipe bytes can still be in flight the instant the child exits; this is the one bounded
			// OS-boundary wait - the count must then be final.
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(code, `child stderr: ${childErr}`).toBe(0);
			const lines = out.split("\n").filter((line) => line.startsWith("progress line "));
			expect(lines.length).toBe(STREAMED_LINES);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
	60_000,
);

it("collects when the runtime can drop queued writes and streams otherwise", async () => {
	// Routing without Bun: a dropping runtime + pipe collects; anything else streams unchanged.
	const originalIsTTY = process.stdout.isTTY;
	const originalBun = (globalThis as { Bun?: unknown }).Bun;
	try {
		(process.stdout as { isTTY?: boolean }).isTTY = false;
		(globalThis as { Bun?: unknown }).Bun = { version: "test" };
		const first = await captureStdoutWhenDroppable(() => console.log("collected line"));
		expect(first.output).toContain("collected line");

		(globalThis as { Bun?: unknown }).Bun = undefined;
		const second = await captureStdoutWhenDroppable(() => "done");
		expect(second.result).toBe("done");
		expect(second.output).toBe("");
	} finally {
		(process.stdout as { isTTY?: boolean }).isTTY = originalIsTTY;
		(globalThis as { Bun?: unknown }).Bun = originalBun;
	}
});
