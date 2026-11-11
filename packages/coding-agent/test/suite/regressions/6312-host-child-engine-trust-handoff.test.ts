/**
 * senpi#6312 (omo#12951): a lifecycle supervisor hands its host child the engine trust generation it adopted,
 * exactly as an initial daemon spawn hands it to the supervisor. Without it the child arrives with no marker,
 * omo's trust stage imports the OS store again and re-execs, and that exec closes the startup pipe
 * (senpi#4602): the child never reports host_bootstrap and the coordinated start fails.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	adoptedEngineTrust,
	classifyTrustArrival,
	type EngineTrustMarker,
	engineTrustHandOffEnvironment,
	recordAdoptedEngineTrust,
	serializeEngineTrustMarker,
} from "../../../src/engine-trust/index.ts";
import {
	ENGINE_TRUST_HOP_ENV,
	ENGINE_TRUST_MARKER_ENV,
	ENGINE_TRUST_RESTORE_NAMES,
} from "../../../src/engine-trust/marker.ts";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import {
	type HostChildOptions,
	hostChildEnvironment,
	loadHostChildTrustHandOff,
} from "../../../src/modes/rpc/host-lifecycle-launch.ts";
import { initialHostEnvironment } from "../../../src/modes/rpc/host-spawn-environment.ts";
import { serverMarker } from "../engine-trust-fixtures.ts";

const TRUST_NAMES = [...ENGINE_TRUST_RESTORE_NAMES, ENGINE_TRUST_MARKER_ENV, ENGINE_TRUST_HOP_ENV];
const fixture = join(import.meta.dirname, "../../fixtures/host-child-trust-handoff.ts");
const addressed = { hop: false, marker: { kind: "addressed", marker: { ...serverMarker, restore: {} } } };

function trustEntries(env: NodeJS.ProcessEnv): Record<string, string> {
	return Object.fromEntries(
		TRUST_NAMES.flatMap((name) => {
			const value = env[name];
			return value === undefined ? [] : [[name, value]];
		}),
	);
}

async function childOptions(): Promise<HostChildOptions> {
	return {
		launch: { socket: "/run/u/rpc.sock", hostArgs: [] },
		internalSocket: "/run/u/internal/host.sock",
		internal: { secretPath: "/run/u/internal/host.sock.secret" },
		daemonDir: "/run/u/daemon",
		instanceId: "instance-under-test",
		cleanupPaths: [],
		publicSocket: "/run/u/rpc.sock",
		trustHandOff: await loadHostChildTrustHandOff(),
	};
}

/** Starts the fixture supervisor and returns what its host child reported about the trust it arrived with. */
async function spawnedChildArrivals(marker: EngineTrustMarker | undefined) {
	const child = spawn(
		process.execPath,
		[fixture, "supervisor", ...(marker === undefined ? [] : [serializeEngineTrustMarker(marker)])],
		{
			// The supervisor's environment after its adopter applied the hand-off's empty restore: no trust names.
			env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, PI_OFFLINE: "1" },
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const [code] = await once(child, "close", { signal: AbortSignal.timeout(15_000) });
	const arrivals = stderr
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line): unknown => JSON.parse(line));
	return { code, arrivals, stderr };
}

describe("a supervisor's host child and the adopted engine trust generation (senpi#6312)", () => {
	it("carries the hand-off an initial daemon spawn carries once the supervisor adopted, and none before", async () => {
		// The supervisor's own environment after adoption holds neither the marker nor the closure.
		for (const name of TRUST_NAMES) vi.stubEnv(name, undefined);
		expect(adoptedEngineTrust()).toBeUndefined();
		const before = hostChildEnvironment(await childOptions(), undefined);
		expect(trustEntries(before)).toEqual({});
		expect(classifyTrustArrival(before, process.platform).marker.kind).toBe("none");

		recordAdoptedEngineTrust(serverMarker);
		const child = hostChildEnvironment(await childOptions(), undefined);
		const paths = createHostDaemonPaths({ socket: "/run/u/rpc.sock", agentDir: "/run/u/agent" });
		const daemon = initialHostEnvironment({ paths, instanceId: "i", generation: 1 });

		expect(trustEntries(child)).toEqual(engineTrustHandOffEnvironment(serverMarker, process.platform));
		expect(trustEntries(child)).toEqual(trustEntries(daemon));
		// Addressed with no hop is the arrival omo's trust stage adopts instead of importing and re-executing.
		expect(classifyTrustArrival(child, process.platform)).toEqual(addressed);
	});

	it("reaches a host child spawned through spawnHostChild, which arrives addressed and never as an import", async () => {
		const adopted = await spawnedChildArrivals(serverMarker);
		expect(adopted, adopted.stderr).toMatchObject({ code: 0, arrivals: [addressed] });

		const none = await spawnedChildArrivals(undefined);
		expect(none, none.stderr).toMatchObject({ code: 0, arrivals: [{ hop: false, marker: { kind: "none" } }] });
	});
});
