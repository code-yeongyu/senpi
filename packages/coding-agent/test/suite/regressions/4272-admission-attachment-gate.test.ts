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
	600_000,
);

it.each(["get_recovery_page", "release_recovery"])(
	"RULING-94 scopes %s to the server-side peer and validates malformed IDs first",
	async (type) => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
		vi.stubEnv("SENPI_RPC_REQUIRE_ATTACH", "1");
		await using host = await statusHost();
		const owner = host.client("owner");
		const foreign = host.client("foreign");
		const subscribed = await owner.request({ type: "subscribe_sessions", admissionId: "own" });
		const subscriptionId = String(dataOf(subscribed).subscriptionId);
		const manifest = await owner.waitFor((frame) => frame.type === "recovery_manifest");
		const events = host.writer.recoveryEvents ?? expect.unreachable();
		const before = events.status();
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
		for (const route of [{}, { sessionId: "unknown", admissionId: "own" }]) {
			const from = foreign.received.length;
			await host.writer.withConnection("foreign", () => host.core.handle(JSON.stringify({ ...command, ...route })));
			await host.writer.flush();
			denied.push(foreign.received.slice(from).join(""));
		}
		// RULING-96: a foreign peer gets the token/lease path's own refusal, never unknown_admission.
		expect(denied[0]).toContain('"errorCode":"recovery_repair_needed"');
		expect(denied[0]).toContain('"reason":"unknown_token"');
		expect(denied).toEqual(Array(2).fill(denied[0]));
		expect(await foreign.request({ ...command, admissionId: "bad/id" })).toMatchObject({
			success: false,
			errorData: { reason: "malformed_request" },
		});
		// RULING-96: syntax first, then token/lease authority; a missing ID is the recovery path's typed refusal.
		expect(await foreign.request({ ...command, admissionId: undefined })).toMatchObject({
			success: false,
			errorCode: "recovery_malformed_request",
		});
		// No foreign request released, duplicated or otherwise touched the owner's lease.
		expect(events.status()).toMatchObject({
			open: before.open,
			released: before.released,
			duplicates: before.duplicates,
		});
		expect(
			await owner.request({
				...command,
				peer: "foreign",
				connectionId: "foreign",
				socketEpoch: host.writer.socketEpochOf("foreign"),
			}),
		).toMatchObject({ success: true });
	},
	600_000,
);
