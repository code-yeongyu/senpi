/**
 * senpi#6483's review: the host answers a host-level handler's throw, so a handler that had already answered under
 * the request's id and then threw would give that request two answers. The one place that answers a throw therefore
 * asks whether an answer under that id was already taken for that connection, and stays silent when it was.
 *
 * The first row drives a real compact open through the host's line handler. The others call `answerLine` itself
 * with the host's real writer and a handler that does exactly what the row says.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnsweredRequests } from "../../src/modes/rpc/answered-requests.ts";
import { answerLine } from "../../src/modes/rpc/host-line-answer.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { MAX_SHARED_STDIO_QUEUE_BYTES } from "../../src/modes/rpc/session-event-writer-lanes.ts";
import { RpcSessionRegistryError } from "../../src/modes/rpc/session-registry.ts";
import { statusHost } from "./rpc-session-status-support.ts";

const FAILURE = "the handler failed";
const LIST: RpcCommand = { id: "r1", type: "list_sessions" };
const ANSWER = { id: "r1", type: "response", command: "list_sessions", success: true, data: { sessions: [] } };

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

type Host = Awaited<ReturnType<typeof statusHost>>;
type Wire = Readonly<Record<string, unknown>>;

/** Every value the writer was asked to write, in order; the writer still writes them. */
function asked(host: Host): () => Wire[] {
	const spy = vi.spyOn(host.writer, "enqueueControl");
	return () => spy.mock.calls.map((call) => call[0] as Wire);
}
const under = (values: Wire[], id: string) => values.filter((value) => value.type === "response" && value.id === id);
const quietStderr = () => {
	const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	return () => spy.mock.calls.map((call) => String(call[0]));
};
const throwing = { dispatch: async () => Promise.reject(new Error(FAILURE)) };

describe("a host-level handler's throw is answered once (senpi#6483's review)", () => {
	it("#given a compact open that fails unexpectedly after it was accepted #when its line is handled #then the request gets one answer, the open's own tagged refusal", async () => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
		await using host = await statusHost();
		const peer = host.client("peer");
		const pair = ["compact_message_updates_v1", "event_resync"];
		expect(await peer.request({ type: "get_protocol_info" })).toMatchObject({
			data: { capabilities: expect.arrayContaining(pair) },
		});
		expect(await peer.request({ type: "set_client_info", capabilities: pair })).toMatchObject({ success: true });
		quietStderr();
		vi.spyOn(host.writer, "supersedeOpen").mockImplementation(() => {
			throw new Error(FAILURE);
		});

		await host.writer.withConnection("peer", () =>
			host.core.handle(JSON.stringify({ id: "held-open", type: "open_session", cwd: host.cwd, admissionId: "a1" })),
		);
		// This answer is queued behind everything the open's line queued for the connection.
		await peer.request({ type: "get_protocol_info" });

		const answers = peer.inbox.filter((record) => record.type === "response" && record.id === "held-open");
		expect(answers).toHaveLength(1);
		expect(answers[0]).toMatchObject({ success: false, admissionId: "a1" });
	}, 120_000);

	it("#given a handler that answers under the request's id and then throws #then that answer is the only one, #and a later request reusing the id, whose handler writes nothing, is answered", async () => {
		await using host = await statusHost();
		const values = asked(host);
		quietStderr();
		const answersThenThrows = {
			dispatch: async () => {
				await host.writer.enqueueControl(ANSWER);
				throw new Error(FAILURE);
			},
		};

		await answerLine(host.writer, undefined, answersThenThrows, LIST);
		expect(under(values(), "r1")).toEqual([ANSWER]);

		await answerLine(host.writer, undefined, throwing, LIST);
		expect(under(values(), "r1")).toEqual([
			ANSWER,
			expect.objectContaining({ success: false, errorCode: "internal_error" }),
		]);
	}, 120_000);

	it("#given a handler whose own answer the writer refused, as too large for the shared output #when it throws for that #then the request is still answered, by the host", async () => {
		await using host = await statusHost();
		const values = asked(host);
		quietStderr();
		const tooLarge = { ...ANSWER, data: { pad: "x".repeat(MAX_SHARED_STDIO_QUEUE_BYTES) } };

		await answerLine(
			host.writer,
			undefined,
			{ dispatch: async () => host.writer.enqueueControl(tooLarge).then(() => undefined) },
			LIST,
		);

		expect(under(values(), "r1").map((value) => value.success)).toEqual([true, false]);
		expect(under(values(), "r1")[1]).toMatchObject({ errorCode: "internal_error" });
	}, 120_000);

	it("#given a handler that throws having written nothing #then the request is answered once with internal_error and the failure, #and the host says so on stderr", async () => {
		await using host = await statusHost();
		const values = asked(host);
		const stderr = quietStderr();

		await answerLine(host.writer, undefined, throwing, LIST);

		expect(under(values(), "r1")).toEqual([
			expect.objectContaining({
				command: "list_sessions",
				success: false,
				errorCode: "internal_error",
				errorData: { detail: FAILURE },
			}),
		]);
		expect(stderr()).toContain(`senpi rpc stdio request failed: ${FAILURE}\n`);
	}, 120_000);

	it("#given a handler that throws a session registry refusal #then the request is answered with that refusal's code and data", async () => {
		await using host = await statusHost();
		const values = asked(host);
		quietStderr();
		const refusal = new RpcSessionRegistryError("session_held", undefined, { holder: "another connection" });

		await answerLine(host.writer, undefined, { dispatch: async () => Promise.reject(refusal) }, LIST);

		expect(under(values(), "r1")).toEqual([
			expect.objectContaining({
				success: false,
				errorCode: "session_held",
				errorData: { holder: "another connection" },
			}),
		]);
	}, 120_000);

	it("#given a command sent without an id, which is owed no answer #when its handler throws #then nothing is written for it, and the host still says so on stderr", async () => {
		await using host = await statusHost();
		const values = asked(host);
		const stderr = quietStderr();

		await answerLine(host.writer, "peer", throwing, { type: "list_sessions" });

		expect(values()).toEqual([]);
		expect(stderr()).toContain(`senpi rpc connection peer failed: ${FAILURE}\n`);
	}, 120_000);
});

describe("which requests in flight were answered", () => {
	it("#given a watched request #then only a response under its id, taken for its connection, answers it", () => {
		const answered = new AnsweredRequests();
		const watch = answered.watch("peer", "r1");

		answered.taken("peer", { id: "r1", type: "session_opened" });
		answered.taken("peer", { id: "r2", type: "response" });
		answered.taken("another", { id: "r1", type: "response" });
		answered.taken(undefined, { id: "r1", type: "response" });
		expect(watch.answered()).toBe(false);

		answered.taken("peer", { id: "r1", type: "response" });
		expect(watch.answered()).toBe(true);
	});

	it("#given a request whose line is done #when its id is used again on the same connection #then the later request starts unanswered", () => {
		const answered = new AnsweredRequests();
		const first = answered.watch(undefined, "r1");
		answered.taken(undefined, { id: "r1", type: "response" });
		first.done();

		const second = answered.watch(undefined, "r1");

		expect(first.answered()).toBe(true);
		expect(second.answered()).toBe(false);
	});
});
