/** senpi#6344: speculative lifetimes must never escape through ordinary session or connection lifetimes. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { parseArgs } from "../../src/cli/args.ts";
import { EXTENSION_RPC_EVENT_CHANNEL } from "../../src/core/event-bus.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { WorkerSessionRegistry } from "../../src/modes/rpc/worker-session-registry.ts";
import { parkClaimHost } from "./rpc-park-claim-support.ts";

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
afterEach(() => vi.useRealTimers());

it("a worker registry refuses both commands without constructing a worker or advertising support", async () => {
	await using host = await parkClaimHost();
	const registry = new WorkerSessionRegistry({
		configuration: { parsed: parseArgs(["--mode", "rpc"]), cwd: host.cwd, agentDir: host.cwd, appMode: "rpc" },
		closeGraceMs: 1_000,
		now: Date.now,
		createWorker: () => {
			throw new Error("park must not construct a worker");
		},
	});
	const router = new SessionCommandRouter(registry, new SessionEventWriter(() => {}), { cwd: host.cwd });
	try {
		const protocol = await router.handle({ type: "get_protocol_info" });
		if (protocol?.command !== "get_protocol_info" || !protocol.success) throw new Error("no protocol reply");
		expect(protocol.data.capabilities).not.toContain("park_claim");
		for (const type of ["park_session", "claim_session"] as const)
			expect(await router.handle({ type, cwd: host.cwd })).toMatchObject({
				command: type,
				success: false,
				error: "park_claim_unsupported",
			});
	} finally {
		await router.dispose();
	}
});

it("does not permit guessed routing handles to read or attach a hidden park", async () => {
	await using host = await parkClaimHost();
	await host.request({ type: "park_session", cwd: host.cwd });
	expect(await host.request({ type: "get_state", sessionId: "rpc-1" })).toMatchObject({ error: "unknown_session" });
	expect(
		await host.request({
			type: "attach_session",
			sessionId: "rpc-1",
			durableSessionId: host.harnesses[0].session.sessionId,
		}),
	).toMatchObject({ error: "unknown_session" });
	expect(host.registry.size).toBe(0);
});

it("allows exactly one concurrent claim and gives the other a miss", async () => {
	await using host = await parkClaimHost();
	await host.request({ type: "park_session", cwd: host.cwd });
	const replies = await Promise.all([
		host.request({ type: "claim_session", cwd: host.cwd }),
		host.request({ type: "claim_session", cwd: host.cwd }, "observer"),
	]);
	expect(replies).toEqual([
		expect.objectContaining({ data: expect.objectContaining({ sessionId: "rpc-1" }) }),
		expect.objectContaining({ data: { claimed: false } }),
	]);
	expect(host.builds).toBe(1);
	expect(host.registry.list()[0].attachments).toBe(1);
});

it("stop waits for an accepted build and disposes it without making it visible", async () => {
	await using host = await parkClaimHost();
	host.holdBuilds();
	const parking = host.request({ type: "park_session", cwd: host.cwd });
	const stopping = host.router.dispose();
	host.releaseBuilds();
	await parking;
	await stopping;
	expect(host.harnesses).toHaveLength(1);
	await host.closed(host.harnesses[0].session.sessionId);
	expect(host.registry.list()).toEqual([]);
	expect(host.records.some((record) => record.type === "session_opened")).toBe(false);
	expect(await host.request({ type: "park_session", cwd: host.cwd })).toMatchObject({ error: "host_draining" });
});

it("a disconnect during claim cannot strand an owner attachment", async () => {
	await using host = await parkClaimHost();
	await host.request({ type: "park_session", cwd: host.cwd });
	const entry = host.registry.peek("rpc-1");
	if (!entry?.runtime) throw new Error("park runtime missing");
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const persist = entry.runtime.persistSession.bind(entry.runtime);
	vi.spyOn(entry.runtime, "persistSession").mockImplementation(async () => {
		reached.resolve();
		await release.promise;
		await persist();
	});
	const claiming = host.writer.withConnection("owner", () =>
		host.router.handle({ type: "claim_session", cwd: host.cwd }),
	);
	await reached.promise;
	host.writer.unregisterConnection("owner");
	const disconnecting = host.router.releaseConnection("owner");
	release.resolve();
	await claiming;
	await disconnecting;
	expect(host.registry.list()).toEqual([]);
});

it("stop cancels a replacement before it can build", async () => {
	await using host = await parkClaimHost();
	await host.request({ type: "park_session", cwd: host.cwd });
	await host.request({ type: "claim_session", cwd: host.cwd });
	await host.router.dispose();
	await vi.advanceTimersByTimeAsync(0);
	expect(host.builds).toBe(1);
});

it("configures the prebuilt binding with the claimer's declared extension-event capability", async () => {
	await using host = await parkClaimHost();
	await host.request({ type: "park_session", cwd: host.cwd });
	await host.request({ type: "set_client_info", width: 120, capabilities: ["extension_events"] });
	await host.request({ type: "claim_session", cwd: host.cwd });
	host.harnesses[0]
		.getExtensionRunner()
		.emitBusEvent(EXTENSION_RPC_EVENT_CHANNEL, { name: "claimed", data: { ready: true } });
	await host.writer.flush();
	expect(host.records).toContainEqual(
		expect.objectContaining({
			type: "extension_event",
			sessionId: "rpc-1",
			name: "claimed",
			data: { ready: true },
			connection: "owner",
		}),
	);
	expect(host.builds).toBe(1);
});

it("runs a faux-provider turn on the claimed runtime and persists its buffered transcript", async () => {
	vi.useRealTimers();
	await using host = await parkClaimHost();
	await host.request({ type: "park_session", cwd: host.cwd });
	const harness = host.harnesses[0];
	harness.session.sessionManager.appendCustomEntry("park-startup", { preserved: true });
	await host.request({ type: "claim_session", cwd: host.cwd });
	harness.setResponses([fauxAssistantMessage("claim transcript persisted")]);
	const idle = Promise.withResolvers<void>();
	const unsubscribe = harness.session.subscribe((event) => {
		if (event.type === "agent_idle") idle.resolve();
	});
	try {
		await host.request({ type: "prompt", sessionId: "rpc-1", message: "Reply with the marker." });
		await idle.promise;
		const file = harness.session.sessionFile;
		if (!file) throw new Error("claimed session has no file");
		const transcript = await readFile(file, "utf8");
		expect(transcript).toContain('"customType":"park-startup"');
		expect(transcript).toContain("claim transcript persisted");
		expect(host.registry.peek("rpc-1")?.runtime?.session).toBe(harness.session);
	} finally {
		unsubscribe();
	}
});

it("a parked binding's own shutdown stays invisible and leaves no claimable runtime", async () => {
	await using host = await parkClaimHost();
	await host.request({ type: "park_session", cwd: host.cwd });
	const durable = host.harnesses[0].session.sessionId;
	host.shutdownPark("rpc-1");
	await host.closed(durable);
	expect(await host.request({ type: "claim_session", cwd: host.cwd })).toMatchObject({ data: { claimed: false } });
	expect(host.records.some((record) => record.type === "session_closed" || record.type === "session_parked")).toBe(
		false,
	);
});
