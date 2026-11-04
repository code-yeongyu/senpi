import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RPC_METHOD_CLASS } from "../../../src/modes/rpc/method-classes.ts";
import { statusHost } from "../rpc-session-status-support.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

// senpi#5748: reset_stream, cancel_attempt, get_recovery_page and release_recovery belong to the compact engine-socket
// transport. They are public RPC: always in the engine's method table, and with compact updates off each answers the
// typed feature_disabled with errorData.feature "compact_updates", never "Unknown command", so a client can tell a host
// that has the feature off from an engine that does not know the method.
const METHODS = ["reset_stream", "cancel_attempt", "get_recovery_page", "release_recovery"] as const;
const replies = async (compact: boolean) => {
	if (compact) vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	const opened = await peer.request({ type: "open_session", sessionPath: join(host.cwd, "s.jsonl") });
	const out: Record<string, unknown> = {};
	for (const type of METHODS) {
		await host.writer.flush();
		const start = peer.received.length;
		await host.writer.withConnection("peer", () =>
			host.core.handle(
				JSON.stringify({
					id: type,
					type,
					sessionId: opened.sessionId,
					admissionId: "a",
					token: "t",
					streamId: "s",
				}),
			),
		);
		await host.writer.flush();
		out[type] = JSON.parse(peer.received.slice(start).at(-1) ?? "{}");
	}
	return out;
};

it("#5748 all four are in the engine's method table whatever the flag", () => {
	for (const type of METHODS) expect.soft(RPC_METHOD_CLASS[type], type).toBe("connection_local");
});

it("#5748 with compact updates off each answers feature_disabled naming compact_updates, not Unknown command", async () => {
	const out = await replies(false);
	for (const type of METHODS)
		expect.soft(out[type], type).toMatchObject({
			success: false,
			error: "feature_disabled",
			errorCode: "feature_disabled",
			errorData: { feature: "compact_updates" },
		});
});

it("#5748 with compact updates on none of them answers Unknown command or feature_disabled", async () => {
	const out = await replies(true);
	for (const type of METHODS) {
		const reply = out[type] as { error?: string };
		expect.soft(String(reply.error ?? ""), type).not.toContain("Unknown command");
		expect.soft(reply.error, type).not.toBe("feature_disabled");
	}
});
