/**
 * A terminal's control endpoint reaps other terminals' dead `tui` records AFTER it is active, never in
 * front of the bind: nothing a sender reads depends on them, and the pass costs about 2 ms per dead
 * record. The pass is held inside its first endpoint lock (the gc's own test hook) to prove the order.
 */
import { vi } from "vitest";
import type { HostGcOptions, HostGcResult } from "../../src/modes/rpc/host-gc.ts";

const gcSeam = vi.hoisted(() => ({
	afterLock: undefined as ((socket: string) => Promise<void>) | undefined,
	fail: undefined as Error | undefined,
	waiters: [] as Array<(started: { readonly run: Promise<HostGcResult> }) => void>,
}));

vi.mock("../../src/modes/rpc/host-gc.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/modes/rpc/host-gc.ts")>();
	return {
		...actual,
		gcHostEndpoints: (agentDir: string, options: HostGcOptions = {}): Promise<HostGcResult> => {
			const hook = gcSeam.afterLock;
			const run =
				gcSeam.fail === undefined
					? actual.gcHostEndpoints(agentDir, hook ? { ...options, _test: { afterLockAcquired: hook } } : options)
					: Promise.reject(gcSeam.fail);
			for (const waiter of gcSeam.waiters.splice(0)) waiter({ run });
			return run;
		},
	};
});

import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionControlDrain } from "../../src/core/extensions/types.ts";
import { listHostEndpoints } from "../../src/modes/rpc/host-endpoints.ts";
import { gate } from "../helpers/rpc-host-gc-fixtures.ts";
import { controlData } from "../helpers/session-control-client.ts";
import { type EndpointFixture, startEndpoint } from "../helpers/session-control-fixture.ts";
import { plantDeadTuiEndpoint, within } from "../helpers/tui-endpoint-seams.ts";
import { createHarness, type Harness } from "./harness.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	gcSeam.afterLock = undefined;
	gcSeam.fail = undefined;
	gcSeam.waiters.length = 0;
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

function nextGcRun(): Promise<{ readonly run: Promise<HostGcResult> }> {
	return new Promise((resolve) => gcSeam.waiters.push(resolve));
}

const admitNamed: SessionControlDrain = (event) => ({
	admitted: (event.delivery_ids ?? []).map((id) => ({ delivery_id: id, kind: "started" })),
});

async function listedSockets(agentDir: string): Promise<string[]> {
	return (await listHostEndpoints(agentDir)).map((entry) => entry.socket ?? "").sort();
}

describe.skipIf(process.platform === "win32")("tui endpoint: dead terminals are reaped after activation", () => {
	it("answers a wake while 5 dead records still exist, then reaps them and keeps itself", async () => {
		const harness = await ownedHarness();
		const agentDir = join(harness.tempDir, "agent");
		const dead: string[] = [];
		for (let index = 0; index < 5; index++) dead.push(await plantDeadTuiEndpoint(agentDir, `dead-${index}`));
		const held = gate();
		cleanups.push(() => held.open());
		gcSeam.afterLock = held.hook;
		const gcStarted = nextGcRun();

		const fixture = owned(
			await within(startEndpoint({ harness, agentDir, drain: admitNamed }), 5_000, "registration"),
		);
		expect(await controlData(fixture.socket, { type: "wake", delivery_ids: ["d-1"] })).toEqual({
			admitted: [{ delivery_id: "d-1", kind: "started" }],
		});
		await within(held.entered, 5_000, "the deferred gc pass reaching its first endpoint lock");
		expect(await listedSockets(agentDir)).toEqual([...dead, fixture.socket].sort());

		held.open();
		const result = await within((await gcStarted).run, 10_000, "the deferred gc pass");
		expect(result.removed.map((entry) => entry.socket).sort()).toEqual([...dead].sort());
		expect(result.kept).toEqual([expect.objectContaining({ socket: fixture.socket, reason: "live_generation" })]);
		expect(await listedSockets(agentDir)).toEqual([fixture.socket]);
	});

	it("reports a failed gc pass as a notice and stays registered", async () => {
		const harness = await ownedHarness();
		gcSeam.fail = new Error("gc exploded");
		const gcStarted = nextGcRun();
		const fixture = owned(await within(startEndpoint({ harness, drain: admitNamed }), 5_000, "registration"));
		await expect((await gcStarted).run).rejects.toThrow("gc exploded");
		expect(fixture.notices).toContain("control endpoint gc of dead terminals failed: gc exploded");
		expect(await controlData(fixture.socket, { type: "wake", delivery_ids: ["d-2"] })).toEqual({
			admitted: [{ delivery_id: "d-2", kind: "started" }],
		});
	});

	it("reaps a dead tui endpoint after each registration and leaves at most one across 50 cycles", async () => {
		const harness = await ownedHarness();
		const agentDir = join(harness.tempDir, "agent");
		await plantDeadTuiEndpoint(agentDir, "ghost-instance");
		expect(await listHostEndpoints(agentDir)).toHaveLength(1);
		for (let cycle = 0; cycle < 50; cycle++) {
			const gcStarted = nextGcRun();
			const fixture = await startEndpoint({ harness, agentDir });
			await within((await gcStarted).run, 10_000, `the gc pass of cycle ${cycle}`);
			expect(await listedSockets(agentDir)).toEqual([fixture.socket]);
			await fixture.endpoint.dispose();
		}
		expect(await listHostEndpoints(agentDir)).toEqual([]);
	});
});
