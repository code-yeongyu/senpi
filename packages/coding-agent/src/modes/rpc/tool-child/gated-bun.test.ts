// senpi#3566 todo 4: Bun's launch globals in a tool-child worker pass the execution barrier (security contract).
// Runs a real bun process (vitest itself runs on Node), which hosts the channel, the enforcer, the gate and a worker.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const fixture = resolve(import.meta.dirname, "../../../../test/fixtures/gated-bun-main.ts");
const bunAvailable = spawnSync("bun", ["--version"]).status === 0;

describe.skipIf(process.platform === "win32" || !bunAvailable)("gated Bun globals in a tool-child worker", () => {
	it("gates Bun.spawn (own group, detached), Bun.spawnSync and Bun.$ with ordered proofs", () => {
		const run = spawnSync("bun", [fixture], {
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, SENPI_ENV_PROBE: "set" },
		});
		expect(run.status, run.stderr).toBe(0);
		const { result, violations, records } = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as {
			result: Record<string, number>;
			violations: unknown[];
			records: Array<Record<string, unknown>>;
		};
		expect(result).toMatchObject({
			ownedExit: 0,
			detachedExit: 0,
			syncExit: 4,
			shell: 0,
			stdioArrayExit: 0,
			stdioArrayRan: true,
			envProbe: "unset",
			blobEcho: "blob-input",
			missingCode: "ENOENT",
		});
		expect(result.ownedPgid).toBe(result.ownedPid);
		const launches = records.filter((record) => record.type === "launch");
		expect(launches.map((launch) => [launch.api, launch.containment, launch.lifetime])).toEqual([
			["bun.spawn", "own-group", "owned"],
			["bun.spawn", "own-group", "detached"],
			["bun.spawnSync", "inherited", "owned"],
			["bun.spawn", "own-group", "owned"],
			["bun.spawnSync", "inherited", "owned"],
			["bun.spawn", "own-group", "owned"],
			["bun.shell", "inherited", "owned"],
		]);
		const proofs = records.filter((record) => record.type === "launch_proof");
		expect(proofs).toHaveLength(7);
		for (const proof of proofs) expect(Number(proof.ackTick)).toBeLessThan(Number(proof.invokeTick));
		expect(violations).toEqual([]);
	}, 90_000);

	// senpi#5109: a proof is published asynchronously and can reach the server after the worker has reported; every
	// launch must still have its proof recorded. The detached launch's proof is held until after the result to force it.
	it("records every launch's proof even when one arrives after the worker's result", () => {
		const controlDir = mkdtempSync(join(tmpdir(), "tgb-ctl-"));
		try {
			const run = spawnSync("bun", [fixture], {
				encoding: "utf8",
				timeout: 60_000,
				env: {
					...process.env,
					SENPI_TOOL_CHILD_TEST_HOLD_LAUNCH_PROOF: "detached",
					SENPI_TOOL_CHILD_TEST_CONTROL_DIR: controlDir,
				},
			});
			expect(run.status, run.stderr).toBe(0);
			const { violations, records } = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as {
				violations: unknown[];
				records: Array<Record<string, unknown>>;
			};
			const launched = records.filter((record) => record.type === "launch").map((record) => record.launchId);
			const proven = records.filter((record) => record.type === "launch_proof").map((record) => record.launchId);
			expect(launched).toHaveLength(7);
			expect([...proven].sort()).toEqual([...launched].sort());
			expect(violations).toEqual([]);
		} finally {
			rmSync(controlDir, { recursive: true, force: true });
		}
	}, 90_000);

	it("gates a node:child_process launch exactly once when the Bun globals are gated too", () => {
		const run = spawnSync("bun", [fixture, "./gated-barrier-cp-worker.ts"], { encoding: "utf8", timeout: 60_000 });
		expect(run.status, run.stderr).toBe(0);
		const { result, violations, records } = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as {
			result: Record<string, unknown>;
			violations: unknown[];
			records: Array<Record<string, unknown>>;
		};
		expect(result).toEqual({ detachedExit: 0, markerWritten: true });
		const launches = records.filter((record) => record.type === "launch");
		expect(launches.map((launch) => [launch.api, launch.containment, launch.lifetime])).toEqual([
			["cp.spawn", "own-group", "detached"],
			["cp.execFileSync", "inherited", "owned"],
		]);
		expect(violations).toEqual([]);
	}, 90_000);
});
