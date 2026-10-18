/**
 * The one endpoint registry: `endpoint.json` records `registry_version` and `endpoint_kind`
 * (`rpc_host` | `tui`) additively, a legacy record reads as `rpc_host`, `status --all` bounds a `tui`
 * row's probe so one silent terminal never stalls the listing, and `gc` can be narrowed to `tui`
 * endpoints without touching a host's. The liveness verdict itself is `rpc-host-endpoint-liveness`.
 * Everything here is built on disk with sockets the test owns; no host process is started.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonDirectories, createHostDaemonPaths } from "../../src/modes/rpc/host-daemon-paths.ts";
import { listHostEndpoints } from "../../src/modes/rpc/host-endpoints.ts";
import { acquireHostEnsureLock } from "../../src/modes/rpc/host-ensure-lock.ts";
import { gcHostEndpoints } from "../../src/modes/rpc/host-gc.ts";
import { readAllHostStatus } from "../../src/modes/rpc/host-status-all.ts";
import { endpointRow, endpointScratch, statusAll } from "../helpers/rpc-host-endpoint-scratch.ts";
import { exitedPid, gate } from "../helpers/rpc-host-gc-fixtures.ts";
import {
	closeRegistryFixtures,
	legacyRecord,
	liveRecord,
	registered,
	silentSocket,
} from "./rpc-endpoint-registry-fixtures.ts";

afterEach(closeRegistryFixtures, 180_000);

const gone = expect.objectContaining({ code: "ENOENT" });

describe("endpoint.json registry schema", () => {
	it("records registry_version and endpoint_kind, and reads a legacy record as rpc_host without rewriting it", async () => {
		const qa = endpointScratch("reg");
		const tui = join(qa.root, "rpc", "tui", "t-0123456789abcdef.sock");
		const host = createHostDaemonPaths({ socket: qa.shard, agentDir: qa.agentDir });
		await createDaemonDirectories(host);
		const terminal = createHostDaemonPaths({ socket: tui, agentDir: qa.agentDir });
		await createDaemonDirectories(terminal, { kind: "tui" });
		const legacy = await legacyRecord(qa.agentDir, qa.legacy);
		const legacyBytes = await readFile(legacy.endpointFile, "utf8");

		expect(JSON.parse(await readFile(host.endpointFile, "utf8"))).toEqual({
			layout: 2,
			registry_version: 1,
			endpoint_kind: "rpc_host",
			socket: qa.shard,
			created_at: expect.any(String),
		});
		expect(JSON.parse(await readFile(terminal.endpointFile, "utf8"))).toEqual({
			layout: 2,
			registry_version: 1,
			endpoint_kind: "tui",
			socket: tui,
			created_at: expect.any(String),
		});
		const endpoints = await listHostEndpoints(qa.agentDir);
		expect(endpoints).toHaveLength(3);
		expect(endpoints).toContainEqual({
			socket: qa.shard,
			dir: host.dir,
			identity: "endpoint",
			endpoint_kind: "rpc_host",
		});
		expect(endpoints).toContainEqual({ socket: tui, dir: terminal.dir, identity: "endpoint", endpoint_kind: "tui" });
		expect(endpoints).toContainEqual({
			socket: qa.legacy,
			dir: legacy.dir,
			identity: "endpoint",
			endpoint_kind: "rpc_host",
		});

		const rows = await readAllHostStatus({ agentDir: qa.agentDir, includeWorkers: false });
		expect(rows.map((row) => [row.socket, row.endpoint_kind])).toEqual(
			endpoints.map((endpoint) => [endpoint.socket, endpoint.endpoint_kind]),
		);
		expect(await readFile(legacy.endpointFile, "utf8")).toBe(legacyBytes);
	});
});

describe.skipIf(process.platform === "win32")("status --all with a registered-but-silent tui endpoint", () => {
	it("returns every row in under 2 s, the tui row reported live_unresponsive", async () => {
		const qa = endpointScratch("stall");
		const tui = join(qa.root, "rpc", "tui", "t-stall.sock");
		await legacyRecord(qa.agentDir, qa.legacy);
		await createDaemonDirectories(createHostDaemonPaths({ socket: qa.shard, agentDir: qa.agentDir }));
		await silentSocket(tui);
		await registered(qa.agentDir, tui, "tui", await liveRecord());

		const started = Date.now();
		const { exitCode, endpoints } = await statusAll(qa);
		const elapsed = Date.now() - started;

		expect(elapsed).toBeLessThan(2_000);
		expect(exitCode).toBe(3);
		expect(endpoints).toHaveLength(3);
		expect(endpointRow(endpoints, tui)).toMatchObject({
			endpoint_kind: "tui",
			reachable: false,
			alive: false,
			reason: "live_unresponsive",
		});
		expect(endpointRow(endpoints, qa.legacy)).toMatchObject({
			endpoint_kind: "rpc_host",
			alive: false,
			reason: "dead",
		});
		expect(endpointRow(endpoints, qa.shard)).toMatchObject({
			endpoint_kind: "rpc_host",
			alive: false,
			reason: "dead",
		});
	});

	it("caps a tui row at its own budget even when the caller grants every row a longer one", async () => {
		const qa = endpointScratch("cap");
		const tui = join(qa.root, "rpc", "tui", "t-cap.sock");
		await silentSocket(tui);
		await registered(qa.agentDir, tui, "tui", await liveRecord());

		const started = Date.now();
		const rows = await readAllHostStatus({ agentDir: qa.agentDir, includeWorkers: true, timeoutMs: 60_000 });

		expect(Date.now() - started).toBeLessThan(2_000);
		expect(rows).toEqual([expect.objectContaining({ socket: tui, reason: "live_unresponsive", session_rows: [] })]);
	});
});

describe.skipIf(process.platform === "win32")("gc narrowed to tui endpoints", () => {
	it("reaps only dead tui endpoints, keeps a live one, and never reports or touches a host's", async () => {
		const qa = endpointScratch("kinds");
		const deadTui = join(qa.root, "rpc", "tui", "t-dead.sock");
		const liveTui = join(qa.root, "rpc", "tui", "t-live.sock");
		const deadTuiPaths = await registered(qa.agentDir, deadTui, "tui", {
			pid: await exitedPid(),
			processStartTime: "x",
		});
		await silentSocket(liveTui);
		const liveTuiPaths = await registered(qa.agentDir, liveTui, "tui", await liveRecord());
		const host = createHostDaemonPaths({ socket: qa.legacy, agentDir: qa.agentDir });
		await createDaemonDirectories(host);

		expect(await gcHostEndpoints(qa.agentDir, { kinds: ["tui"] })).toEqual({
			removed: [{ socket: deadTui, dir: deadTuiPaths.dir, reason: "socket_absent" }],
			kept: [{ socket: liveTui, dir: liveTuiPaths.dir, reason: "live_generation" }],
		});
		await expect(stat(deadTuiPaths.dir)).rejects.toEqual(gone);
		await expect(stat(host.endpointFile)).resolves.toBeDefined();

		expect(await gcHostEndpoints(qa.agentDir)).toEqual({
			removed: [{ socket: qa.legacy, dir: host.dir, reason: "socket_absent" }],
			kept: [{ socket: liveTui, dir: liveTuiPaths.dir, reason: "live_generation" }],
		});
	});

	it("serializes a tui registrant behind a tui gc on the endpoint's ensure lock", async () => {
		const qa = endpointScratch("race");
		const socket = join(qa.root, "rpc", "tui", "t-race.sock");
		const paths = await registered(qa.agentDir, socket, "tui", { pid: await exitedPid(), processStartTime: "x" });
		const holding = gate();

		const gc = gcHostEndpoints(qa.agentDir, { kinds: ["tui"], _test: { afterLockAcquired: holding.hook } });
		await holding.entered;
		await expect(acquireHostEnsureLock(socket, 0)).rejects.toThrow();
		holding.open();
		expect(await gc).toEqual({ removed: [{ socket, dir: paths.dir, reason: "socket_absent" }], kept: [] });

		const release = await acquireHostEnsureLock(socket, 2_000);
		try {
			await registered(qa.agentDir, socket, "tui", await liveRecord(), "gen-b");
		} finally {
			await release();
		}
		expect(await listHostEndpoints(qa.agentDir)).toEqual([
			{ socket, dir: paths.dir, identity: "endpoint", endpoint_kind: "tui" },
		]);
	});
});
