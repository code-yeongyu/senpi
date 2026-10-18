import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_DAEMON_DIR_ENV } from "../../src/modes/rpc/host-daemon-paths.ts";
import { HOST_INSTANCE_ID_ENV } from "../../src/modes/rpc/host-identity-env.ts";
import { LOOP_LAG_TICK_MS, LoopLagWatchdog } from "../../src/modes/rpc/loop-lag-watchdog.ts";
import { fileAppears } from "../helpers/rpc-supervised-host.ts";

/**
 * senpi#2566: a stall the host measured is persisted per GENERATION, beside a heartbeat that stops when
 * the loop does, so an ensure or a supervisor acting on that generation can tell "alive but stalled"
 * from "gone". The clock is injected; the files are what the readers see.
 */
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function harness() {
	const root = await mkdtemp(join(tmpdir(), "senpi-looplag-evidence-"));
	roots.push(root);
	const instanceId = "generation-under-test";
	const dir = join(root, "generations", instanceId);
	await mkdir(dir, { recursive: true });
	let clock = 0;
	const watchdog = new LoopLagWatchdog({
		emit: () => {},
		log: () => {},
		now: () => clock,
		env: { [HOST_DAEMON_DIR_ENV]: root, [HOST_INSTANCE_ID_ENV]: instanceId },
	});
	watchdog.tick();
	return {
		dir,
		late: (driftMs: number) => {
			clock += LOOP_LAG_TICK_MS + driftMs;
			watchdog.tick();
		},
	};
}

describe("loop lag evidence files", () => {
	it("persists a stall past the error threshold for the generation", async () => {
		const { dir, late } = await harness();

		late(5_001);

		await fileAppears(join(dir, "host-stalled.json"), 5_000);
		const evidence: unknown = JSON.parse(await readFile(join(dir, "host-stalled.json"), "utf8"));
		expect(evidence).toMatchObject({ driftMs: 5_001, at: expect.any(String) });
	});

	it("writes a heartbeat on a healthy tick and no stall evidence for a short drift", async () => {
		const { dir, late } = await harness();

		late(400);

		await fileAppears(join(dir, "host-alive.json"), 5_000);
		expect(existsSync(join(dir, "host-stalled.json"))).toBe(false);
	});

	// Review of #2571 (M1): readers call a host stalled once its heartbeat is older than the stall threshold,
	// so the heartbeat is refreshed at most once per fifth of it, not on every 200 ms tick.
	it("refreshes the heartbeat at most once per fifth of the stall threshold", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-looplag-heartbeat-"));
		roots.push(root);
		const instanceId = "generation-under-test";
		await mkdir(join(root, "generations", instanceId), { recursive: true });
		let clock = 0;
		const beats: string[] = [];
		const watchdog = new LoopLagWatchdog({
			emit: () => {},
			log: () => {},
			now: () => clock,
			env: { [HOST_DAEMON_DIR_ENV]: root, [HOST_INSTANCE_ID_ENV]: instanceId },
			writeHeartbeat: async (_dir, at) => {
				beats.push(at);
			},
		});

		for (let tick = 0; tick <= 10; tick += 1) {
			watchdog.tick();
			// Lets the injected write settle before the next tick, so the in-flight guard is not what spaces the beats.
			await Promise.resolve();
			clock += LOOP_LAG_TICK_MS;
		}

		// 11 healthy ticks over 2 s at the default 5 s threshold: beats at 0, 1 s and 2 s only.
		expect(beats).toEqual([0, 1_000, 2_000].map((ms) => new Date(ms).toISOString()));
	});
});
