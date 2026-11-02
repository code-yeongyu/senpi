/**
 * A terminal's endpoint directory is named by a socket built from a fresh instance id, so it can never
 * hold an earlier generation: its registration skips the dead-generation prune. A host registration
 * still prunes before it writes (#1893), which the spy also observes.
 */
import { vi } from "vitest";
import type { HostDaemonPaths } from "../../src/modes/rpc/host-daemon-paths.ts";

const pruned = vi.hoisted(() => ({ dirs: [] as string[] }));

vi.mock("../../src/modes/rpc/host-generations.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/modes/rpc/host-generations.ts")>();
	return {
		...actual,
		pruneDeadGenerations: (paths: HostDaemonPaths) => {
			pruned.dirs.push(paths.dir);
			return actual.pruneDeadGenerations(paths);
		},
	};
});

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths } from "../../src/modes/rpc/host-daemon-paths.ts";
import { readHostRegistration, writeHostRegistration } from "../../src/modes/rpc/host-daemon-registration.ts";
import { listHostEndpoints } from "../../src/modes/rpc/host-endpoints.ts";
import { type EndpointFixture, startEndpoint } from "../helpers/session-control-fixture.ts";
import { deadPid } from "../helpers/tui-endpoint-seams.ts";
import { createHarness, type Harness } from "./harness.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	pruned.dirs.length = 0;
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function ownedHarness(): Promise<Harness> {
	const harness = await createHarness({ persistSession: true });
	cleanups.push(() => harness.cleanup());
	return harness;
}

function owned(fixture: EndpointFixture): EndpointFixture {
	cleanups.push(() => fixture.endpoint.dispose());
	return fixture;
}

describe.skipIf(process.platform === "win32")("tui endpoint: no generation prune", () => {
	it("registers without reading generations, and the endpoint is listed with its record", async () => {
		const harness = await ownedHarness();
		const fixture = owned(await startEndpoint({ harness }));
		const paths = createHostDaemonPaths({ socket: fixture.socket, agentDir: fixture.agentDir });

		expect(pruned.dirs).not.toContain(paths.dir);
		expect((await listHostEndpoints(fixture.agentDir)).map((entry) => entry.socket)).toEqual([fixture.socket]);
		expect((await readHostRegistration(paths))?.record.pid).toBe(process.pid);
	});

	it("still prunes a host's dead generations before registering a new one", async () => {
		const harness = await ownedHarness();
		const socket = join(harness.tempDir, "agent", "rpc", "shards", "p-0000000000000000.sock");
		const paths = createHostDaemonPaths({ socket, agentDir: join(harness.tempDir, "agent") });
		const base = { socket, launchProfileId: "default", generation: 0 };
		await writeHostRegistration(paths, {
			...base,
			record: { pid: await deadPid(), processStartTime: null },
			instanceId: "gone",
		});
		const deadRecord = join(paths.generationsDir, "gone");
		expect(existsSync(deadRecord)).toBe(true);
		pruned.dirs.length = 0;

		await writeHostRegistration(paths, {
			...base,
			record: { pid: process.pid, processStartTime: null },
			instanceId: "now",
		});

		expect(pruned.dirs).toEqual([paths.dir]);
		expect(existsSync(deadRecord)).toBe(false);
		expect((await readHostRegistration(paths))?.instanceId).toBe("now");
	});
});
