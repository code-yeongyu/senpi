/**
 * A forced generation handoff (`senpi host handoff`) runs inside its endpoint's ensure lock, the one an
 * ensure and `host gc` take: an ensure that arrives while a handoff is bringing its successor up waits,
 * then attaches to the successor the pointer already names - never to the draining predecessor, and never
 * by starting a host of its own.
 */
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths } from "../src/modes/rpc/host-daemon-paths.ts";
import { type EnsuredHost, ensureHost, hostEnsureLockTarget } from "../src/modes/rpc/host-ensure.ts";
import { handoffHost } from "../src/modes/rpc/host-handoff.ts";
import { probeHost } from "../src/modes/rpc/host-probe.ts";
import { acquireOwnershipSafeLock } from "../src/modes/rpc/ownership-safe-lock.ts";
import {
	endpointScratch,
	hostArgs,
	hostEnv,
	realHost,
	supervisorLaunch,
	sweepEndpointScratches,
	trackSupervisor,
} from "./helpers/rpc-host-endpoint-scratch.ts";

afterEach(sweepEndpointScratches, 180_000);

async function ensureLockHeld(socket: string): Promise<boolean> {
	const lockFile = `${hostEnsureLockTarget(socket)}.lock`;
	const release = await acquireOwnershipSafeLock(lockFile, {
		retries: { retries: 0, minTimeout: 1, maxTimeout: 1 },
	}).catch((error: unknown) => {
		if (error instanceof Error && /busy|locked/i.test(error.message)) return undefined;
		throw error;
	});
	if (release === undefined) return true;
	await release();
	return false;
}

describe.skipIf(process.platform === "win32")("handoff under the endpoint's ensure lock", () => {
	it("holds the lock while the successor comes up, so a racing ensure attaches to the successor", async () => {
		const qa = endpointScratch("hol");
		await realHost(qa, qa.legacy);
		const predecessor = await probeHost({ socket: qa.legacy });
		let lockHeldInHandoff: boolean | undefined;
		let racingEnsure: Promise<EnsuredHost> | undefined;
		let instanceSeenByEnsure: string | undefined;

		const result = await handoffHost({
			socket: qa.legacy,
			agentDir: qa.agentDir,
			hostArgs: hostArgs(),
			env: hostEnv(qa),
			_test: {
				launch: supervisorLaunch,
				readinessTimeoutMs: 60_000,
				beforeSpawn: async () => {
					lockHeldInHandoff = await ensureLockHeld(qa.legacy);
					racingEnsure = ensureHost({
						socket: qa.legacy,
						agentDir: qa.agentDir,
						policy: { idleExitMs: 600_000 },
						hostArgs: hostArgs(),
						env: hostEnv(qa),
						_test: {
							readinessTimeoutMs: 60_000,
							launch: supervisorLaunch,
							afterLockAcquired: async () => {
								instanceSeenByEnsure = (await probeHost({ socket: qa.legacy }))?.instanceId;
							},
						},
					});
				},
			},
		});
		if (result.action !== "handoff") throw new Error(`handoff refused: ${JSON.stringify(result)}`);
		trackSupervisor(result.pid);
		const attached = await racingEnsure;
		attached?.release();

		expect(lockHeldInHandoff).toBe(true);
		expect(instanceSeenByEnsure).toBe(result.instanceId);
		expect(instanceSeenByEnsure).not.toBe(predecessor?.instanceId);
		expect(attached).toEqual({ pid: result.pid, socket: qa.legacy, reused: true, release: expect.any(Function) });
		const paths = createHostDaemonPaths({ socket: qa.legacy, agentDir: qa.agentDir });
		expect(JSON.parse(await readFile(paths.pointerFile, "utf8"))).toMatchObject({ instance_id: result.instanceId });
	}, 240_000);
});
