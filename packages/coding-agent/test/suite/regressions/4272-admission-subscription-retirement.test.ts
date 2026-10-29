import { afterEach, expect, it, vi } from "vitest";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it.each(["unsubscribe", "peer end"])(
	"%s retires a compact subscription's page route",
	async (operation) => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
		vi.stubEnv("SENPI_RPC_REQUIRE_ATTACH", "1");
		await using host = await statusHost();
		const peer = host.client("peer");
		const answer = await peer.request({ type: "subscribe_sessions", admissionId: "status" });
		const subscriptionId = String(dataOf(answer).subscriptionId);
		const baseline = await peer.waitFor((frame) => frame.type === "recovery_manifest");
		expect(host.writer.isCompactSubscription("peer", "status", subscriptionId)).toBe(true);
		if (operation === "unsubscribe") await peer.request({ type: "unsubscribe_sessions", subscriptionId });
		else await host.drop("peer");
		expect(host.writer.isCompactSubscription("peer", "status", subscriptionId)).toBe(false);
		const next = operation === "peer end" ? host.client("peer") : peer;
		expect(
			await next.request({
				type: "get_recovery_page",
				sessionId: subscriptionId,
				admissionId: "status",
				lease: baseline.eventLease,
				componentRef: "record",
				requestId: "retired",
			}),
		).toMatchObject({ success: false, errorCode: "session_not_attached" });
	},
	120_000,
);
