import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { loadNativePty } from "../src/native-loader.ts";

const hasDarwinArm64Prebuild =
	process.platform === "darwin" && process.arch === "arm64" && loadNativePty().native !== null;
const fixture = (name: string): URL => new URL(`./fixtures/${name}`, import.meta.url);

function threadCount(): number {
	const output = execFileSync("ps", ["-M", "-p", String(process.pid)], { encoding: "utf8" });
	return output.trim().split("\n").length - 1;
}

async function waitForThreadCountAtMost(expected: number): Promise<number> {
	const deadline = Date.now() + 7_000;
	let observed = threadCount();
	while (Date.now() < deadline) {
		observed = threadCount();
		if (observed <= expected) return observed;
		await delay(50);
	}
	return observed;
}

describe.skipIf(!hasDarwinArm64Prebuild)("native callback lifecycle", () => {
	it("delivers delayed data before waitExit resolves in a live environment", () => {
		const result = spawnSync(process.execPath, [fixture("native-delayed-callback.mjs").pathname], {
			encoding: "utf8",
			timeout: 12_000,
		});

		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			events: ["data", "waitExit"],
			output: "LATE_CALLBACK_MARKER",
		});
	}, 15_000);

	it("surfaces a JavaScript data callback failure", () => {
		const result = spawnSync(process.execPath, [fixture("native-callback-throws.mjs").pathname], {
			encoding: "utf8",
			timeout: 10_000,
		});

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("SENPI_NATIVE_CALLBACK_FAILURE");
		expect(result.stdout).not.toContain("WAIT_RESOLVED_AFTER_CALLBACK_FAILURE");
	});

	it("releases reader threads when a Worker environment terminates before callback delivery", async () => {
		const baseline = threadCount();

		for (let index = 0; index < 10; index += 1) {
			const worker = new Worker(fixture("native-worker-queued-callback.mjs"));
			const pid = await new Promise<number>((resolve, reject) => {
				worker.once("message", (value: number) => resolve(value));
				worker.once("error", reject);
			});
			await worker.terminate();
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// The shell may already have exited during Worker teardown.
				}
			}
			await delay(30);
		}
		await delay(500);

		const after = await waitForThreadCountAtMost(baseline);
		expect(after).toBeLessThanOrEqual(baseline);
	}, 15_000);
});
