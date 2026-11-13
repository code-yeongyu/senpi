/**
 * senpi#6561: a compact `open_session`, `subscribe_sessions` or `reset_stream` hands its answer to its admission
 * baseline, and the connection writes it later, outside the place that takes a host's other answers. These rows hold
 * that such an answer is still the request's one answer: it is noted where it is handed to a baseline the connection
 * took, and it is not noted when nothing will write it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { admissionBaseline } from "../../../src/modes/rpc/compact-admission-baseline.ts";
import { answerLine } from "../../../src/modes/rpc/host-line-answer.ts";
import { GeneratedFramesCursor } from "../../../src/modes/rpc/legacy-view-cursor.ts";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

const FAILURE = "retiring the route failed";
const LIST: RpcCommand = { id: "r1", type: "list_sessions" };
const ANSWER = { id: "r1", type: "response", command: "list_sessions", success: true };
const IDENTITY = { sessionId: "s1", admissionId: "a1", generation: 1 };

type Host = Awaited<ReturnType<typeof statusHost>>;
type Peer = ReturnType<Host["client"]>;

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

const quietStderr = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);
const emptyView = () =>
	new GeneratedFramesCursor(
		true,
		async function* () {},
		() => {},
	);

/** The responses `peer` received under `id`, read after one more request so everything queued before it was written. */
async function answersUnder(peer: Peer, id: string) {
	await peer.request({ type: "get_protocol_info" });
	return peer.inbox.filter((record) => record.type === "response" && record.id === id);
}

/** A handler that writes its answer through an admission baseline, as a compact open does, and then throws. */
const handsOverThenThrows = (host: Host, view: "taken" | "empty", answer: typeof ANSWER | undefined) => ({
	dispatch: async () => {
		const reply = host.writer.baselineAnswer("peer");
		reply.install(() =>
			host.writer.installAdmissionBaseline(
				"peer",
				view === "taken" ? admissionBaseline(reply.answer, IDENTITY, () => false) : emptyView(),
				() => true,
			),
		);
		reply.hand(answer);
		throw new Error(FAILURE);
	},
});

/** A compact open under the id `open-1`, cancelled while it runs, whose route retirement fails afterwards. */
async function cancelledOpenWhoseRetirementFails(host: Host, peer: Peer) {
	const pair = ["compact_message_updates_v1", "event_resync"];
	expect(await peer.request({ type: "get_protocol_info" })).toMatchObject({
		data: { capabilities: expect.arrayContaining(pair) },
	});
	expect(await peer.request({ type: "set_client_info", capabilities: pair })).toMatchObject({ success: true });
	quietStderr();
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
	return retired;
}

it("#given a compact open cancelled while it ran, whose route retirement fails after its answer was handed over #then the connection receives one response under the open's id", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");

	const retired = await cancelledOpenWhoseRetirementFails(host, peer);

	// The seam was reached: the retirement ran, after the answer was handed over, and failed.
	expect(retired).toHaveBeenCalled();
	const answers = await answersUnder(peer, "open-1");
	expect(answers.map((record) => record.code ?? record.errorCode)).toEqual(["attempt_cancelled"]);
}, 120_000);

it("#given the same open whose baseline the connection did not take #then the answer it handed over is written the ordinary way and is its one answer, #and the retirement is attempted once", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	vi.spyOn(host.writer, "installAdmissionBaseline").mockImplementation((_peer, cursor) => {
		cursor.release();
		return false;
	});

	const retired = await cancelledOpenWhoseRetirementFails(host, peer);

	const answers = await answersUnder(peer, "open-1");
	expect(answers).toHaveLength(1);
	expect(answers.map((record) => record.code ?? record.errorCode)).toEqual(["attempt_cancelled"]);
	expect(retired).toHaveBeenCalledTimes(1);
}, 120_000);

describe("an answer handed to an admission baseline, at the writer", () => {
	it("#given a handler that hands its answer to a baseline the connection took, and then throws #then the connection receives that one answer", async () => {
		await using host = await statusHost();
		const peer = host.client("peer");
		quietStderr();

		await host.writer.withConnection("peer", () =>
			answerLine(host.writer, "peer", handsOverThenThrows(host, "taken", ANSWER), LIST),
		);

		expect(await answersUnder(peer, "r1")).toEqual([
			expect.objectContaining({ command: "list_sessions", success: true }),
		]);
	}, 120_000);

	it("#given a baseline the connection did not take, an empty view #then the answer handed to it is written the ordinary way, and the throw gets no second answer", async () => {
		await using host = await statusHost();
		const peer = host.client("peer");
		quietStderr();

		await host.writer.withConnection("peer", () =>
			answerLine(host.writer, "peer", handsOverThenThrows(host, "empty", ANSWER), LIST),
		);

		expect(await answersUnder(peer, "r1")).toEqual([
			expect.objectContaining({ command: "list_sessions", success: true }),
		]);
	}, 120_000);

	it("#given a handler that ends its baseline with nothing to write, and then throws #then the throw gets the host's one answer", async () => {
		await using host = await statusHost();
		const peer = host.client("peer");
		quietStderr();

		await host.writer.withConnection("peer", () =>
			answerLine(host.writer, "peer", handsOverThenThrows(host, "taken", undefined), LIST),
		);

		expect(await answersUnder(peer, "r1")).toEqual([expect.objectContaining({ success: false })]);
	}, 120_000);

	it("#given a connection that has no queue #then a baseline for it is not taken, #and the answer handed to it is not noted", async () => {
		await using host = await statusHost();
		const watch = host.writer.answered.watch("nobody", "r1");
		const reply = host.writer.baselineAnswer("nobody");

		reply.install(() =>
			host.writer.installAdmissionBaseline(
				"nobody",
				admissionBaseline(reply.answer, IDENTITY, () => false),
				() => true,
			),
		);
		reply.hand(ANSWER);

		expect(reply.taken).toBe(false);
		expect(watch.answered()).toBe(false);
		watch.done();
	}, 120_000);
});
