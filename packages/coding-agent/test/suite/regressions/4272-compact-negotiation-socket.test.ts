import { afterEach, expect, it, vi } from "vitest";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { catalogDigest } from "../../../src/modes/rpc/compact-catalog-codec.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";
import { negotiationSockets } from "./4272-negotiation-socket-support.ts";
import { builtFauxPath, workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";
const PAIR = ["compact_message_updates_v1", "event_resync"];
const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// #4272 T7 / RULING-66/73: real declarations, physical holds and wire ACKs, not a capability-only model.
it.each(["0", "1"])(
	"T7: truthful actual-socket advertisement and ACK with flag %s",
	async (flag) => {
		vi.stubEnv(FLAG, flag);
		await using host = await statusHost();
		await using net = await negotiationSockets(host.writer, host.core.router);
		const peer = await net.connect();
		const info = dataOf(await peer.request({ type: "get_protocol_info" }));
		expect((info.capabilities as string[]).includes(PAIR[0])).toBe(flag === "1");
		const ack = await peer.request({ type: "set_client_info", capabilities: PAIR });
		expect(ack.success).toBe(true);
		if (flag === "1") expect(ack.data).toEqual({ capabilities: PAIR });
		else expect(ack).not.toHaveProperty("data");
		await peer.close();
	},
	120000,
);

it("T7/T2: reject before selection or a hold; freeze legacy only at content admission", async () => {
	vi.stubEnv(FLAG, "1");
	await using host = await statusHost();
	await using net = await negotiationSockets(host.writer, host.core.router);
	const peer = await net.connect();
	const open = vi.spyOn(RpcSessionRegistry.prototype, "openSession");
	expect(await peer.request({ type: "open_session", cwd: host.cwd, admissionId: "unselected" })).toMatchObject({
		success: false,
		error: "compact_not_negotiated",
	});
	expect(open).not.toHaveBeenCalled();
	// A status-only subscription must not freeze the content format.
	expect((await peer.request({ type: "subscribe_sessions" })).success).toBe(true);
	expect(await peer.request({ type: "set_client_info", capabilities: PAIR })).toMatchObject({
		success: true,
		data: { capabilities: PAIR },
	});
	const manifest = peer.waitFor((record) => record.type === "recovery_manifest" && record.admissionId === "selected");
	const opened = await peer.request({ type: "open_session", cwd: host.cwd, admissionId: "selected" });
	expect(opened.success).toBe(true);
	const baseline = await manifest;
	// RULING-70(2): publish the manifest and page it through the existing route, never a second command.
	const page = await peer.request({
		type: "get_recovery_page",
		sessionId: opened.sessionId,
		admissionId: "selected",
		token: baseline.token,
		componentRef: "manifest",
		requestId: "manifest-page",
	});
	expect(page).toMatchObject({ success: true, sessionId: opened.sessionId, admissionId: "selected" });
	const bytes = dataOf(page);
	expect(bytes.digest).toBe(catalogDigest("fragment", Buffer.from(bytes.bytes as string, "base64")));
	for (const capabilities of [[], [PAIR[0]], [PAIR[1]]]) {
		expect(await peer.request({ type: "set_client_info", sessionId: opened.sessionId, capabilities })).toMatchObject({
			success: false,
		});
	}
	expect(await peer.request({ type: "set_client_info", sessionId: opened.sessionId })).toMatchObject({
		success: true,
		data: { capabilities: PAIR },
	});
	expect(await peer.request({ type: "set_client_info", capabilities: [...PAIR, "session_relocation"] })).toMatchObject(
		{ success: true, data: { capabilities: PAIR } },
	);
	await peer.close();
	const legacy = await net.connect();
	expect((await legacy.request({ type: "open_session", cwd: host.cwd })).success).toBe(true);
	expect(await legacy.request({ type: "set_client_info", capabilities: PAIR })).toMatchObject({
		success: false,
		error: "compact_selection_fixed",
	});
	await legacy.close();
}, 120000);

it("T7: failed pair is atomic with role/media state and cannot fall into admission; reconnect is fresh", async () => {
	vi.stubEnv(FLAG, "1");
	await using host = await statusHost();
	await using net = await negotiationSockets(host.writer, host.core.router);
	const peer = await net.connect();
	expect(
		await peer.request({
			type: "set_client_info",
			capabilities: [PAIR[0], "interactive_user", "media_placeholders"],
		}),
	).toMatchObject({ success: false });
	expect(await peer.request({ type: "open_session", cwd: host.cwd })).toMatchObject({
		success: false,
		error: "compact_selection_refused",
	});
	expect(host.core.router.sessionCount).toBe(0);
	await peer.close();
	const fresh = await net.connect();
	expect(await fresh.request({ type: "set_client_info", capabilities: [...PAIR, "task_parent"] })).toMatchObject({
		success: true,
		data: { capabilities: PAIR },
	});
	const before = fresh.records.length;
	fresh.send({ type: "set_client_info" });
	await fresh.request({ type: "get_protocol_info" });
	expect(fresh.records.slice(before).filter((r) => r.command === "set_client_info")).toEqual([]);
	await fresh.close();
}, 120000);

it.each(["0", "1"])(
	"T7/X06: worker session route, unconditional capture and format %s",
	async (flag) => {
		vi.stubEnv(FLAG, flag);
		const host = await workerAcceptanceHost(builtFauxPath);
		try {
			await using net = await negotiationSockets(host.writer, host.router);
			const peer = await net.connect();
			const first = await peer.request({ type: "set_client_info", capabilities: PAIR });
			expect(first.success).toBe(true);
			if (flag === "1") expect(first.data).toEqual({ capabilities: PAIR });
			else expect(first).not.toHaveProperty("data");
			const opened = await peer.request({
				type: "open_session",
				cwd: host.dir,
				provider: "faux",
				modelId: "faux-1",
				...(flag === "1" ? { admissionId: "worker" } : {}),
			});
			expect(opened.success).toBe(true);
			const heartbeat = await peer.request({ type: "set_client_info", sessionId: opened.sessionId });
			if (flag === "1") expect(heartbeat.data).toEqual({ capabilities: PAIR });
			else expect(heartbeat).not.toHaveProperty("data");
			expect(
				await peer.request({ type: "set_client_info", sessionId: opened.sessionId, capabilities: [] }),
			).toMatchObject({ success: flag !== "1" });

			await peer.close();
		} finally {
			await host.dispose();
		}
	},
	120000,
);

it.each(["0", "1"])(
	"X06/RULING-66: private worker capture and transport are unconditional (%s)",
	async (flag) => {
		vi.stubEnv(FLAG, flag);
		const host = await workerAcceptanceHost(builtFauxPath);
		try {
			const { sessionId, worker } = await host.open();
			const records: { type: string; canonical?: unknown }[] = [];
			worker.worker.on("message", (frame) => records.push(frame));
			const idle = host.next("idle", (record) => record.type === "agent_idle");
			expect((await host.request({ type: "prompt", sessionId, message: "capture and transport" })).success).toBe(
				true,
			);
			await idle;
			expect(records.some((frame) => frame.type === "canonical" || frame.canonical !== undefined)).toBe(true);
			expect(
				host.records.some((record) => record.materializer !== undefined || record.eventLease !== undefined),
			).toBe(false);
		} finally {
			await host.dispose();
		}
	},
	120000,
);
