/**
 * `endpoint.json` is written whole and a torn one does not strand its endpoint: the next ensure,
 * under the socket's ensure lock, rewrites it, and `gc` can address and reclaim the endpoint again.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths, ensureEndpointIdentity } from "../src/modes/rpc/host-daemon-paths.ts";
import { gcHostEndpoints } from "../src/modes/rpc/host-gc.ts";
import { endpointScratch, realHost, sweepEndpointScratches } from "./helpers/rpc-host-endpoint-scratch.ts";
import { waitForPidGone } from "./helpers/spawned-host-reaper.ts";

afterEach(sweepEndpointScratches, 180_000);

const TORN = '{"layout":2,"sock';

describe("endpoint.json writes", () => {
	it("keeps the first writer's identity, leaves no temporary file, and repairs only when asked", async () => {
		const qa = endpointScratch("eid");
		const paths = createHostDaemonPaths({ socket: qa.shard, agentDir: qa.agentDir });
		await ensureEndpointIdentity(paths, qa.shard);
		const first = await readFile(paths.endpointFile, "utf8");

		await ensureEndpointIdentity(paths, qa.shard, { repair: true });
		expect(await readFile(paths.endpointFile, "utf8")).toBe(first);

		await writeFile(paths.endpointFile, TORN);
		await ensureEndpointIdentity(paths, qa.shard);
		expect(await readFile(paths.endpointFile, "utf8")).toBe(TORN);

		await ensureEndpointIdentity(paths, qa.shard, { repair: true });
		expect(JSON.parse(await readFile(paths.endpointFile, "utf8"))).toEqual({
			layout: 2,
			registry_version: 1,
			endpoint_kind: "rpc_host",
			socket: qa.shard,
			created_at: expect.any(String),
		});
		expect((await readdir(paths.dir)).filter((name) => name.startsWith("endpoint.json"))).toEqual(["endpoint.json"]);
	});

	it("keeps the first writer's kind: a later ensure, repairing or not, never turns a tui record into a host's", async () => {
		const qa = endpointScratch("eidk");
		const socket = join(qa.root, "rpc", "tui", "t-kind.sock");
		const paths = createHostDaemonPaths({ socket, agentDir: qa.agentDir });
		await ensureEndpointIdentity(paths, socket, { kind: "tui" });
		const first = await readFile(paths.endpointFile, "utf8");

		await ensureEndpointIdentity(paths, socket);
		await ensureEndpointIdentity(paths, socket, { repair: true });

		expect(await readFile(paths.endpointFile, "utf8")).toBe(first);
		expect(JSON.parse(first)).toMatchObject({ endpoint_kind: "tui", registry_version: 1 });
	});
});

describe.skipIf(process.platform === "win32")("a torn endpoint.json against real hosts", () => {
	it("is rewritten by the next ensure, after which gc reclaims the endpoint instead of keeping it", async () => {
		const qa = endpointScratch("torn");
		const paths = createHostDaemonPaths({ socket: qa.shard, agentDir: qa.agentDir });
		expect(await waitForPidGone(await realHost(qa, qa.shard, { idleExitMs: 500 }), 60_000)).toBe(true);
		await writeFile(paths.endpointFile, TORN);
		expect(await gcHostEndpoints(qa.agentDir)).toEqual({
			removed: [],
			kept: [{ socket: null, dir: paths.dir, reason: "unknown_identity" }],
		});

		expect(await waitForPidGone(await realHost(qa, qa.shard, { idleExitMs: 500 }), 60_000)).toBe(true);

		expect(JSON.parse(await readFile(paths.endpointFile, "utf8"))).toMatchObject({ layout: 2, socket: qa.shard });
		const reclaimed = await gcHostEndpoints(qa.agentDir);
		expect(reclaimed.kept).toEqual([]);
		expect(reclaimed.removed).toEqual([expect.objectContaining({ socket: qa.shard, dir: paths.dir })]);
		expect(await readdir(join(qa.agentDir, "rpc-host-daemon"))).not.toContain(basename(paths.dir));
	}, 180_000);
});
