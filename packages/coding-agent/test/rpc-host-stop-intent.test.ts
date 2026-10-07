import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stopHost } from "../src/modes/rpc/host-stop.ts";
import {
	ensureSupervised,
	expectGoneWithin,
	generationDir,
	hostChildOf,
	registeredSupervisor,
	removeSupervisedScratches,
	supervisedScratch,
	terminalRecords,
	writeGenerationFile,
} from "./helpers/rpc-supervised-host.ts";

/**
 * senpi#2566: every engine-sent host signal is preceded by a stop intent in the TARGET generation's
 * directory, so the record the supervisor writes when its child dies names the original sender and
 * the reason - never just "the supervisor". Real supervisors; the record is read after the fact.
 */
afterEach(removeSupervisedScratches, 60_000);

const NO_STALL_ENV = { SENPI_RPC_LOOP_LAG_ERROR_MS: "600000" };

describe.skipIf(process.platform === "win32")("host stop intent", () => {
	it("names the ensure that replaced an unreachable host, then the supervisor's own step", async () => {
		const qa = await supervisedScratch("replace");
		await ensureSupervised(qa, { env: NO_STALL_ENV }).then((ensured) => ensured.release());
		const { pid, instanceId } = await registeredSupervisor(qa);
		// Nothing can reach the generation any more, yet its supervisor is alive: the replacement path.
		await unlink(qa.socket);

		await ensureSupervised(qa, { env: NO_STALL_ENV }).then((ensured) => ensured.release());
		await expectGoneWithin(pid, 15_000);

		expect(terminalRecords(qa, instanceId)).toEqual([
			expect.objectContaining({
				kind: "rpc-host",
				detection: "engine_stop",
				stopIntent: true,
				sender: expect.objectContaining({ kind: "ensure", pid: process.pid }),
				chain: [
					expect.objectContaining({ kind: "ensure", pid: process.pid }),
					expect.objectContaining({ kind: "supervisor", pid }),
				],
				reason: expect.stringMatching(/^replace_unreachable -> signal:SIGTERM/),
			}),
		]);
	}, 45_000);

	it("names the supervisor alone when it idles its host out", async () => {
		const qa = await supervisedScratch("idle");
		await ensureSupervised(qa, { env: { ...NO_STALL_ENV, SENPI_RPC_HOST_IDLE_EXIT_MS: "1500" } }).then((ensured) =>
			ensured.release(),
		);
		const { pid, instanceId } = await registeredSupervisor(qa);

		await expectGoneWithin(pid, 20_000);

		const [record] = terminalRecords(qa, instanceId);
		expect(record).toMatchObject({
			detection: "engine_stop",
			stopIntent: true,
			sender: { kind: "supervisor", pid },
			reason: "idle",
		});
		expect(record?.chain).toBeUndefined();
	}, 45_000);

	it("ignores a stale intent, so an outside kill still reads as external", async () => {
		const qa = await supervisedScratch("stale");
		await ensureSupervised(qa, { env: NO_STALL_ENV }).then((ensured) => ensured.release());
		const { pid, instanceId } = await registeredSupervisor(qa);
		await writeGenerationFile(qa, instanceId, "stop-intent.json", {
			sender: { pid: process.pid, kind: "ensure" },
			targetPid: pid,
			reason: "replace_unreachable",
			signal: "SIGTERM",
			at: new Date(Date.now() - 10 * 60_000).toISOString(),
		});

		process.kill(hostChildOf(pid), "SIGKILL");
		await expectGoneWithin(pid, 15_000);

		expect(terminalRecords(qa, instanceId)).toEqual([
			expect.objectContaining({ detection: "external", stopIntent: false, signal: "SIGKILL" }),
		]);
	}, 45_000);

	it("records an operator stop with its reason after the supervisor finished with the generation", async () => {
		const qa = await supervisedScratch("operator");
		await ensureSupervised(qa, { env: NO_STALL_ENV }).then((ensured) => ensured.release());
		const { pid, instanceId } = await registeredSupervisor(qa);

		const result = await stopHost({ socket: qa.socket, agentDir: qa.agentDir, force: true });
		expect(result).toEqual({ action: "stopped", pid });
		await expectGoneWithin(pid, 15_000);

		expect(terminalRecords(qa, instanceId)).toEqual([
			expect.objectContaining({
				detection: "engine_stop",
				sender: expect.objectContaining({ kind: "stop", pid: process.pid }),
				chain: [expect.objectContaining({ kind: "stop" }), expect.objectContaining({ kind: "supervisor", pid })],
				reason: expect.stringMatching(/^operator_stop -> signal:SIGTERM/),
			}),
		]);
		expect(existsSync(generationDir(qa, instanceId))).toBe(false);
	}, 45_000);

	it("writes no intent for a drain, which ends no work", async () => {
		const qa = await supervisedScratch("drain");
		await ensureSupervised(qa, { env: NO_STALL_ENV }).then((ensured) => ensured.release());
		const { pid, instanceId } = await registeredSupervisor(qa);

		const result = await stopHost({ socket: qa.socket, agentDir: qa.agentDir, drain: true });

		expect(result).toEqual({ action: "drained", pid });
		expect(existsSync(join(generationDir(qa, instanceId), "stop-intent.json"))).toBe(false);
	}, 45_000);
});
