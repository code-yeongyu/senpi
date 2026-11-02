/**
 * A REFUSED handoff leaves the endpoint exactly as it found it: the successor it started is gone, its
 * generation record and directory with it - so `status --all` never lists a dead refused successor - and
 * the boot `settings.json` it overwrote before spawning is byte-identical to what the running
 * generation was started with. Every refusal exit: the successor never answering, a failure after it
 * was spawned and recorded, and a failure before it was ever spawned.
 */
import { readdir, readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths } from "../src/modes/rpc/host-daemon-paths.ts";
import { type HandoffHostOptions, handoffHost } from "../src/modes/rpc/host-handoff.ts";
import {
	type EndpointScratch,
	endpointRow,
	endpointScratch,
	hostArgs,
	hostEnv,
	realHost,
	statusAll,
	sweepEndpointScratches,
} from "./helpers/rpc-host-endpoint-scratch.ts";
import { processAlive } from "./helpers/spawned-host-reaper.ts";

afterEach(sweepEndpointScratches, 180_000);

const neverAnswers = () => ({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1_000)"] });

async function refusedHandoff(qa: EndpointScratch, afterSpawn: (pid: number) => Promise<void>) {
	await realHost(qa, qa.legacy);
	const paths = createHostDaemonPaths({ socket: qa.legacy, agentDir: qa.agentDir });
	const settingsBefore = await readFile(paths.settingsFile);
	const pointerBefore = await readFile(paths.pointerFile);
	const generationsBefore = (await readdir(paths.generationsDir)).sort();
	let successorPid = 0;
	const result = await handoffHost({
		socket: qa.legacy,
		agentDir: qa.agentDir,
		hostArgs: hostArgs(),
		env: hostEnv(qa),
		_test: {
			launch: neverAnswers,
			readinessTimeoutMs: 1_000,
			afterSpawn: async (pid) => {
				successorPid = pid;
				await afterSpawn(pid);
			},
		} satisfies HandoffHostOptions["_test"],
	});
	return { paths, settingsBefore, pointerBefore, generationsBefore, successorPid, result };
}

async function expectUntouched(qa: EndpointScratch, refused: Awaited<ReturnType<typeof refusedHandoff>>) {
	expect(refused.successorPid).toBeGreaterThan(0);
	expect(processAlive(refused.successorPid)).toBe(false);
	const row = endpointRow((await statusAll(qa)).endpoints, qa.legacy);
	expect.soft(row.generations.map((generation) => generation.pid)).not.toContain(refused.successorPid);
	expect.soft(row.generations.every((generation) => generation.alive)).toBe(true);
	expect.soft((await readdir(refused.paths.generationsDir)).sort()).toEqual(refused.generationsBefore);
	expect
		.soft((await readFile(refused.paths.settingsFile)).toString("utf8"))
		.toBe(refused.settingsBefore.toString("utf8"));
	// The dead successor's teardown removes only its own record: the pointer still names the predecessor.
	expect
		.soft((await readFile(refused.paths.pointerFile)).toString("utf8"))
		.toBe(refused.pointerBefore.toString("utf8"));
}

describe.skipIf(process.platform === "win32")("a refused handoff leaves the endpoint as it found it", () => {
	it("removes a successor that never answered and restores the boot settings", async () => {
		const qa = endpointScratch("hrn");
		const refused = await refusedHandoff(qa, async () => {});

		expect(refused.result).toMatchObject({ action: "refuse", reason: "successor_unavailable" });
		await expectUntouched(qa, refused);
	}, 180_000);

	it("removes a successor whose handoff failed after it was recorded, and restores the boot settings", async () => {
		const qa = endpointScratch("hrf");
		const refused = await refusedHandoff(qa, async () => {
			throw new Error("successor lost after spawn");
		});

		expect(refused.result).toMatchObject({
			action: "refuse",
			reason: "successor_unavailable",
			detail: "successor lost after spawn",
		});
		await expectUntouched(qa, refused);
	}, 180_000);

	it("restores the boot settings when the successor fails before it was ever spawned", async () => {
		const qa = endpointScratch("hrb");
		await realHost(qa, qa.legacy);
		const paths = createHostDaemonPaths({ socket: qa.legacy, agentDir: qa.agentDir });
		const settingsBefore = await readFile(paths.settingsFile);
		const generationsBefore = (await readdir(paths.generationsDir)).sort();

		// The overwrite of the boot settings has already happened when this hook runs; the failure
		// sits before the old guarded section, so nothing but the refusal path can put them back.
		const result = await handoffHost({
			socket: qa.legacy,
			agentDir: qa.agentDir,
			hostArgs: hostArgs(),
			env: hostEnv(qa),
			_test: {
				launch: neverAnswers,
				readinessTimeoutMs: 1_000,
				beforeSpawn: async () => {
					throw new Error("successor never spawned");
				},
			} satisfies HandoffHostOptions["_test"],
		});

		expect(result).toMatchObject({
			action: "refuse",
			reason: "successor_unavailable",
			detail: "successor never spawned",
		});
		expect.soft((await readFile(paths.settingsFile)).toString("utf8")).toBe(settingsBefore.toString("utf8"));
		expect.soft((await readdir(paths.generationsDir)).sort()).toEqual(generationsBefore);
	}, 180_000);
});
