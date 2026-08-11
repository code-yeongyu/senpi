import { spawnSync } from "node:child_process";
import process from "node:process";
import { describe, expect, it } from "vitest";

const isDarwinArm64 = process.platform === "darwin" && process.arch === "arm64";
const fixture = (name: string): URL => new URL(`./fixtures/${name}`, import.meta.url);

function failureDetail(result: ReturnType<typeof spawnSync>): string {
	if (result.error !== undefined) return result.error.message;
	return `${String(result.stderr)}${String(result.stdout)}`.trim();
}

describe.skipIf(!isDarwinArm64)("native wait lifecycle", () => {
	it("does not starve the libuv threadpool while PTY waits are pending", () => {
		const result = spawnSync(process.execPath, [fixture("native-wait-threadpool-starvation.mjs").pathname], {
			encoding: "utf8",
			env: { ...process.env, UV_THREADPOOL_SIZE: "1" },
			timeout: 12_000,
		});

		expect(result.status, failureDetail(result)).toBe(0);
		expect(result.stdout).toContain("THREADPOOL_PROBES_COMPLETED");
	}, 15_000);

	it("settles safely after a Worker environment is torn down", () => {
		const result = spawnSync(process.execPath, [fixture("native-wait-worker-teardown.mjs").pathname], {
			encoding: "utf8",
			timeout: 12_000,
		});

		expect(result.status, failureDetail(result)).toBe(0);
		expect(result.stdout).toContain("WORKER_TEARDOWN_COMPLETED");
	}, 15_000);
});
