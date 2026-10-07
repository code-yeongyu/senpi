/**
 * `senpi host gc` against REAL supervised hosts: a live endpoint is kept, an endpoint that died (uncleanly,
 * by its supervisor alone, or by idling out) is removed with its socket and siblings, a handoff whose
 * successor died is kept for its draining predecessor, a handoff whose predecessor died is kept for its booting
 * successor, and an ensure racing gc is strictly ordered by the
 * shared ensure lock. The evidence read from disk and sockets alone is `rpc-host-gc-evidence.test.ts`.
 */
import { realpathSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths } from "../src/modes/rpc/host-daemon-paths.ts";
import { gcHostEndpoints } from "../src/modes/rpc/host-gc.ts";
import { endpointInUse } from "../src/modes/rpc/host-gc-evidence.ts";
import { handoffHost } from "../src/modes/rpc/host-handoff.ts";
import { probeHost } from "../src/modes/rpc/host-probe.ts";
import { HeldAnthropicModel, JsonlPeer, openedSessionId } from "./helpers/rpc-generation-support.ts";
import {
	endpointRow,
	endpointScratch,
	hostArgs,
	hostChildren,
	hostEnv,
	realHost,
	statusAll,
	supervisorLaunch,
	sweepEndpointScratches,
	tracked,
	trackSupervisor,
} from "./helpers/rpc-host-endpoint-scratch.ts";
import { daemonTreeDigest, killEndpointUnclean } from "./helpers/rpc-host-endpoints.ts";
import {
	deadEndpoint,
	fileAppears,
	gate,
	refusingSocket,
	siblingPath,
	writeJson,
} from "./helpers/rpc-host-gc-fixtures.ts";
import { waitForPidGone } from "./helpers/spawned-host-reaper.ts";

afterEach(sweepEndpointScratches, 180_000);

const gone = expect.objectContaining({ code: "ENOENT" });

describe.skipIf(process.platform === "win32")("gc against real supervised hosts", () => {
	it("keeps a live endpoint and deletes nothing", async () => {
		const qa = endpointScratch("gca");
		await realHost(qa, qa.shard);
		const paths = createHostDaemonPaths({ socket: qa.shard, agentDir: qa.agentDir });

		expect(await gcHostEndpoints(qa.agentDir)).toEqual({
			removed: [],
			kept: [{ socket: qa.shard, dir: paths.dir, reason: "live_generation" }],
		});
		await expect(stat(paths.endpointFile)).resolves.toBeDefined();
		await expect(stat(paths.pointerFile)).resolves.toBeDefined();
		expect(await probeHost({ socket: qa.shard })).toBeDefined();
	}, 180_000);

	it("removes an uncleanly killed endpoint, its socket and its siblings, and keeps the live one beside it", async () => {
		const qa = endpointScratch("gcb");
		await Promise.all([realHost(qa, qa.shard), realHost(qa, qa.legacy)]);
		const death = await killEndpointUnclean(qa.legacy, qa.agentDir);
		tracked.internalDirs.push(...death.internalDirs);
		await refusingSocket(siblingPath(qa.legacy, ".next-4"));
		await writeJson(siblingPath(qa.legacy, ".shield-999"), {});
		const dead = createHostDaemonPaths({ socket: qa.legacy, agentDir: qa.agentDir });
		const live = createHostDaemonPaths({ socket: qa.shard, agentDir: qa.agentDir });
		await expect(stat(qa.legacy)).resolves.toBeDefined();

		expect(await gcHostEndpoints(qa.agentDir)).toEqual({
			removed: [{ socket: qa.legacy, dir: dead.dir, reason: "socket_refused" }],
			kept: [{ socket: qa.shard, dir: live.dir, reason: "live_generation" }],
		});
		for (const path of [
			dead.dir,
			qa.legacy,
			siblingPath(qa.legacy, ".next-4"),
			siblingPath(qa.legacy, ".shield-999"),
		]) {
			await expect(stat(path)).rejects.toEqual(gone);
		}
		expect(await probeHost({ socket: qa.shard })).toBeDefined();
	}, 180_000);

	it("removes an endpoint whose supervisor alone was SIGKILLed, after its host child's watchdog cleaned up", async () => {
		const qa = endpointScratch("gcw");
		const supervisor = await realHost(qa, qa.legacy);
		const children = hostChildren(supervisor);
		expect(children.length).toBeGreaterThan(0);

		process.kill(supervisor, "SIGKILL");
		for (const child of children) expect(await waitForPidGone(child, 30_000)).toBe(true);
		const row = endpointRow((await statusAll(qa)).endpoints, qa.legacy);
		expect(row).toMatchObject({ identity: "endpoint", reachable: false, generations: [] });
		const paths = createHostDaemonPaths({ socket: qa.legacy, agentDir: qa.agentDir });
		// The watchdog releases the public socket along with the registration.
		await expect(stat(qa.legacy)).rejects.toEqual(gone);

		expect(await gcHostEndpoints(qa.agentDir)).toEqual({
			removed: [{ socket: qa.legacy, dir: paths.dir, reason: "socket_absent" }],
			kept: [],
		});
		await expect(stat(paths.dir)).rejects.toEqual(gone);
	}, 180_000);

	it("removes an endpoint whose host idled out, which status --all still listed", async () => {
		const qa = endpointScratch("gcb2");
		const supervisor = await realHost(qa, qa.legacy, { idleExitMs: 500 });
		expect(await waitForPidGone(supervisor, 60_000)).toBe(true);
		const paths = createHostDaemonPaths({ socket: qa.legacy, agentDir: qa.agentDir });
		await expect(stat(paths.pointerFile)).rejects.toEqual(gone);
		expect(endpointRow((await statusAll(qa)).endpoints, qa.legacy)).toMatchObject({ reachable: false });

		expect(await gcHostEndpoints(qa.agentDir)).toEqual({
			removed: [{ socket: qa.legacy, dir: paths.dir, reason: "socket_absent" }],
			kept: [],
		});
		expect((await statusAll(qa)).endpoints).toEqual([]);
	}, 180_000);

	it("keeps an endpoint whose successor died while the drained predecessor still serves, claims untouched", async () => {
		const held = await HeldAnthropicModel.start();
		tracked.models.push(held);
		const qa = endpointScratch("gcd", held.origin);
		await realHost(qa, qa.legacy);
		const client = await JsonlPeer.connect(qa.legacy);
		tracked.peers.push(client);
		const sessionPath = join(realpathSync(qa.sessionDir), "drained.jsonl");
		const open = { id: "open", type: "open_session", cwd: qa.cwd, sessionPath, kind: "worker" };
		const sessionId = openedSessionId(await client.request(open));
		const started = client.waitFor((record) => record.type === "agent_start" && record.sessionId === sessionId);
		await client.request({ id: "prompt", type: "prompt", sessionId, message: "hold across the handoff" });
		await started;
		const successor = await handoffHost({
			socket: qa.legacy,
			agentDir: qa.agentDir,
			hostArgs: hostArgs(),
			env: hostEnv(qa),
			_test: { launch: supervisorLaunch, readinessTimeoutMs: 60_000 },
		});
		if (successor.action !== "handoff") throw new Error(`handoff refused: ${JSON.stringify(successor)}`);
		trackSupervisor(successor.pid);
		const death = await killEndpointUnclean(qa.legacy, qa.agentDir);
		tracked.internalDirs.push(...death.internalDirs);
		expect(death.supervisorPid).toBe(successor.pid);
		expect(await probeHost({ socket: qa.legacy, timeoutMs: 2_000 })).toBeUndefined();
		const paths = createHostDaemonPaths({ socket: qa.legacy, agentDir: qa.agentDir });
		const claims = await daemonTreeDigest(paths.reservationsDir);
		expect(Object.keys(claims)).not.toHaveLength(0);

		expect(await gcHostEndpoints(qa.agentDir)).toEqual({
			removed: [],
			kept: [{ socket: qa.legacy, dir: paths.dir, reason: "live_generation" }],
		});
		expect(await daemonTreeDigest(paths.reservationsDir)).toEqual(claims);
	}, 240_000);

	it("keeps an endpoint whose handoff successor is still booting after its predecessor died", async () => {
		const qa = endpointScratch("gcs");
		await realHost(qa, qa.legacy);
		const paths = createHostDaemonPaths({ socket: qa.legacy, agentDir: qa.agentDir });
		let gcWhileBooting: Awaited<ReturnType<typeof gcHostEndpoints>> | undefined;
		let evidenceWhileBooting: Awaited<ReturnType<typeof endpointInUse>> | undefined;
		const successor = await handoffHost({
			socket: qa.legacy,
			agentDir: qa.agentDir,
			hostArgs: hostArgs(),
			env: hostEnv(qa),
			_test: {
				launch: supervisorLaunch,
				readinessTimeoutMs: 60_000,
				// The predecessor dies after the handoff proved it, leaving its socket entry behind.
				beforeSpawn: async () => {
					const death = await killEndpointUnclean(qa.legacy, qa.agentDir);
					tracked.internalDirs.push(...death.internalDirs);
				},
				// Frozen, the successor can bind nothing: the evidence is only what the records say about it.
				// gc itself waits on the handoff's ensure lock; the evidence it would read is read directly.
				afterSpawn: async (pid) => {
					trackSupervisor(pid);
					process.kill(pid, "SIGSTOP");
					try {
						gcWhileBooting = await gcHostEndpoints(qa.agentDir);
						evidenceWhileBooting = await endpointInUse(paths, qa.legacy);
					} finally {
						process.kill(pid, "SIGCONT");
					}
				},
			},
		});

		expect(gcWhileBooting).toEqual({
			removed: [],
			kept: [{ socket: qa.legacy, dir: paths.dir, reason: "locked" }],
		});
		expect(evidenceWhileBooting).toEqual({ inUse: "live_generation" });
		expect(successor).toMatchObject({ action: "handoff", socket: qa.legacy });
		expect(await probeHost({ socket: qa.legacy })).toBeDefined();
	}, 240_000);

	it("lets an ensure that recreated endpoint.json while gc held the lock start a host that stays listed", async () => {
		const qa = endpointScratch("gce2");
		const paths = await deadEndpoint(qa.legacy, qa.agentDir);
		const holding = gate();
		const gc = gcHostEndpoints(qa.agentDir, { _test: { afterLockAcquired: holding.hook } });
		await holding.entered;
		await rm(paths.endpointFile);
		const recreated = fileAppears(paths.endpointFile);
		const ensured = realHost(qa, qa.legacy, { idleExitMs: 1_500 });
		await recreated;
		holding.open();

		expect(await gc).toEqual({ removed: [{ socket: qa.legacy, dir: paths.dir, reason: "socket_absent" }], kept: [] });
		const supervisor = await ensured;
		await expect(stat(paths.endpointFile)).resolves.toBeDefined();
		expect(await waitForPidGone(supervisor, 60_000)).toBe(true);
		expect(endpointRow((await statusAll(qa)).endpoints, qa.legacy)).toMatchObject({
			identity: "endpoint",
			reachable: false,
		});
	}, 180_000);
});
