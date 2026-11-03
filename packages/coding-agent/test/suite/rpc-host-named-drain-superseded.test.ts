import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopHost } from "../../src/modes/rpc/host-stop.ts";
import * as drainRequest from "../../src/modes/rpc/host-stop-intent.ts";
import {
	ensureSupervised,
	expectGoneWithin,
	fileAppears,
	generationDir,
	registeredSupervisor,
	removeSupervisedScratches,
	type SupervisedScratch,
	supervisedDaemonPaths,
	supervisedScratch,
} from "../helpers/rpc-supervised-host.ts";

// senpi#3657 review: the desktop drains the generation that still holds a session after the pointer moved on
// (desktop#3157), so the named drain must work on a SUPERSEDED generation, refuse an id that could leave the
// generations directory, and treat a generation that ended between the ownership check and the request as drained.
vi.mock("../../src/modes/rpc/host-stop-intent.ts", { spy: true });

afterEach(async () => {
	vi.restoreAllMocks();
	await removeSupervisedScratches();
}, 60_000);

const NO_STALL_ENV = { SENPI_RPC_LOOP_LAG_ERROR_MS: "600000" };

async function supervisedGeneration(
	label: string,
): Promise<{ qa: SupervisedScratch; pid: number; instanceId: string }> {
	const qa = await supervisedScratch(label);
	await ensureSupervised(qa, { env: NO_STALL_ENV }).then((ensured) => ensured.release());
	const { pid, instanceId } = await registeredSupervisor(qa);
	const marker = join(generationDir(qa, instanceId), "drain-watch.json");
	if (!existsSync(marker)) await fileAppears(marker, 10_000);
	return { qa, pid, instanceId };
}

async function pointAtAnotherInstance(qa: SupervisedScratch): Promise<void> {
	const pointerFile = supervisedDaemonPaths(qa).pointerFile;
	const pointer = JSON.parse(await readFile(pointerFile, "utf8"));
	await writeFile(pointerFile, `${JSON.stringify({ ...pointer, instance_id: "successor-instance" })}\n`, {
		mode: 0o600,
	});
}

describe("named drain of a superseded generation (senpi#3657 review M2)", () => {
	it("drains the named generation after the pointer moved to another instance", async () => {
		const { qa, pid, instanceId } = await supervisedGeneration("superseded-drain");
		await pointAtAnotherInstance(qa);

		const result = await stopHost({
			socket: qa.socket,
			agentDir: qa.agentDir,
			drain: true,
			instanceId,
			waitMs: 20_000,
		});

		expect(result).toEqual({ action: "drained", pid, instanceId, exited: true });
		await expectGoneWithin(pid, 5_000);
	}, 60_000);

	it("refuses an instance id that would leave the generations directory, and sends nothing", async () => {
		const { qa, pid } = await supervisedGeneration("escaping-id");
		const write = vi.mocked(drainRequest.writeDrainRequest);

		const result = await stopHost({ socket: qa.socket, agentDir: qa.agentDir, drain: true, instanceId: "../escape" });

		expect(result).toEqual({ action: "refuse", reason: "unknown_owner" });
		expect(write).not.toHaveBeenCalled();
		expect(() => process.kill(pid, 0)).not.toThrow();
	}, 45_000);
});

describe("a generation that ends before the drain request lands (senpi#3657 review M1)", () => {
	it("reports drained instead of failing when its directory is already gone", async () => {
		const { qa, pid, instanceId } = await supervisedGeneration("gone-before-request");
		const gone = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
		vi.mocked(drainRequest.writeDrainRequest).mockRejectedValueOnce(gone);

		const result = await stopHost({ socket: qa.socket, agentDir: qa.agentDir, drain: true, instanceId });

		expect(result).toEqual({ action: "drained", pid, instanceId });
	}, 45_000);
});
