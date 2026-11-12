/**
 * senpi#6561: a compact `open_session` hands its reply to its admission baseline, and the connection writes it later,
 * outside the place that records which requests were answered. The one answer per request then rests on nothing
 * failing after the hand-over. Here something does: the open was cancelled while it ran, its cancelled answer is
 * handed over, and the step that retires its route right afterwards fails.
 */
import { afterEach, expect, it, vi } from "vitest";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

const FAILURE = "retiring the route failed";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it("#given a compact open cancelled while it ran, whose route retirement fails after its answer was handed over #then the connection receives one response under the open's id", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	const pair = ["compact_message_updates_v1", "event_resync"];
	expect(await peer.request({ type: "get_protocol_info" })).toMatchObject({
		data: { capabilities: expect.arrayContaining(pair) },
	});
	expect(await peer.request({ type: "set_client_info", capabilities: pair })).toMatchObject({ success: true });
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
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
	const retired = vi.spyOn(host.writer, "unregisterAdmission").mockImplementation(() => {
		throw new Error(FAILURE);
	});

	const pending = host.writer.withConnection("peer", () =>
		host.core.handle(JSON.stringify({ id: "open-1", type: "open_session", cwd: host.cwd, admissionId: "a1" })),
	);
	void pending.catch(() => {});
	try {
		await entered.promise;
		expect(dataOf(await peer.request({ type: "cancel_attempt", admissionId: "a1" }))).toEqual({
			outcome: "cancelled",
		});
	} finally {
		finish.resolve();
	}
	await pending;
	// This answer is queued behind everything the open's line queued for the connection.
	await peer.request({ type: "get_protocol_info" });

	// The seam was reached: the retirement ran, after the answer was handed over, and failed.
	expect(retired).toHaveBeenCalled();
	const answers = peer.inbox.filter((record) => record.type === "response" && record.id === "open-1");
	expect(answers.map((record) => record.code ?? record.errorCode)).toEqual(["attempt_cancelled"]);
}, 120_000);
