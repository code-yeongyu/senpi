import { afterEach, describe, expect, it } from "vitest";
import { hostEnsureLockTarget } from "../src/modes/rpc/host-ensure.ts";
import { handoffHost } from "../src/modes/rpc/host-handoff.ts";
import { acquireOwnershipSafeLock } from "../src/modes/rpc/ownership-safe-lock.ts";
import {
	bootInstanceId,
	ensureSupervised,
	expectGoneWithin,
	hostChildOf,
	parentOf,
	registeredSupervisor,
	removeSupervisedScratches,
	type SupervisedScratch,
	supervisedScratch,
	supervisorLaunch,
	terminalRecords,
	watchdogRecords,
} from "./helpers/rpc-supervised-host.ts";

/**
 * senpi#2566: a host the engine stops on purpose left no record (the supervisor's exit handler
 * returned early while shutting down), and a host killed from outside left one that could not name
 * a sender. Every case here runs a REAL supervisor and observes `crashes.jsonl` after the fact.
 */
afterEach(removeSupervisedScratches, 60_000);

// A stall threshold no test reaches: these cases are about WHO stopped the host, not about stalls.
const NO_STALL_ENV = { SENPI_RPC_LOOP_LAG_ERROR_MS: "600000" };

describe.skipIf(process.platform === "win32")("host stop records", () => {
	it("records an engine-initiated stop of a host whose child never answered SIGTERM", async () => {
		const qa = await supervisedScratch("engine");
		await ensureSupervised(qa, { env: NO_STALL_ENV }).then((ensured) => ensured.release());
		const { pid, instanceId } = await registeredSupervisor(qa);
		process.kill(await hostChildOf(qa, instanceId), "SIGSTOP");

		process.kill(pid, "SIGTERM");
		await expectGoneWithin(pid, 15_000);

		const records = terminalRecords(qa, instanceId);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			kind: "rpc-host",
			detection: "engine_stop",
			signal: "SIGKILL",
			stopIntent: true,
			sender: { kind: "supervisor", pid },
			reason: "signal:SIGTERM",
		});
	}, 30_000);

	it("reports a host child killed from outside as external", async () => {
		const qa = await supervisedScratch("external");
		await ensureSupervised(qa, { env: NO_STALL_ENV }).then((ensured) => ensured.release());
		const { pid, instanceId } = await registeredSupervisor(qa);

		process.kill(await hostChildOf(qa, instanceId), "SIGKILL");
		await expectGoneWithin(pid, 15_000);

		expect(terminalRecords(qa, instanceId)).toEqual([
			expect.objectContaining({
				detection: "external",
				stopIntent: false,
				signal: "SIGKILL",
				generation: instanceId,
			}),
		]);
	}, 30_000);

	it("lands the record while another client holds the ensure lock", async () => {
		const qa = await supervisedScratch("lockheld");
		await ensureSupervised(qa, { env: NO_STALL_ENV }).then((ensured) => ensured.release());
		const { pid, instanceId } = await registeredSupervisor(qa);
		const release = await acquireOwnershipSafeLock(`${hostEnsureLockTarget(qa.socket)}.lock`);
		try {
			process.kill(pid, "SIGTERM");
			await expectGoneWithin(pid, 5_000);
			expect(terminalRecords(qa, instanceId)).toEqual([
				expect.objectContaining({
					detection: "engine_stop",
					sender: expect.objectContaining({ kind: "supervisor" }),
				}),
			]);
		} finally {
			await release();
		}
	}, 30_000);
});

describe.skipIf(process.platform === "win32")("a supervisor its caller had to SIGKILL", () => {
	it("is recorded by the ensure whose readiness wait it failed", async () => {
		const qa = await supervisedScratch("readiness");
		let frozen: { supervisor: number; child: number; instanceId: string } | undefined;
		const failure = await ensureSupervised(qa, {
			behavior: "silent",
			env: NO_STALL_ENV,
			test: {
				readinessTimeoutMs: 3_000,
				stopTimeoutMs: 300,
				// Frozen after its readiness wait failed and before the ensure's SIGTERM, so that SIGTERM never runs.
				beforeReadinessTeardown: async () => {
					frozen = await freezeRegisteredSupervisor(qa);
				},
			},
		}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		if (frozen === undefined) throw new Error("the ensure never reached its readiness teardown");
		const { supervisor, child, instanceId } = frozen;
		await expectGoneWithin(supervisor, 5_000);
		await expectGoneWithin(child, 10_000);

		expectCallerRecord(qa, instanceId, "ensure", "readiness_timeout");
	}, 45_000);

	it("is recorded by the ensure whose start failed before the pidfile was written", async () => {
		const qa = await supervisedScratch("prepid");
		let frozen: { supervisor: number; child: number; instanceId: string } | undefined;
		const failure = await ensureSupervised(qa, {
			env: NO_STALL_ENV,
			test: {
				beforePidFileWrite: async () => {
					const instanceId = await bootInstanceId(qa);
					const child = await hostChildOf(qa, instanceId);
					const supervisor = parentOf(child);
					frozen = { supervisor, child, instanceId };
					process.kill(supervisor, "SIGSTOP");
					throw new Error("registration failed");
				},
			},
		}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		if (frozen === undefined) throw new Error("the start never reached its pidfile write");
		await expectGoneWithin(frozen.supervisor, 5_000);
		await expectGoneWithin(frozen.child, 10_000);

		expectCallerRecord(qa, frozen.instanceId, "ensure", "start_failed");
	}, 45_000);

	it("is recorded by the handoff that abandoned its successor", async () => {
		const qa = await supervisedScratch("successor");
		await ensureSupervised(qa, { env: NO_STALL_ENV }).then((ensured) => ensured.release());
		let frozen: { supervisor: number; child: number; instanceId: string } | undefined;
		const result = await handoffHost({
			socket: qa.socket,
			agentDir: qa.agentDir,
			env: NO_STALL_ENV,
			_test: {
				launch: supervisorLaunch(),
				readinessTimeoutMs: 2_000,
				afterSpawn: async (supervisor) => {
					const instanceId = await bootInstanceId(qa);
					const child = await hostChildOf(qa, instanceId);
					frozen = { supervisor, child, instanceId };
					process.kill(supervisor, "SIGSTOP");
				},
			},
		});
		expect(result.action).toBe("refuse");
		if (frozen === undefined) throw new Error("the successor was never spawned");
		await expectGoneWithin(frozen.supervisor, 5_000);
		await expectGoneWithin(frozen.child, 10_000);

		expectCallerRecord(qa, frozen.instanceId, "successor", "successor_readiness_timeout");
	}, 60_000);
});

function expectCallerRecord(qa: SupervisedScratch, instanceId: string, kind: string, reason: string): void {
	expect(terminalRecords(qa, instanceId)).toEqual([
		expect.objectContaining({
			kind: "rpc-host",
			detection: "engine_stop",
			signal: "SIGKILL",
			stopIntent: true,
			generation: instanceId,
			sender: expect.objectContaining({ kind, pid: process.pid }),
			reason: `${reason}; supervisor_escalated`,
		}),
	]);
	// The caller never saw the child start, so it claims no uptime rather than a made-up zero.
	expect(terminalRecords(qa, instanceId)[0]).not.toHaveProperty("uptimeMs");
	expect(watchdogRecords(qa, instanceId)).toHaveLength(1);
}

/**
 * Freezes the registered supervisor once its host child exists (its own record of it, written after the key
 * handoff), so the child's watchdog is guaranteed something to fire on when the caller SIGKILLs the supervisor.
 */
async function freezeRegisteredSupervisor(
	qa: SupervisedScratch,
): Promise<{ supervisor: number; child: number; instanceId: string }> {
	const { pid, instanceId } = await registeredSupervisor(qa);
	const child = await hostChildOf(qa, instanceId);
	process.kill(pid, "SIGSTOP");
	return { supervisor: pid, child, instanceId };
}
