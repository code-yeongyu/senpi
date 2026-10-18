import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	ensureSupervised,
	expectGoneWithin,
	fileAppears,
	generationDir,
	hostChildOf,
	processAlive,
	registeredSupervisor,
	removeSupervisedScratches,
	type SupervisedScratch,
	supervisedScratch,
	terminalRecords,
	writeGenerationFile,
} from "./helpers/rpc-supervised-host.ts";

/**
 * senpi#2566 (IS-6): a graceful stop of a host that is alive but measurably stalled waits for it
 * instead of SIGKILLing it after five seconds, and the caller that asked for the stop extends its own
 * deadline while the supervisor says it is waiting. Elapsed time IS the behaviour under test here: the
 * assertions are "still alive at T", so the checkpoints are real delays after an observed event.
 */
afterEach(removeSupervisedScratches, 60_000);

const NO_STALL_ENV = { SENPI_RPC_LOOP_LAG_ERROR_MS: "600000" };

async function stallChild(qa: SupervisedScratch, env: Record<string, string>) {
	await ensureSupervised(qa, { env }).then((ensured) => ensured.release());
	const { pid, instanceId } = await registeredSupervisor(qa);
	const child = hostChildOf(pid);
	await writeGenerationFile(qa, instanceId, "host-stalled.json", {
		at: new Date().toISOString(),
		driftMs: 6_000,
		processCpuMs: 5_900,
		heapDeltaMb: 0,
	});
	process.kill(child, "SIGSTOP");
	return { pid, instanceId, child };
}

describe.skipIf(process.platform === "win32")("a graceful stop of a stalled host", () => {
	it("waits out the stall and lets the host exit on the SIGTERM it was sent", async () => {
		const qa = await supervisedScratch("stall-wait");
		const { pid, instanceId, child } = await stallChild(qa, NO_STALL_ENV);

		process.kill(pid, "SIGTERM");
		await delay(8_000);
		const aliveAt8s = processAlive(child);
		if (aliveAt8s) process.kill(child, "SIGCONT");
		await expectGoneWithin(pid, 10_000);

		expect(aliveAt8s).toBe(true);
		const [record] = terminalRecords(qa, instanceId);
		expect(record).toMatchObject({ detection: "engine_stop", reason: "signal:SIGTERM", code: 0 });
		expect(record?.signal).toBeUndefined();
	}, 45_000);

	it("escalates to SIGKILL once the stall outlasts the bounded wait, and says so", async () => {
		const qa = await supervisedScratch("stall-max");
		const { pid, instanceId } = await stallChild(qa, {
			...NO_STALL_ENV,
			SENPI_RPC_CHILD_STALLED_STOP_MAX_MS: "8000",
		});

		process.kill(pid, "SIGTERM");
		await expectGoneWithin(pid, 20_000);

		expect(terminalRecords(qa, instanceId)).toEqual([
			expect.objectContaining({
				detection: "engine_stop",
				signal: "SIGKILL",
				reason: expect.stringMatching(/^signal:SIGTERM; escalated_after_stall_wait=\d+$/),
			}),
		]);
	}, 45_000);

	it("keeps the caller's readiness teardown from killing the supervisor mid-wait", async () => {
		const qa = await supervisedScratch("stall-caller");
		const observed: { childAt8s?: boolean; supervisorAt12s?: boolean; instanceId?: string } = {};
		let checkpoints: Promise<void> | undefined;
		const failure = await ensureSupervised(qa, {
			behavior: "silent",
			env: { SENPI_RPC_LOOP_LAG_ERROR_MS: "1500" },
			test: {
				readinessTimeoutMs: 2_000,
				beforeReadinessTeardown: async () => {
					const { pid, instanceId } = await registeredSupervisor(qa);
					observed.instanceId = instanceId;
					// The stall `stopChild` reads is a heartbeat that STOPPED: it must have started first.
					await fileAppears(join(generationDir(qa, instanceId), "host-alive.json"), 10_000);
					const child = hostChildOf(pid);
					process.kill(child, "SIGSTOP");
					checkpoints = (async () => {
						await delay(8_000);
						observed.childAt8s = processAlive(child);
						await delay(4_000);
						observed.supervisorAt12s = processAlive(pid);
						await delay(2_000);
						process.kill(child, "SIGCONT");
					})();
				},
			},
		}).then(
			() => undefined,
			(error: unknown) => error,
		);
		await checkpoints;

		expect(failure).toBeInstanceOf(Error);
		expect(observed).toMatchObject({ childAt8s: true, supervisorAt12s: true });
		const [record] = terminalRecords(qa, observed.instanceId ?? "");
		expect(record).toMatchObject({
			detection: "engine_stop",
			sender: { kind: "ensure", pid: process.pid },
			chain: [expect.objectContaining({ kind: "ensure" }), expect.objectContaining({ kind: "supervisor" })],
			reason: expect.stringMatching(/^readiness_timeout -> signal:SIGTERM$/),
		});
	}, 60_000);
});
