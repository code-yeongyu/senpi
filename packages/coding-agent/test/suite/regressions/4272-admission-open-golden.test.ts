import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, statusHost, type WireRecord } from "../rpc-session-status-support.ts";
import { compareAdmissionGoldens } from "./4272-admission-golden-support.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

it("T2 golden a-e: real request, identity, paged baseline, before-answer suffix and overlapping routes", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-29T00:00:00.000Z") });
	await using host = await statusHost();
	const peer = host.client("peer");
	const sessionPath = join(host.cwd, "golden.jsonl");
	const answer = await peer.request({ type: "open_session", cwd: host.cwd, sessionPath, admissionId: "golden-a" });
	const baseline = await peer.waitFor(
		(frame) => frame.type === "recovery_manifest" && frame.admissionId === "golden-a",
	);
	const early = peer.inbox
		.slice(0, peer.inbox.indexOf(answer))
		.filter((frame) => frame.sessionId === answer.sessionId);
	expect(early.some((frame) => frame.type === "session_opened")).toBe(true);
	for (const frame of early) expect(frame).toMatchObject({ admissionId: "golden-a", generation: 1 });
	const page = await peer.request({
		type: "get_recovery_page",
		sessionId: answer.sessionId,
		admissionId: "golden-a",
		token: baseline.token,
		componentRef: "manifest",
		requestId: "golden-page",
	});
	expect(page).toMatchObject({ success: true, sessionId: answer.sessionId, admissionId: "golden-a", generation: 1 });
	const pageRequest: unknown = JSON.parse(peer.sent[1] ?? "");
	const second = await peer.request({ type: "open_session", cwd: host.cwd, sessionPath, admissionId: "golden-b" });
	await peer.waitFor((frame) => frame.type === "recovery_manifest" && frame.admissionId === "golden-b");
	expect(second).toMatchObject({ sessionId: answer.sessionId, generation: 1 });
	const from = peer.inbox.length;
	host.writer.enqueue(String(answer.sessionId), { type: "agent_idle" });
	await host.writer.flush();
	const suffix = peer.inbox.slice(from).filter((frame) => frame.type === "agent_idle");
	expect(suffix.map((frame) => frame.admissionId)).toEqual(["golden-a", "golden-b"]);
	await compareAdmissionGoldens(
		{
			"a-request.json": { request: JSON.parse(peer.sent[0] ?? "") as unknown },
			"b-answer.json": { answer },
			"c-baseline.json": { baseline, request: pageRequest, page },
			"d-before-answer.json": { frames: early, answer },
			"e-overlap.json": {
				requests: [JSON.parse(peer.sent[0] ?? ""), JSON.parse(peer.sent[2] ?? "")] as unknown[],
				answers: [answer, second],
				suffix,
			},
		},
		dirname(host.cwd),
	);
}, 120_000);

it("T2/X04 golden g: late cancelled physical open closes once and indexed lookup repeats the typed refusal", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const open = RpcSessionRegistry.prototype.openSession;
	vi.spyOn(RpcSessionRegistry.prototype, "openSession").mockImplementationOnce(async function (
		this: RpcSessionRegistry,
		...args
	) {
		entered.resolve();
		await finish.promise;
		return open.apply(this, args);
	});
	const closed = vi.spyOn(RpcSessionRegistry.prototype, "closeMarked");
	const command = { type: "open_session", cwd: host.cwd, admissionId: "golden-g" };
	const pending = peer.request(command);
	let cancelled: WireRecord | undefined;
	try {
		await entered.promise;
		cancelled = await peer.request({ type: "cancel_attempt", admissionId: "golden-g" });
		expect(dataOf(cancelled)).toEqual({ outcome: "cancelled" });
	} finally {
		finish.resolve();
	}
	const answer = await pending;
	const replay = await peer.request(command);
	for (const frame of [answer, replay]) {
		expect(frame).toMatchObject({
			success: false,
			code: "attempt_cancelled",
			admissionId: "golden-g",
			generation: 1,
		});
		expect(frame).not.toHaveProperty("sessionId");
	}
	expect(host.core.router.sessionCount).toBe(0);
	expect(closed).toHaveBeenCalledTimes(1);
	await compareAdmissionGoldens(
		{
			"g-cancelled.json": {
				request: JSON.parse(peer.sent[0] ?? "") as unknown,
				cancelled,
				answer,
				replay,
			},
		},
		dirname(host.cwd),
	);
}, 120_000);
