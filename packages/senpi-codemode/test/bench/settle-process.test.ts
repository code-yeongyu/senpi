import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const settleModule = fileURLToPath(new URL("../../scripts/bench-settle.ts", import.meta.url));

describe("waitForLoadBelow keeps its process alive (senpi#2909)", () => {
	it("finishes the wait in a process that has nothing else to do", async () => {
		// Given a standalone process whose only pending work is the default (real-timer) wait.
		// No top-level await: like a CLI entry calling main(), only the wait's own timer can keep the process alive.
		const script = `
			(async () => {
				const { waitForLoadBelow } = await import(${JSON.stringify(settleModule)});
				const readings = [90, 90, 10];
				const settled = await waitForLoadBelow(20, { read: () => readings.shift() ?? 10, intervalMs: 50 });
				console.log("SETTLED " + settled);
			})();
		`;
		const child = spawn(process.execPath.includes("bun") ? process.execPath : "bun", ["--eval", script], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString();
		});
		const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
		// Then it exits only after the wait finished, instead of quitting with code 0 mid-wait.
		expect(out.trim()).toBe("SETTLED true");
		expect(code).toBe(0);
	}, 30_000);
});
