import { unwatchFile, watchFile } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { hostEnsureLockTarget } from "../src/modes/rpc/host-ensure.ts";
import { handoffHost } from "../src/modes/rpc/host-handoff.ts";
import { acquireOwnershipSafeLock } from "../src/modes/rpc/ownership-safe-lock.ts";
import {
	bootInstanceId,
	ensureSupervised,
	expectGoneWithin,
	hostChildOf,
	registeredSupervisor,
	removeSupervisedScratches,
	type SupervisedScratch,
	supervisedDaemonPaths,
	supervisedScratch,
	supervisorLaunch,
	terminalRecords,
	watchdogRecords,
} from "./helpers/rpc-supervised-host.ts";
import { processesUnder, waitForPidGone } from "./helpers/spawned-host-reaper.ts";

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
		process.kill(hostChildOf(pid), "SIGSTOP");

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

		process.kill(hostChildOf(pid), "SIGKILL");
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
		const frozen = freezeSupervisorOnceRegistered(qa);
		const failure = await ensureSupervised(qa, {
			behavior: "silent",
			env: NO_STALL_ENV,
			test: { readinessTimeoutMs: 3_000, stopTimeoutMs: 300 },
		}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		const { supervisor, child, instanceId } = await frozen;
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
					const [supervisor] = processesUnder(qa.root);
					if (supervisor === undefined) throw new Error("no supervisor under the sandbox");
					const child = await hostChildWithin(supervisor, 10_000);
					frozen = { supervisor, child, instanceId: await bootInstanceId(qa) };
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
					const child = await hostChildWithin(supervisor, 10_000);
					frozen = { supervisor, child, instanceId: await bootInstanceId(qa) };
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
	expect(watchdogRecords(qa, instanceId)).toHaveLength(1);
}

/** Freezes the supervisor the moment the ensure registers it, so its own SIGTERM can never run. */
function freezeSupervisorOnceRegistered(
	qa: SupervisedScratch,
): Promise<{ supervisor: number; child: number; instanceId: string }> {
	const pointer = supervisedDaemonPaths(qa).pointerFile;
	return new Promise((resolve, reject) => {
		const onChange = (): void => {
			void registeredSupervisor(qa)
				.then(
					async ({ pid, instanceId }) => {
						unwatchFile(pointer, onChange);
						const child = await hostChildWithin(pid, 10_000);
						process.kill(pid, "SIGSTOP");
						resolve({ supervisor: pid, child, instanceId });
					},
					() => {},
				)
				.catch(reject);
		};
		watchFile(pointer, { interval: 25 }, onChange);
		setTimeout(() => {
			unwatchFile(pointer, onChange);
			reject(new Error("the ensure never registered its supervisor"));
		}, 20_000).unref();
	});
}

/** The host child appears in the process table only once the supervisor spawned it. */
async function hostChildWithin(supervisor: number, timeoutMs: number): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return hostChildOf(supervisor);
		} catch (cause) {
			if (Date.now() > deadline || (await waitForPidGone(supervisor, 25))) throw cause;
		}
	}
}
