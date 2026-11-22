import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOUND_MS, bounded, type GatedServer, gatedServer } from "../../mcp/fixtures/gated-http-server.ts";
import { type Rig, startRig } from "../../support/rpc-mcp-rig.ts";

// senpi#4828: with eager MCP servers connecting in parallel, the startup `loaded_surfaces_changed` stream must not
// depend on how the connects interleave or on how often the client reads the inventory meanwhile.

function eagerServer(server: GatedServer): Record<string, unknown> {
	return { type: "http", url: server.url, auth: false, lifecycle: "eager", connectTimeoutMs: BOUND_MS };
}

type Step = (rig: Rig, a: GatedServer, b: GatedServer) => Promise<void>;

async function connectFully(rig: Rig, server: GatedServer, label: string): Promise<void> {
	server.releaseInitialize();
	await bounded(server.toolsListArrived, `${label} tools/list`);
	const registered = rig.nextRegistration();
	server.releaseToolsList();
	await bounded(registered, `${label} registration`);
}

const poll = async (rig: Rig): Promise<void> => {
	await rig.request("get_loaded_surfaces");
};

const interleavings: ReadonlyArray<readonly [string, Step]> = [
	[
		"a fully connected before b starts",
		async (rig, a, b) => {
			await connectFully(rig, a, "a");
			await connectFully(rig, b, "b");
		},
	],
	[
		"b fully connected before a starts",
		async (rig, a, b) => {
			await connectFully(rig, b, "b");
			await connectFully(rig, a, "a");
		},
	],
	[
		"both initialized before either lists tools",
		async (rig, a, b) => {
			a.releaseInitialize();
			b.releaseInitialize();
			await bounded(Promise.all([a.toolsListArrived, b.toolsListArrived]), "both tools/list");
			const first = rig.nextRegistration();
			a.releaseToolsList();
			await bounded(first, "a registration");
			const second = rig.nextRegistration();
			b.releaseToolsList();
			await bounded(second, "b registration");
		},
	],
	[
		"a then b while the client polls get_loaded_surfaces at every step",
		async (rig, a, b) => {
			await poll(rig);
			a.releaseInitialize();
			await bounded(a.toolsListArrived, "a tools/list");
			await poll(rig);
			let registered = rig.nextRegistration();
			a.releaseToolsList();
			await bounded(registered, "a registration");
			await poll(rig);
			b.releaseInitialize();
			await bounded(b.toolsListArrived, "b tools/list");
			await poll(rig);
			registered = rig.nextRegistration();
			b.releaseToolsList();
			await bounded(registered, "b registration");
			await poll(rig);
		},
	],
];

describe("startup loaded_surfaces_changed with parallel eager MCP servers (senpi#4828)", () => {
	let root: string;
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(() => {
		root = join(tmpdir(), `rpc-startup-surfaces-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it.each(interleavings)("emits exactly one event once both servers settle: %s", async (_label, step) => {
		const a = await gatedServer("alpha");
		const b = await gatedServer("bravo");
		cleanups.push(a.close, b.close);
		const rig = await startRig(root, { alpha: eagerServer(a), bravo: eagerServer(b) });
		cleanups.push(rig.dispose);
		await rig.handler.ready;
		await bounded(Promise.all([a.initializeArrived, b.initializeArrived]), "both initialize requests");

		await step(rig, a, b);
		expect(await bounded(rig.service.whenAttachSettled(BOUND_MS), "attach settle")).toBe("settled");
		await rig.collected.waitFor((record) => record.type === "loaded_surfaces_changed", "the startup event");
		// Drain every queued inventory capture, then let a response flush the events queued before it.
		await rig.service.refreshWireStatusSnapshot(rig.session.sessionId);
		await rig.request("get_commands");

		expect(rig.surfaceEvents()).toBe(1);
		const inventory = await rig.request("get_loaded_surfaces");
		expect(inventory).toMatchObject({
			success: true,
			data: {
				mcpServers: [
					{ name: "alpha", status: "connected", toolCount: 1 },
					{ name: "bravo", status: "connected", toolCount: 1 },
				],
			},
		});
		await rig.request("get_commands");
		expect(rig.surfaceEvents()).toBe(1);
	});

	it("emits nothing at startup when the session connects no MCP server", async () => {
		const rig = await startRig(root, { off: { type: "stdio", command: "unused", enabled: false } });
		cleanups.push(rig.dispose);
		await rig.handler.ready;
		expect(await bounded(rig.service.whenAttachSettled(BOUND_MS), "attach settle")).toBe("settled");
		await rig.request("get_loaded_surfaces");
		await rig.request("get_loaded_surfaces");
		await rig.service.refreshWireStatusSnapshot(rig.session.sessionId);
		await rig.request("get_commands");
		expect(rig.surfaceEvents()).toBe(0);
	});
});
