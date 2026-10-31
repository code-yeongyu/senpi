import { afterEach, expect, it, vi } from "vitest";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

afterEach(() => vi.unstubAllEnvs());

it("R4.A3 rejects an oversized materializer header with a typed error and no outstanding lease", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const owner = host.client("owner");
	const peer = host.client("peer");
	host.writer.setConnectionCapabilities("peer", ["compact_events"]);
	const sessionId = String(dataOf(await owner.request({ type: "open_session", cwd: host.cwd })).sessionId);
	await peer.request({ type: "subscribe_sessions", admissionId: "updates", mirror: ["message_update"] });
	const lane = host.writer.recoveryLane(sessionId) ?? expect.unreachable();
	const events = host.writer.recoveryEvents ?? expect.unreachable();
	const mint = events.mint.bind(events);
	// Generated fields are bounded in production; force the defensive guard after a real lease is acquired.
	const oversized = vi.spyOn(events, "mint").mockImplementation((...args) => {
		const result = mint(...args);
		return result.ok ? { ok: true, value: { ...result.value, digest: "x".repeat(16_384) } } : result;
	});
	const record = {
		type: "message_update",
		message: null,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "next" },
	};
	lane.accept(record, undefined);
	const before = events.status();
	try {
		let error: unknown;
		try {
			host.writer.enqueue(sessionId, record);
		} catch (cause) {
			error = cause;
		}
		expect(events.status()).toMatchObject({
			open: before.open,
			contentBytes: before.contentBytes,
			minted: before.minted + 1,
			abandoned: before.abandoned + 1,
		});
		expect(error).toBeInstanceOf(RangeError);
	} finally {
		oversized.mockRestore();
	}
}, 120_000);
