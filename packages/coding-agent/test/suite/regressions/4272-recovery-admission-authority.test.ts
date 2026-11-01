import { afterEach, expect, it, vi } from "vitest";
import { CompactAdmissions } from "../../../src/modes/rpc/compact-admissions.ts";
import * as storage from "../../../src/modes/rpc/compact-admission-storage.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// #4272 RULING-96: token/lease authority, not the attempt ledger, owns recovery refusals.
for (const kind of ["checkpoint", "event"] as const) {
	for (const type of kind === "checkpoint"
		? (["get_recovery_page"] as const)
		: (["get_recovery_page", "release_recovery"] as const)) {
		it(`RULING-96 ${type}/${kind}: mismatched admissions and unknown/foreign tokens answer identical bytes`, async () => {
			vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
			vi.stubEnv("SENPI_RPC_REQUIRE_ATTACH", "1");
			await using host = await statusHost();
			const peer = host.client("peer");
			const foreign = host.client("foreign");
			const opened = await peer.request({ type: "open_session", admissionId: "own" });
			const sessionId = String(opened.sessionId);
			const retired = await peer.request({ type: "open_session", admissionId: "retired" });
			host.writer.recoveryCheckpoints.retireRoute(
				{ socketEpoch: host.writer.socketEpochOf("peer") ?? "", sessionId: String(retired.sessionId) },
				"retired",
				"client_detach",
			);
			host.writer.unregisterAdmission("peer", "retired");
			expect(host.writer.holdsAdmission("peer", "retired")).toBe(false);
			await foreign.request({ type: "open_session", admissionId: "foreign" });
			const lane = host.writer.recoveryLane(sessionId) ?? expect.unreachable();
			const socketEpoch = host.writer.socketEpochOf("peer") ?? expect.unreachable();
			const cut = host.writer.recoveryCheckpoints.freeze(
				{ socketEpoch, sessionId, admissionId: "own", routeKind: "ordinary", peer: "peer" },
				lane,
			);
			if (!cut.ok) throw new Error(JSON.stringify(cut.failure));
			host.writer.setConnectionCapabilities("peer", ["compact_events"]);
			host.writer.enqueue(sessionId, {
				type: "tool_execution_end",
				result: { content: [{ type: "text", text: "x".repeat(300_000) }] },
			});
			await host.writer.flush();
			const event = peer.inbox.find((frame) => frame.eventLease !== undefined)?.eventLease as
				| { id: string }
				| undefined;
			const tokenId = kind === "checkpoint" ? cut.value.token.id : (event?.id ?? expect.unreachable());
			const command = {
				id: "same-request",
				type,
				sessionId,
				lease: { kind, id: tokenId },
				admissionId: "own",
				componentRef: kind === "checkpoint" ? "manifest" : "record",
				requestId: "page",
			};
			if (type === "get_recovery_page") expect(dataOf(await peer.request(command))).toMatchObject({ ordinal: 1 });
			const bytes: string[] = [];
			for (const admissionId of ["unknown", "retired", "foreign"]) {
				const start = peer.received.length;
				await host.writer.withConnection("peer", () =>
					host.core.handle(JSON.stringify({ ...command, admissionId })),
				);
				await host.writer.flush();
				const replies = peer.received.slice(start);
				expect(replies).toHaveLength(1);
				const line = replies[0] ?? expect.unreachable();
				expect(JSON.parse(line)).toMatchObject({
					success: false,
					errorCode: "recovery_repair_needed",
					errorData: {
						reason: "unknown_token",
						...(type === "get_recovery_page"
							? { repair: { source: null, healthRevision: null, retryAfterMs: expect.any(Number) } }
							: {}),
					},
				});
				bytes.push(line);
			}
			const foreignStart = foreign.received.length;
			await host.writer.withConnection("foreign", () => host.core.handle(JSON.stringify(command)));
			await host.writer.flush();
			expect(foreign.received.slice(foreignStart)).toEqual([bytes[0]]);
			if (kind === "event")
				expect(dataOf(await peer.request({ ...command, type: "release_recovery" }))).toMatchObject({
					outcome: "released",
				});
			host.writer.recoveryCheckpoints.release(cut.value.token);
			host.writer.recoveryEvents?.forgetPeer(socketEpoch);
			// The same presented bytes are now unknown, rather than a valid token under a mismatched admission.
			const unknownStart = peer.received.length;
			await host.writer.withConnection("peer", () => host.core.handle(JSON.stringify(command)));
			await host.writer.flush();
			expect(peer.received.slice(unknownStart)).toEqual([bytes[0]]);
			expect(new Set(bytes).size).toBe(1);
		}, 600_000);
	}
}

it("RULING-94 unknown cancel reads its own epoch once and replies exactly once after the async refusal", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	await peer.request({ type: "open_session", admissionId: "own" });
	const pending = vi.spyOn(CompactAdmissions.prototype, "pending");
	const cancel = vi.spyOn(CompactAdmissions.prototype, "cancel");
	const read = vi.spyOn(storage, "readAdmissionRow");
	await host.writer.flush();
	const start = peer.received.length;
	await host.writer.withConnection("peer", () =>
		host.core.handle(JSON.stringify({ id: "cancel", type: "cancel_attempt", admissionId: "missing" })),
	);
	await host.writer.flush();
	expect(pending).toHaveBeenCalledExactlyOnceWith(host.writer.socketEpochOf("peer"), "missing");
	expect(read).toHaveBeenCalledTimes(1);
	expect(cancel).not.toHaveBeenCalled();
	const replies = peer.received.slice(start);
	expect(replies).toHaveLength(1);
	expect(JSON.parse(replies[0] ?? "")).toMatchObject({
		id: "cancel",
		success: false,
		code: "unknown_admission",
		admissionId: "missing",
	});
}, 600_000);
