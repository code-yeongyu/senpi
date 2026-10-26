/**
 * senpi#1911 through real supervised hosts: a pointer left naming a dead generation is pruned by the
 * next `host status`, and the live generation that still serves the socket (and holds a session) must
 * come out of it owned, so `host stop` and `host handoff` judge its work instead of refusing
 * `unknown_owner`.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths } from "../src/modes/rpc/host-daemon-paths.ts";
import { handoffHost } from "../src/modes/rpc/host-handoff.ts";
import { readHostStatus } from "../src/modes/rpc/host-status.ts";
import { stopHost } from "../src/modes/rpc/host-stop.ts";
import { JsonlPeer, openedSessionId } from "./helpers/rpc-generation-support.ts";
import {
	endpointScratch,
	hostArgs,
	hostEnv,
	realHost,
	supervisorLaunch,
	sweepEndpointScratches,
	trackSupervisor,
	tracked,
} from "./helpers/rpc-host-endpoint-scratch.ts";
import { waitForPidGone } from "./helpers/spawned-host-reaper.ts";

afterEach(sweepEndpointScratches, 180_000);

describe.skipIf(process.platform === "win32")("a live generation whose pointer named a dead one", () => {
	it("is elected by host status, so stop and handoff find its owner", async () => {
		const qa = endpointScratch("pel");
		await realHost(qa, qa.legacy);
		const paths = createHostDaemonPaths({ socket: qa.legacy, agentDir: qa.agentDir });
		const serving = JSON.parse(await readFile(paths.pointerFile, "utf8")).instance_id as string;
		const attached = await JsonlPeer.connect(qa.legacy);
		tracked.peers.push(attached);
		openedSessionId(await attached.request({ id: "open", type: "open_session", cwd: qa.cwd }));
		const deadDir = join(paths.generationsDir, "dead");
		await mkdir(deadDir, { recursive: true, mode: 0o700 });
		const dead = { pid: await endedPid(), processStartTime: null, instance_id: "dead", socket: qa.legacy };
		await writeFile(join(deadDir, "host.pid"), `${JSON.stringify(dead)}\n`, { mode: 0o600 });
		const pointer = { layout: 2, instance_id: "dead", generation_dir: "generations/dead" };
		await writeFile(paths.pointerFile, `${JSON.stringify(pointer)}\n`, { mode: 0o600 });

		const status = await readHostStatus({ socket: qa.legacy, agentDir: qa.agentDir });
		const stopped = await stopHost({ socket: qa.legacy, agentDir: qa.agentDir });
		const handed = await handoffHost({
			socket: qa.legacy,
			agentDir: qa.agentDir,
			hostArgs: hostArgs(),
			env: hostEnv(qa),
			_test: { launch: supervisorLaunch, readinessTimeoutMs: 60_000 },
		});
		if (handed.action === "handoff") trackSupervisor(handed.pid);

		expect.soft(status).toMatchObject({ pointer: { state: "elected", instanceId: serving, candidates: [serving] } });
		expect.soft(stopped).toEqual({ action: "refuse", reason: "sessions_live" });
		expect.soft(handed).not.toMatchObject({ reason: "unknown_owner" });
		expect.soft(handed).toMatchObject({ action: "handoff", generation: 1 });
	}, 180_000);
});

/** A pid that is certainly nobody's: spawned, killed, and waited out. */
async function endedPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
	const pid = child.pid;
	if (pid === undefined) throw new Error("could not spawn a process to end");
	child.kill("SIGKILL");
	await waitForPidGone(pid, 20_000);
	return pid;
}
