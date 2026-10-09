/**
 * The liveness verdict `classifyEndpointLiveness`: routable only on an answer from a recorded
 * instance, dead only when every recorded process is provably gone (pid gone, or the pid now has another
 * start time), and live_unresponsive for everything else - within the `tui` budget for a terminal that
 * accepts a connection and never answers. Sockets and registrations are the test's own; no host runs.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { processIsLive } from "../../src/modes/app-server/daemon/process.ts";
import { classifyEndpointLiveness, TUI_PROBE_TIMEOUT_MS } from "../../src/modes/rpc/host-endpoint-liveness.ts";
import { endpointScratch } from "../helpers/rpc-host-endpoint-scratch.ts";
import { exitedPid } from "../helpers/rpc-host-gc-fixtures.ts";
import {
	answeringSocket,
	closeRegistryFixtures,
	liveRecord,
	registered,
	silentSocket,
} from "./rpc-endpoint-registry-fixtures.ts";

afterEach(closeRegistryFixtures, 180_000);

describe.skipIf(process.platform === "win32")("liveness verdict", () => {
	it("is routable only when the answering instance is one the directory recorded", async () => {
		const qa = endpointScratch("route");
		await answeringSocket(qa.legacy, "gen-a");
		const paths = await registered(qa.agentDir, qa.legacy, "rpc_host", await liveRecord(), "gen-a");
		const entry = { socket: qa.legacy, dir: paths.dir, endpoint_kind: "rpc_host" } as const;
		expect(await classifyEndpointLiveness(entry)).toBe("routable");

		await answeringSocket(qa.shard, "someone-else");
		const other = await registered(qa.agentDir, qa.shard, "rpc_host", await liveRecord(), "gen-a");
		expect(await classifyEndpointLiveness({ socket: qa.shard, dir: other.dir, endpoint_kind: "rpc_host" })).toBe(
			"live_unresponsive",
		);
	});

	it("calls a silent endpoint live_unresponsive while its recorded process runs, within the tui budget", async () => {
		const qa = endpointScratch("mute");
		const socket = join(qa.root, "rpc", "tui", "t-mute.sock");
		await silentSocket(socket);
		const paths = await registered(qa.agentDir, socket, "tui", await liveRecord());

		const started = Date.now();
		const verdict = await classifyEndpointLiveness(
			{ socket, dir: paths.dir, endpoint_kind: "tui" },
			{ timeoutMs: 60_000 },
		);
		const elapsed = Date.now() - started;

		expect(verdict).toBe("live_unresponsive");
		expect(elapsed).toBeGreaterThanOrEqual(TUI_PROBE_TIMEOUT_MS - 50);
		expect(elapsed).toBeLessThan(2_000);
	});

	it("calls an endpoint dead only when its recorded pid is gone or now names another process", async () => {
		const qa = endpointScratch("dead");
		const exited = await exitedPid();
		expect(processIsLive(exited)).toBe(false);
		const gonePid = await registered(qa.agentDir, qa.legacy, "tui", { pid: exited, processStartTime: "whenever" });
		const recycled = await registered(qa.agentDir, qa.shard, "tui", {
			pid: process.pid,
			processStartTime: "Thu Jan  1 00:00:00 1970",
		});

		expect(await classifyEndpointLiveness({ socket: qa.legacy, dir: gonePid.dir, endpoint_kind: "tui" })).toBe(
			"dead",
		);
		expect(await classifyEndpointLiveness({ socket: qa.shard, dir: recycled.dir, endpoint_kind: "tui" })).toBe(
			"dead",
		);
	});
});
