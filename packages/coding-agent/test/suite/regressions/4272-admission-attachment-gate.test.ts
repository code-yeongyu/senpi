import { afterEach, expect, it, vi } from "vitest";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it.each(["get_recovery_page", "release_recovery"])(
	"flag OFF keeps an unattached %s behind the enforced attach gate",
	async (type) => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "0");
		vi.stubEnv("SENPI_RPC_REQUIRE_ATTACH", "1");
		await using host = await statusHost();
		const peer = host.client("peer");
		expect(
			await peer.request({
				type,
				sessionId: "unattached",
				admissionId: "a",
				lease: { kind: "event", id: "lease" },
				componentRef: "record",
				requestId: "page",
			}),
		).toMatchObject({ success: false, errorCode: "session_not_attached" });
	},
	120_000,
);

it.each(["get_recovery_page", "release_recovery"])(
	"flag ON scopes %s to the server-side peer with byte-identical foreign/unknown/malformed denials",
	async (type) => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
		vi.stubEnv("SENPI_RPC_REQUIRE_ATTACH", "1");
		await using host = await statusHost();
		const owner = host.client("owner");
		const foreign = host.client("foreign");
		const subscribed = await owner.request({ type: "subscribe_sessions", admissionId: "own" });
		const subscriptionId = String(dataOf(subscribed).subscriptionId);
		const manifest = await owner.waitFor((frame) => frame.type === "recovery_manifest");
		const page = vi.spyOn(host.writer.recoveryPages ?? expect.unreachable(), "request");
		const release = vi.spyOn(host.writer.recoveryEvents ?? expect.unreachable(), "release");
		const lane = vi.spyOn(host.writer, "recoveryLane");
		const command = {
			id: "denied",
			type,
			sessionId: subscriptionId,
			admissionId: "own",
			lease: manifest.eventLease,
			componentRef: "record",
			requestId: "page",
			// Forged request fields must never select the server's connection identity.
			peer: "owner",
			connectionId: "owner",
			socketEpoch: host.writer.socketEpochOf("owner"),
		};
		const denied: string[] = [];
		for (const route of [
			{},
			{ sessionId: "unknown", admissionId: "unknown" },
			{ sessionId: "../malformed", admissionId: "bad/id" },
			{ admissionId: undefined },
		]) {
			const from = foreign.received.length;
			await host.writer.withConnection("foreign", () => host.core.handle(JSON.stringify({ ...command, ...route })));
			await host.writer.flush();
			denied.push(foreign.received.slice(from).join(""));
		}
		expect(denied[0]).toContain('"errorCode":"session_not_attached"');
		expect(denied).toEqual(Array(4).fill(denied[0]));
		expect(page).not.toHaveBeenCalled();
		expect(release).not.toHaveBeenCalled();
		expect(lane).not.toHaveBeenCalled();
		expect(
			await owner.request({
				...command,
				peer: "foreign",
				connectionId: "foreign",
				socketEpoch: host.writer.socketEpochOf("foreign"),
			}),
		).toMatchObject({ success: true });
	},
	120_000,
);
