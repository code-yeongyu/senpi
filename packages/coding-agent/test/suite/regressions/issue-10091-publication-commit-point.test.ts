// code-yeongyu/oh-my-openagent#10091: publication is the commit point of a generation handoff. Before it, the
// handoff can always withdraw its successor; after it, a failing bookkeeping step is repaired forward and the
// generation that took the public socket is never stopped by the handoff that started it.
import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths, ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { handoffHost } from "../../../src/modes/rpc/host-handoff.ts";
import { probeHost } from "../../../src/modes/rpc/host-probe.ts";
import {
	GENERATION_HOST_ARGS,
	type GenerationScratch,
	generationEnv,
	generationScratch,
	reapProcessesUnder,
	supervisorLaunch,
	waitForPidGone,
} from "../../helpers/rpc-generation-support.ts";
import { writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";

const scratches: GenerationScratch[] = [];

afterEach(async () => {
	for (const qa of scratches.splice(0)) {
		await reapProcessesUnder(qa.root);
		await rm(qa.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}, 120_000);

async function generation(label: string): Promise<{ qa: GenerationScratch; pid: number; instanceId: string }> {
	const qa = generationScratch(label);
	scratches.push(qa);
	writeRpcModelsJson(qa.agentDir, "http://127.0.0.1:1");
	const ensured = await ensureHost({
		socket: qa.socket,
		agentDir: qa.agentDir,
		policy: { idleExitMs: 600_000 },
		hostArgs: [...GENERATION_HOST_ARGS],
		env: generationEnv(qa),
		_test: { readinessTimeoutMs: 60_000, launch: supervisorLaunch },
	});
	const host = await probeHost({ socket: qa.socket });
	if (host?.instanceId === undefined) throw new Error("the first generation did not answer");
	return { qa, pid: ensured.pid, instanceId: host.instanceId };
}

async function successorToken(qa: GenerationScratch): Promise<string> {
	const { generationsDir } = createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
	for (const name of await readdir(generationsDir)) {
		const entries = await readdir(join(generationsDir, name)).catch(() => [] as string[]);
		if (entries.includes("publish-token")) return join(generationsDir, name, "publish-token");
	}
	throw new Error("the handoff wrote no publication token for its successor");
}

describe.skipIf(process.platform === "win32")("the publication commit point of a generation handoff", () => {
	it("never lets a successor whose publication was withdrawn take the socket", async () => {
		const first = await generation("withdrawn");
		let successorPid: number | undefined;

		const result = await handoffHost({
			socket: first.qa.socket,
			agentDir: first.qa.agentDir,
			hostArgs: [...GENERATION_HOST_ARGS],
			env: generationEnv(first.qa),
			_test: {
				launch: supervisorLaunch,
				readinessTimeoutMs: 60_000,
				// The publication is withdrawn before the successor could have bound anything, the way the
				// handoff withdraws it: its token is renamed away.
				afterSpawn: async (pid) => {
					successorPid = pid;
					const token = await successorToken(first.qa);
					await rename(token, `${token}.revoked`);
				},
			},
		});

		expect(result).toMatchObject({ action: "refuse", upgradeable: true });
		expect((await probeHost({ socket: first.qa.socket }))?.instanceId).toBe(first.instanceId);
		expect(successorPid === undefined ? true : await waitForPidGone(successorPid, 30_000)).toBe(true);
	}, 180_000);

	it("repairs a registration failure after publication forward instead of stopping the successor", async () => {
		const first = await generation("repair");

		const result = await handoffHost({
			socket: first.qa.socket,
			agentDir: first.qa.agentDir,
			hostArgs: [...GENERATION_HOST_ARGS],
			env: generationEnv(first.qa),
			_test: {
				launch: supervisorLaunch,
				readinessTimeoutMs: 60_000,
				beforeRegistration: async () => {
					throw new Error("registration unwritable");
				},
			},
		});

		expect(result).toMatchObject({ action: "handoff", repair: expect.stringContaining("registration unwritable") });
		const serving = await probeHost({ socket: first.qa.socket });
		expect(serving?.instanceId).toBe(result.action === "handoff" ? result.instanceId : "");
		expect(serving?.instanceId).not.toBe(first.instanceId);
		expect(await waitForPidGone(first.pid, 60_000)).toBe(true);
	}, 180_000);
});
