import { afterEach, expect, it, vi } from "vitest";
import { COMPACT_EVENTS_CAPABILITY } from "../../../src/modes/rpc/custom-capability.ts";
import { EVENT_RESYNC_CAPABILITY } from "../../../src/modes/rpc/socket-peer-recovery.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import type { RecoveryAdmission } from "../../../src/modes/rpc/compact-recovery-types.ts";
import { join } from "node:path";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

// #4272 T2/T5, RULING-57 and RULING-85 Q2: malformed client IDs must not
// fall through to legacy admission or acquire ownership. The public parser,
// router, registry and writer run unchanged; no test-only producer is needed.
// Existing recovery-ID tests exercise the validator, not these host routes.
it.each(["open_session", "subscribe_sessions", "get_recovery_page", "cancel_attempt"] as const)(
	"T2/T5 %s refuses malformed admissionId before allocating ownership",
	async (type) => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
		await using host = await statusHost();
		const client = host.client("peer");
		await client.request({
			type: "set_client_info",
			capabilities: [COMPACT_EVENTS_CAPABILITY, EVENT_RESYNC_CAPABILITY],
		});
		for (const admissionId of ["", "..", "a/b", "a\\b", "a\0b", "a".repeat(129), "한글", 1, null]) {
			const answer = await client.request({
				type,
				cwd: host.cwd,
				admissionId,
				...(type === "get_recovery_page"
					? {
							sessionId: "unknown-session",
							token: "unknown",
							componentRef: "unknown",
							requestId: "page-1",
						}
					: {}),
			});
			expect(answer, `${type} accepted malformed admissionId`).toMatchObject({
				success: false,
				errorData: { kind: "request_refused", reason: "malformed_request" },
			});
			expect(typeof answer.errorCode).toBe("string");
			expect(host.core.router.sessionCount).toBe(0);
			expect(host.writer.status.connectionSize("peer")).toBe(0);
			expect(client.inbox.some((record) => record.type === "session_opened")).toBe(false);
		}
	},
	120_000,
);

it("T2/T5 an identical live admission returns its original open without another hold", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const client = host.client("peer");
	const command = { type: "open_session", cwd: host.cwd, admissionId: "ordinary-1" };
	const open = vi.spyOn(RpcSessionRegistry.prototype, "openSession");
	const first = await client.request(command);
	const second = await client.request(command);
	expect(dataOf(second).sessionId).toBe(dataOf(first).sessionId);
	expect(second.id).not.toBe(first.id);
	expect(open).toHaveBeenCalledTimes(1);
	expect(client.inbox.filter((record) => record.type === "recovery_manifest")).toHaveLength(1);
	expect(host.core.router.sessionCount).toBe(1);
	const listed = dataOf(await client.request({ type: "list_sessions" })).sessions;
	expect(listed).toEqual([expect.objectContaining({ attachments: 1 })]);
}, 120_000);

it("T2/X04 a cancelled pending open releases only its own late hold and duplicate cancellation is idempotent", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const survivor = host.client("survivor");
	const peer = host.client("peer");
	const sessionPath = join(host.cwd, "shared.jsonl");
	const original = await survivor.request({
		type: "open_session",
		cwd: host.cwd,
		sessionPath,
		retain_on_disconnect: true,
	});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const open = RpcSessionRegistry.prototype.openSession;
	vi.spyOn(RpcSessionRegistry.prototype, "openSession").mockImplementationOnce(async function (
		this: RpcSessionRegistry,
		...args
	) {
		entered.resolve();
		await release.promise;
		return open.apply(this, args);
	});
	const pending = peer.request({ type: "open_session", cwd: host.cwd, sessionPath, admissionId: "pending-1" });
	try {
		await entered.promise;
		expect(dataOf(await survivor.request({ type: "cancel_attempt", admissionId: "pending-1" }))).toEqual({
			outcome: "unknown",
		});
		expect(dataOf(await peer.request({ type: "cancel_attempt", admissionId: "pending-1" }))).toEqual({
			outcome: "cancelled",
		});
		expect(dataOf(await peer.request({ type: "cancel_attempt", admissionId: "pending-1" }))).toEqual({
			outcome: "cancelled",
		});
	} finally {
		release.resolve();
	}
	expect(dataOf(await pending).sessionId).toBe(dataOf(original).sessionId);
	expect(dataOf(await peer.request({ type: "cancel_attempt", admissionId: "pending-1" }))).toEqual({
		outcome: "cancelled",
	});
	expect(dataOf(await survivor.request({ type: "list_sessions" })).sessions).toEqual([
		expect.objectContaining({ attachments: 1 }),
	]);
	const retired = await peer.request({
		type: "open_session",
		cwd: host.cwd,
		sessionPath,
		admissionId: "pending-1",
	});
	expect(retired).toMatchObject({ success: false, errorData: { reason: "admission_retired" } });
}, 120_000);

it("T2/X04 completion wins cancellation without dropping its accepted hold", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	await peer.request({ type: "open_session", cwd: host.cwd, admissionId: "complete-1" });
	for (let repeat = 0; repeat < 2; repeat++)
		expect(dataOf(await peer.request({ type: "cancel_attempt", admissionId: "complete-1" }))).toEqual({
			outcome: "already_complete",
		});
	expect(dataOf(await peer.request({ type: "list_sessions" })).sessions).toEqual([
		expect.objectContaining({ attachments: 1 }),
	]);
}, 120_000);

it("T2/T5 changing an open's identity cannot spend its admissionId twice", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const client = host.client("peer");
	await client.request({ type: "open_session", cwd: host.cwd, admissionId: "ordinary-1" });
	const changed = await client.request({
		type: "open_session",
		cwd: host.cwd,
		admissionId: "ordinary-1",
		retain_on_disconnect: true,
	});
	expect(changed).toMatchObject({
		success: false,
		errorData: { kind: "request_refused", reason: "admission_conflict" },
	});
	expect(host.core.router.sessionCount).toBe(1);
}, 120_000);

it("T2/X04 the identity answer precedes its pageable baseline and every page echoes the route", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	const baselineReady = peer.waitFor(
		(record) => record.type === "recovery_manifest" && record.admissionId === "route-1",
	);
	const answer = await peer.request({ type: "open_session", cwd: host.cwd, admissionId: "route-1" });
	const baseline = await baselineReady;
	expect(answer).toMatchObject({ admissionId: "route-1", generation: 1 });
	const token = host.writer.recoveryCheckpoints.tokens().find((token) => token.admission.admissionId === "route-1");
	const sessionId = String(answer.sessionId);
	expect(token?.admission).toEqual({
		socketEpoch: host.writer.socketEpochOf("peer") ?? expect.unreachable("missing peer epoch"),
		peer: "peer",
		sessionId,
		sessionEpoch: host.writer.recoveryLane(sessionId)?.sessionEpoch ?? expect.unreachable("missing lane"),
		admissionId: "route-1",
		routeKind: "ordinary",
		generation: 1,
	} satisfies RecoveryAdmission);
	expect(baseline).toMatchObject({
		sessionId: answer.sessionId,
		admissionId: "route-1",
		generation: answer.generation,
	});
	expect(peer.inbox.indexOf(answer)).toBeLessThan(peer.inbox.indexOf(baseline));
	expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(65_536);
	expect(Buffer.byteLength(JSON.stringify(baseline))).toBeLessThanOrEqual(65_536);
	const page = await peer.request({
		type: "get_recovery_page",
		sessionId: answer.sessionId,
		admissionId: "route-1",
		token: baseline.token,
		componentRef: baseline.componentRef,
		requestId: "manifest-1",
	});
	expect(page).toMatchObject({
		success: true,
		sessionId: answer.sessionId,
		admissionId: "route-1",
		generation: answer.generation,
	});
	const bytes = dataOf(page).bytes;
	if (typeof bytes !== "string") throw new Error("missing manifest page bytes");
	expect(JSON.parse(Buffer.from(bytes, "base64").toString("utf16le"))).toMatchObject({
		format: "senpi-recovery-manifest",
		admissionId: { id: "route-1" },
		generation: 1,
	});
}, 120_000);

it("T2 a response deadline rejects while the host handler is pending, without an unhandled waiter", async () => {
	await using host = await statusHost();
	const client = host.client("peer");
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const handled = Promise.withResolvers<void>();
	vi.spyOn(host.core, "handle").mockImplementationOnce(async () => {
		entered.resolve();
		await finish.promise;
		handled.resolve();
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const pending = client.request({ type: "list_sessions" });
	let settled = false;
	const refused = expect(pending)
		.rejects.toThrow("deadline waiting for")
		.then(() => {
			settled = true;
		});
	try {
		await entered.promise;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(settled, "the response waiter is observed before the handler finishes").toBe(true);
		await refused;
	} finally {
		finish.resolve();
		await handled.promise;
		vi.useRealTimers();
	}
}, 120_000);
