/**
 * `senpi host status --all` and the durable endpoint identity it enumerates by - against REAL
 * supervised hosts wherever a host is involved, because what is under test is what a client observes
 * on disk and over the socket. The shard naming contract and the per-session host identity have their
 * own suites (`rpc-host-shard-naming`, `rpc-host-session-identity`).
 */
import { realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths, daemonDirectoryName } from "../src/modes/rpc/host-daemon-paths.ts";
import { listHostEndpoints } from "../src/modes/rpc/host-endpoints.ts";
import { handoffHost } from "../src/modes/rpc/host-handoff.ts";
import { probeHost } from "../src/modes/rpc/host-probe.ts";
import { readHostStatus } from "../src/modes/rpc/host-status.ts";
import { HeldAnthropicModel, JsonlPeer, openedSessionId } from "./helpers/rpc-generation-support.ts";
import {
	canonicalSocket,
	endpointRow,
	endpointScratch,
	hostArgs,
	hostChildren,
	hostEnv,
	realHost,
	SHARD_KEY,
	statusAll,
	supervisorLaunch,
	sweepEndpointScratches,
	tracked,
	trackSupervisor,
} from "./helpers/rpc-host-endpoint-scratch.ts";
import { daemonTreeDigest, killEndpointUnclean } from "./helpers/rpc-host-endpoints.ts";
import { waitForPidGone } from "./helpers/spawned-host-reaper.ts";

afterEach(sweepEndpointScratches, 180_000);

describe("endpoint enumeration from disk", () => {
	it("answers an agent directory without layout 2 with no endpoints and a refusal", async () => {
		const qa = endpointScratch("nolayout");
		await mkdir(join(qa.agentDir, "rpc-host-daemon", "0123456789abcdef"), { recursive: true });

		expect(await statusAll(qa)).toEqual({ exitCode: 3, endpoints: [] });
	});

	it("names each directory by the best evidence it holds, and never throws on one that holds none", async () => {
		const qa = endpointScratch("identity");
		const flat = join(qa.agentDir, "rpc-host-daemon");
		const bySettings = join(qa.root, "settings.sock");
		const byGeneration = join(qa.root, "generation.sock");
		await mkdir(join(flat, daemonDirectoryName(byGeneration), "generations", "g-1"), { recursive: true });
		await writeFile(join(flat, "layout.json"), `${JSON.stringify({ layout: 2, dir: "x" })}\n`);
		await writeFile(
			join(flat, daemonDirectoryName(byGeneration), "generations", "g-1", "settings.json"),
			JSON.stringify({ socket: byGeneration }),
		);
		await mkdir(join(flat, daemonDirectoryName(bySettings)), { recursive: true });
		await writeFile(
			join(flat, daemonDirectoryName(bySettings), "settings.json"),
			JSON.stringify({ socket: bySettings }),
		);
		// A file naming ANOTHER socket is not evidence about this directory.
		await mkdir(join(flat, "0123456789abcdef"), { recursive: true });
		const forged = JSON.stringify({ layout: 2, socket: join(qa.root, "forged.sock") });
		await writeFile(join(flat, "0123456789abcdef", "endpoint.json"), forged);

		const endpoints = await listHostEndpoints(qa.agentDir);

		expect(endpoints).toContainEqual({
			socket: byGeneration,
			dir: join(flat, daemonDirectoryName(byGeneration)),
			identity: "generation-settings",
			endpoint_kind: "rpc_host",
		});
		expect(endpoints).toContainEqual({
			socket: bySettings,
			dir: join(flat, daemonDirectoryName(bySettings)),
			identity: "settings",
			endpoint_kind: "rpc_host",
		});
		expect(endpoints).toContainEqual({
			socket: null,
			dir: join(flat, "0123456789abcdef"),
			identity: "unknown",
			endpoint_kind: "rpc_host",
		});
		const all = await statusAll(qa);
		expect(all.exitCode).toBe(3);
		expect(all.endpoints).toHaveLength(3);
		expect(endpointRow(all.endpoints, byGeneration)).toMatchObject({
			reachable: false,
			identity: "generation-settings",
		});
		expect(all.endpoints.find((endpoint) => endpoint.socket === null)).toMatchObject({
			identity: "unknown",
			reachable: false,
			generations: [],
			crashes: 0,
		});
	});
});

describe.skipIf(process.platform === "win32")("host status --all against real hosts", () => {
	it("lists a shard and the legacy endpoint, both reachable, labelled by shard", async () => {
		const qa = endpointScratch("two");
		await Promise.all([realHost(qa, qa.shard), realHost(qa, qa.legacy)]);

		const { exitCode, endpoints } = await statusAll(qa);

		expect(exitCode).toBe(0);
		expect(endpoints).toHaveLength(2);
		expect(endpointRow(endpoints, qa.shard)).toMatchObject({
			reachable: true,
			identity: "endpoint",
			shard: { kind: "p", key: SHARD_KEY },
			crashes: 0,
			endpoint_kind: "rpc_host",
			alive: true,
			reason: null,
		});
		expect(endpointRow(endpoints, qa.legacy)).toMatchObject({
			reachable: true,
			identity: "endpoint",
			shard: null,
			endpoint_kind: "rpc_host",
			alive: true,
			reason: null,
		});
		const identityFile = createHostDaemonPaths({ socket: qa.shard, agentDir: qa.agentDir }).endpointFile;
		expect(JSON.parse(await readFile(identityFile, "utf8"))).toEqual({
			layout: 2,
			registry_version: 1,
			endpoint_kind: "rpc_host",
			socket: qa.shard,
			created_at: expect.any(String),
		});
		expect((await stat(identityFile)).mode & 0o777).toBe(0o600);
	}, 180_000);

	it("keeps listing an endpoint whose supervised host crashed, with the crash counted", async () => {
		const qa = endpointScratch("crash");
		const [supervisor] = await Promise.all([realHost(qa, qa.shard), realHost(qa, qa.legacy)]);
		const children = hostChildren(supervisor);
		expect(children.length).toBeGreaterThan(0);

		for (const child of children) process.kill(child, "SIGKILL");
		expect(await waitForPidGone(supervisor, 30_000)).toBe(true);
		const { exitCode, endpoints } = await statusAll(qa);

		expect(exitCode).toBe(0);
		expect(endpointRow(endpoints, qa.shard)).toMatchObject({
			reachable: false,
			identity: "endpoint",
			generations: [],
			crashes: 1,
			pid: null,
		});
		const paths = createHostDaemonPaths({ socket: qa.shard, agentDir: qa.agentDir });
		await expect(stat(paths.stderrLog)).resolves.toBeDefined();
		await expect(stat(join(paths.dir, "crashes.jsonl"))).resolves.toBeDefined();
	}, 180_000);

	it("reports an unclean death's stale registration without touching a byte, while one status prunes it", async () => {
		const qa = endpointScratch("stale");
		await Promise.all([realHost(qa, qa.shard), realHost(qa, qa.legacy)]);
		const death = await killEndpointUnclean(qa.shard, qa.agentDir);
		tracked.internalDirs.push(...death.internalDirs);
		const daemonRoot = join(qa.agentDir, "rpc-host-daemon");
		const before = await daemonTreeDigest(daemonRoot);

		const { exitCode, endpoints } = await statusAll(qa);

		expect(exitCode).toBe(0);
		const stale = endpointRow(endpoints, qa.shard);
		expect(stale.reachable).toBe(false);
		expect(stale.generations).toEqual([
			expect.objectContaining({ instanceId: death.instanceId, pid: death.supervisorPid, alive: false }),
		]);
		expect(await daemonTreeDigest(daemonRoot)).toEqual(before);
		// The single-socket read is unchanged: reading is cleaning, there.
		const single = await readHostStatus({ socket: qa.shard, agentDir: qa.agentDir });
		expect(single.generations).toEqual([]);
		const paths = createHostDaemonPaths({ socket: qa.shard, agentDir: qa.agentDir });
		await expect(stat(paths.pointerFile)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(join(paths.generationsDir, death.instanceId))).rejects.toMatchObject({ code: "ENOENT" });
	}, 180_000);

	it("keeps listing an endpoint whose host idled out, with no crash", async () => {
		const qa = endpointScratch("idle");
		const supervisor = await realHost(qa, qa.shard, { idleExitMs: 500 });

		expect(await waitForPidGone(supervisor, 60_000)).toBe(true);
		const { exitCode, endpoints } = await statusAll(qa);

		expect(exitCode).toBe(3);
		expect(endpoints).toEqual([
			expect.objectContaining({ socket: qa.shard, reachable: false, generations: [], crashes: 0, pid: null }),
		]);
	}, 180_000);

	it("lists worker rows with path, context and attachments, and both generations of a live handoff", async () => {
		const held = await HeldAnthropicModel.start();
		tracked.models.push(held);
		const qa = endpointScratch("rows", held.origin);
		await realHost(qa, qa.legacy);
		const instanceId = (await probeHost({ socket: qa.legacy }))?.instanceId;
		const sessionPath = join(realpathSync(qa.sessionDir), "worker.jsonl");
		const client = await JsonlPeer.connect(qa.legacy);
		tracked.peers.push(client);
		const sessionId = openedSessionId(
			await client.request({
				id: "open",
				type: "open_session",
				cwd: qa.cwd,
				sessionPath,
				kind: "worker",
				context: { tree_key: "tree-7" },
			}),
		);

		expect(endpointRow((await statusAll(qa)).endpoints, qa.legacy).session_rows).toEqual([]);
		const listed = endpointRow((await statusAll(qa, true)).endpoints, qa.legacy);
		expect(listed.session_rows).toEqual([
			{
				id: sessionId,
				kind: "worker",
				session_path: sessionPath,
				cwd: qa.cwd,
				name: null,
				attachments: 1,
				context: { tree_key: "tree-7", host_socket: canonicalSocket(qa.legacy), host_instance: instanceId },
				// senpi#1960: the host publishes its live heap split; the main heap moves, the kernel split is exact.
				memory: { main_heap_mb: expect.any(Number), kernel_heap_mb: 0, kernel_count: 0 },
			},
		]);
		expect(listed.claims_live).toBe(1);
		expect(listed.claims).toEqual([
			expect.objectContaining({ session_path: sessionPath, instance_id: instanceId, generation: 0, live: true }),
		]);

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

		const during = endpointRow((await statusAll(qa, true)).endpoints, qa.legacy);
		expect(during.generations.map((generation) => [generation.generation, generation.alive])).toEqual([
			[0, true],
			[1, true],
		]);
		for (const generation of during.generations) {
			expect(generation).toHaveProperty("rss_mb");
			expect(generation).toHaveProperty("host_rss_mb");
		}
		expect(during).toHaveProperty("rss_mb");
		expect(during).toHaveProperty("host_rss_mb");
		expect(during.claims).toEqual([expect.objectContaining({ session_path: sessionPath, instance_id: instanceId })]);
	}, 240_000);

	it("admits three workers under endpoint pressure and reports both RSS measures and the pressure state", async () => {
		const qa = endpointScratch("pressure");
		const previousWarn = process.env.SENPI_RPC_HOST_RSS_WARN_MB;
		process.env.SENPI_RPC_HOST_RSS_WARN_MB = "1";
		try {
			await realHost(qa, qa.shard);
			const client = await JsonlPeer.connect(qa.shard);
			tracked.peers.push(client);
			// The sampler's first reading lands one sample interval after start; the record it broadcasts
			// is the moment the host holds the pressure state.
			const pressured = client.waitFor((record) => record.type === "host_memory_pressure", 90_000);
			const sessionPaths = [1, 2, 3].map((index) => join(qa.sessionDir, `worker-${index}.jsonl`));
			for (const [index, sessionPath] of sessionPaths.entries()) {
				const response = await client.request({
					id: `open-${index}`,
					type: "open_session",
					cwd: qa.cwd,
					sessionPath,
					kind: "worker",
				});
				expect(response.type).toBe("response");
				expect(response.error).toBeUndefined();
			}

			await pressured;

			const row = endpointRow((await statusAll(qa, true)).endpoints, qa.shard);
			expect(row.session_rows).toHaveLength(3);
			expect(row).toHaveProperty("rss_mb");
			expect(row).toHaveProperty("host_rss_mb");
			expect(row.memory_pressure).toBe(true);
		} finally {
			if (previousWarn === undefined) delete process.env.SENPI_RPC_HOST_RSS_WARN_MB;
			else process.env.SENPI_RPC_HOST_RSS_WARN_MB = previousWarn;
		}
		await realHost(qa, qa.legacy);

		const rows = (await statusAll(qa)).endpoints;
		expect(endpointRow(rows, qa.legacy).memory_pressure).toBe(false);
		expect(endpointRow(rows, qa.shard).memory_pressure).toBe(true);
	}, 240_000);
});
