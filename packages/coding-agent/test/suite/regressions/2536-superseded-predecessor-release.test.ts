/**
 * Regression for senpi#2536: after a handoff, an ensure attached to the successor and reported `pid: 0`.
 *
 * The predecessor does not wait for the handoff's SIGUSR1. It notices on its own that the successor's
 * entry replaced the public socket, drains and exits - and its release read the pointer, found it still
 * naming itself (the handoff had not moved it yet) and removed the pointer and `settings.json`. Landing
 * just after the handoff's pointer move, that removal left the successor serving with no registration,
 * so the next ensure reused it with no pid to report. Here the predecessor's whole release runs before
 * the pointer moves, which makes it deterministic: before the fix that release still removed the
 * successor's `settings.json` (and, landing after the pointer move instead, the pointer too).
 */
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths, generationPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { handoffHost } from "../../../src/modes/rpc/host-handoff.ts";
import { probeHost } from "../../../src/modes/rpc/host-probe.ts";
import {
	endpointScratch,
	hostArgs,
	hostEnv,
	realHost,
	supervisorLaunch,
	sweepEndpointScratches,
	trackSupervisor,
} from "../../helpers/rpc-host-endpoint-scratch.ts";
import { waitForPidGone } from "../../helpers/spawned-host-reaper.ts";

afterEach(sweepEndpointScratches, 180_000);

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8").catch(() => "null"));
}

describe.skipIf(process.platform === "win32")("a predecessor that leaves before the handoff registers", () => {
	it("leaves the successor's registration and settings in place, so the next ensure reports its pid", async () => {
		const qa = endpointScratch("2536");
		const predecessorPid = await realHost(qa, qa.legacy);
		const predecessor = await probeHost({ socket: qa.legacy });
		const paths = createHostDaemonPaths({ socket: qa.legacy, agentDir: qa.agentDir });
		let predecessorGone: boolean | undefined;

		const result = await handoffHost({
			socket: qa.legacy,
			agentDir: qa.agentDir,
			hostArgs: hostArgs(),
			env: hostEnv(qa),
			_test: {
				launch: supervisorLaunch,
				readinessTimeoutMs: 60_000,
				// The successor already owns the public socket here; the predecessor sees its entry replaced
				// and drains without being signalled. Its whole release runs before the pointer moves.
				beforeRegistration: async () => {
					predecessorGone = await waitForPidGone(predecessorPid, 90_000);
				},
			},
		});
		if (result.action !== "handoff") throw new Error(`handoff refused: ${JSON.stringify(result)}`);
		trackSupervisor(result.pid);

		expect(predecessorGone).toBe(true);
		const attached = await ensureHost({
			socket: qa.legacy,
			agentDir: qa.agentDir,
			policy: { idleExitMs: 600_000 },
			hostArgs: hostArgs(),
			env: hostEnv(qa),
			_test: { readinessTimeoutMs: 60_000, launch: supervisorLaunch },
		});
		attached.release();

		expect(attached).toEqual({ pid: result.pid, socket: qa.legacy, reused: true, release: expect.any(Function) });
		expect(await readJson(paths.pointerFile)).toMatchObject({ instance_id: result.instanceId });
		// The boot settings describe the generation that serves the endpoint: the next handoff inherits
		// its lifecycle policy from them.
		expect(await readJson(paths.settingsFile)).toMatchObject({
			instanceId: result.instanceId,
			generation: result.generation,
			idleExitMs: 600_000,
		});
		expect(predecessor?.instanceId).toBeDefined();
		expect(await readJson(generationPaths(paths, predecessor?.instanceId ?? "").pidFile)).toBeNull();
	}, 240_000);
});
