import { afterEach, expect, it, vi } from "vitest";
import { dirname, join } from "node:path";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";
import { SessionStatusStream } from "../../../src/modes/rpc/session-status-stream.ts";
import { statusSnapshot } from "../../../src/modes/rpc/compact-status-snapshot.ts";
import { parseSubscription } from "../../../src/modes/rpc/session-status-subscriptions.ts";
import { compareAdmissionGoldens } from "./4272-admission-golden-support.ts";
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

it("T2/X04 a streamed host snapshot spans bounded pages, rejects a foreign peer and releases on disconnect", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const owner = host.client("owner");
	await owner.request({ type: "open_session", cwd: host.cwd });
	const parsed = parseSubscription({});
	if (!("options" in parsed)) expect.unreachable();
	const capture = host.writer.status.subscribe("capture", parsed.options);
	const row = capture.snapshot[0] ?? expect.unreachable("missing actual status row");
	host.writer.status.unsubscribe("capture", capture.subscriptionId);
	const peer = host.client("peer");
	const foreign = host.client("foreign");
	const epoch = host.writer.socketEpochOf("peer") ?? expect.unreachable();
	const events = host.writer.recoveryEvents ?? expect.unreachable();
	const lease = statusSnapshot(events, epoch, "large", "large-sub", function* () {
		for (let index = 0; index < 300; index++) yield { ...row, sessionId: `s-${index}`, cwd: "x".repeat(2_000) };
	});
	host.writer.registerSubscription("peer", "large", "large-sub");
	const request = {
		type: "get_recovery_page",
		sessionId: "large-sub",
		admissionId: "large",
		lease,
		componentRef: "record",
	};
	expect(await foreign.request({ ...request, requestId: "foreign" })).toMatchObject({
		success: false,
		errorData: { reason: "unknown_token" },
	});
	const pages: Buffer[] = [];
	let cursor: string | undefined;
	for (;;) {
		const answer = await peer.request({
			...request,
			requestId: `large-${pages.length}`,
			...(cursor ? { cursor } : {}),
		});
		expect(answer).toMatchObject({ admissionId: "large", generation: 0 });
		const page = dataOf(answer) as { bytes: string; length: number; complete: boolean; cursor: string | null };
		expect(page.length).toBeLessThanOrEqual(131_072);
		pages.push(Buffer.from(page.bytes, "base64"));
		if (page.complete) break;
		cursor = page.cursor ?? expect.unreachable("incomplete page without cursor");
	}
	expect(pages.length).toBeGreaterThan(1);
	const decoded = JSON.parse(Buffer.concat(pages).toString("utf16le")) as {
		seq: number;
		snapshot: { sessionId: string }[];
	};
	expect(decoded.seq).toBe(0);
	expect(decoded.snapshot).toHaveLength(300);
	expect(decoded.snapshot[299]?.sessionId).toBe("s-299");
	expect(events.status().open).toBe(1);
	await host.drop("peer");
	expect(events.status()).toMatchObject({ open: 0, contentBytes: 0 });
}, 120_000);

it("T2/X04 golden f: returned subscription id owns every snapshot page and live suffix", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-29T00:00:00.000Z") });
	await using host = await statusHost();
	const owner = host.client("owner");
	const opened = await owner.request({
		type: "open_session",
		cwd: host.cwd,
		sessionPath: join(host.cwd, "snapshot.jsonl"),
	});
	const peer = host.client("peer");
	const answer = await peer.request({ type: "subscribe_sessions", admissionId: "golden-f", include_context: true });
	const subscriptionId = dataOf(answer).subscriptionId;
	expect(subscriptionId).not.toBe("golden-f");
	const baseline = await peer.waitFor(
		(frame) => frame.type === "recovery_manifest" && frame.admissionId === "golden-f",
	);
	const page = await peer.request({
		type: "get_recovery_page",
		sessionId: baseline.sessionId,
		admissionId: "golden-f",
		lease: baseline.eventLease,
		componentRef: "record",
		requestId: "f-page",
	});
	expect(page).toMatchObject({ success: true, sessionId: subscriptionId, admissionId: "golden-f", generation: 0 });
	expect(
		await owner.request({
			type: "set_session_context",
			sessionId: opened.sessionId,
			patch: { task_status: "fixture" },
		}),
	).toMatchObject({ success: true });
	const delta = await peer.waitFor(
		(frame) => frame.type === "session_status" && frame.subscriptionId === subscriptionId,
	);
	expect(delta).toMatchObject({ admissionId: "golden-f", generation: 0, seq: 1 });
	await peer.request({ type: "unsubscribe_sessions", subscriptionId });
	await peer.request({
		type: "release_recovery",
		sessionId: subscriptionId,
		admissionId: "golden-f",
		lease: baseline.eventLease,
	});
	expect(host.writer.status.connectionSize("peer")).toBe(0);
	expect(host.writer.recoveryEvents?.status().open).toBe(0);
	await compareAdmissionGoldens(
		{
			"f-subscribe.json": {
				request: JSON.parse(peer.sent[0] ?? "") as unknown,
				answer,
				baseline,
				page,
				delta,
			},
		},
		dirname(host.cwd),
	);
}, 120_000);

it("T2/X04 cancellation racing subscribe cleans the actual returned subscription id, not the client id", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	const entered = Promise.withResolvers<string>();
	const subscribe = SessionStatusStream.prototype.subscribe;
	vi.spyOn(SessionStatusStream.prototype, "subscribe").mockImplementationOnce(function (
		this: SessionStatusStream,
		...args
	) {
		const result = subscribe.apply(this, args);
		entered.resolve(result.subscriptionId);
		return result;
	});
	const unsubscribe = vi.spyOn(host.writer.status, "unsubscribe");
	const pending = peer.request({ type: "subscribe_sessions", admissionId: "late-client-id" });
	const actual = await entered.promise;
	expect(dataOf(await peer.request({ type: "cancel_attempt", admissionId: "late-client-id" }))).toEqual({
		outcome: "cancelled",
	});
	const answer = await pending;
	expect(dataOf(answer).subscriptionId).toBe(actual);
	expect(unsubscribe).toHaveBeenCalledExactlyOnceWith("peer", actual);
	expect(host.writer.status.connectionSize("peer")).toBe(0);
	expect(host.writer.recoveryEvents?.status().open).toBe(0);
	expect(peer.inbox.some((frame) => frame.type === "recovery_manifest")).toBe(false);
}, 120_000);

// #4272 T2/X04, RULING-66 S15-Q3: small identity before the host-wide seq-0
// snapshot; its content is paged and released by consumption, not socket drain.
it("T2/X04 compact subscribe owns a pageable seq-zero snapshot and releases it on consumption", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	vi.stubEnv("SENPI_RPC_REQUIRE_ATTACH", "1");
	await using host = await statusHost();
	const owner = host.client("owner");
	await owner.request({ type: "open_session", cwd: host.cwd });
	const peer = host.client("peer");
	const answer = await peer.request({ type: "subscribe_sessions", admissionId: "status-all" });
	const data = dataOf(answer);
	expect(data.snapshot).toBeUndefined();
	expect(data.subscriptionId).toEqual(expect.any(String));
	const baseline = await peer.waitFor(
		(frame) => frame.type === "recovery_manifest" && frame.admissionId === "status-all",
	);
	expect(peer.inbox.indexOf(answer)).toBeLessThan(peer.inbox.indexOf(baseline));
	const page = dataOf(
		await peer.request({
			type: "get_recovery_page",
			sessionId: baseline.sessionId,
			admissionId: "status-all",
			lease: baseline.eventLease,
			componentRef: "record",
			requestId: "status-page",
		}),
	);
	expect(typeof page.bytes).toBe("string");
	const bytes = typeof page.bytes === "string" ? page.bytes : "";
	expect(JSON.parse(Buffer.from(bytes, "base64").toString("utf16le"))).toMatchObject({
		seq: 0,
		snapshot: [expect.objectContaining({ type: "session_status", seq: 0 })],
	});
	expect(host.writer.recoveryEvents?.status().open).toBe(1);
	await peer.request({
		type: "release_recovery",
		sessionId: baseline.sessionId,
		admissionId: "status-all",
		lease: baseline.eventLease,
	});
	expect(host.writer.recoveryEvents?.status().open).toBe(0);
}, 120_000);
