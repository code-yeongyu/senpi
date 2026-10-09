import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readHostRegistration } from "../src/modes/rpc/host-daemon-registration.ts";
import { acceptsWithin, fillListenBacklog, type ListenBacklog } from "./helpers/rpc-host-backlog-fixture.ts";
import {
	ensureSupervised,
	expectGoneWithin,
	generationDir,
	processAlive,
	registeredSupervisor,
	removeSupervisedScratches,
	type SupervisedScratch,
	supervisedDaemonPaths,
	supervisedScratch,
	writeGenerationFile,
} from "./helpers/rpc-supervised-host.ts";

/**
 * senpi#2566 (IS-5): a host that is alive but stalled is still serving its sessions, so an ensure that
 * cannot reach it must refuse rather than replace it - on its own host (SIGTERM, then SIGKILL) and on a
 * foreign one (a second generation bound beside it). The stall is measured evidence the host wrote.
 */
afterEach(removeSupervisedScratches, 60_000);

const NO_STALL_ENV = { SENPI_RPC_LOOP_LAG_ERROR_MS: "600000" };
const frozen: Array<{ pid: number; backlog: ListenBacklog }> = [];
afterEach(() => {
	for (const { pid, backlog } of frozen.splice(0)) {
		backlog.release();
		if (processAlive(pid)) process.kill(pid, "SIGCONT");
	}
});

async function freezeUnreachable(qa: SupervisedScratch, stalledAgoMs: number) {
	await ensureSupervised(qa, { env: NO_STALL_ENV }).then((ensured) => ensured.release());
	const { pid, instanceId } = await registeredSupervisor(qa);
	await writeGenerationFile(qa, instanceId, "host-stalled.json", {
		at: new Date(Date.now() - stalledAgoMs).toISOString(),
		driftMs: 6_000,
		processCpuMs: 5_900,
		heapDeltaMb: 0,
	});
	process.kill(pid, "SIGSTOP");
	const backlog = await fillListenBacklog(qa.socket);
	frozen.push({ pid, backlog });
	expect(await acceptsWithin(qa.socket, 1_000)).toBe(false);
	return { pid, instanceId };
}

describe.skipIf(process.platform === "win32")("an unreachable host with fresh stall evidence", () => {
	it("is refused as host_stalled instead of being stopped and replaced", async () => {
		const qa = await supervisedScratch("stalled-own");
		const { pid, instanceId } = await freezeUnreachable(qa, 0);

		const failure = await ensureSupervised(qa, { env: NO_STALL_ENV, test: { stopTimeoutMs: 1_000 } }).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(failure).toMatchObject({ reason: "host_stalled" });
		expect(processAlive(pid)).toBe(true);
		expect(existsSync(join(generationDir(qa, instanceId), "stop-intent.json"))).toBe(false);
	}, 60_000);

	it("is refused on a foreign registration too, leaving the registration byte-identical", async () => {
		const qa = await supervisedScratch("stalled-foreign");
		const pointerFile = supervisedDaemonPaths(qa).pointerFile;
		await ensureSupervised(qa, { env: NO_STALL_ENV }).then((ensured) => ensured.release());
		// The registration's writer is read from the generation's host.pid (readHostRegistration), not the
		// pointer: naming another process there is what makes this registration foreign to the next ensure.
		const { instanceId } = await registeredSupervisor(qa);
		const pidFile = join(generationDir(qa, instanceId), "host.pid");
		const registration: unknown = JSON.parse(await readFile(pidFile, "utf8"));
		await writeFile(
			pidFile,
			`${JSON.stringify({ ...Object(registration), writer: { pid: 1, startTime: "foreign" } })}\n`,
		);
		expect((await readHostRegistration(supervisedDaemonPaths(qa)))?.writer).toEqual({ pid: 1, startTime: "foreign" });
		const { pid } = await freezeUnreachableRegistered(qa);
		const before = await readFile(pointerFile, "utf8");
		const pidBefore = await readFile(pidFile, "utf8");

		const failure = await ensureSupervised(qa, { env: NO_STALL_ENV }).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(failure).toMatchObject({ reason: "host_stalled" });
		expect(processAlive(pid)).toBe(true);
		expect(await readFile(pointerFile, "utf8")).toBe(before);
		expect(await readFile(pidFile, "utf8")).toBe(pidBefore);
	}, 60_000);

	it("is still replaced when the evidence is older than the refusal window", async () => {
		const qa = await supervisedScratch("stalled-old");
		const { pid } = await freezeUnreachable(qa, 10 * 60_000);

		await ensureSupervised(qa, { env: NO_STALL_ENV, test: { stopTimeoutMs: 1_000 } }).then((ensured) =>
			ensured.release(),
		);

		await expectGoneWithin(pid, 10_000);
	}, 60_000);
});

async function freezeUnreachableRegistered(qa: SupervisedScratch) {
	const { pid, instanceId } = await registeredSupervisor(qa);
	await writeGenerationFile(qa, instanceId, "host-stalled.json", {
		at: new Date().toISOString(),
		driftMs: 6_000,
		processCpuMs: 5_900,
		heapDeltaMb: 0,
	});
	process.kill(pid, "SIGSTOP");
	const backlog = await fillListenBacklog(qa.socket);
	frozen.push({ pid, backlog });
	expect(await acceptsWithin(qa.socket, 1_000)).toBe(false);
	return { pid, instanceId };
}
