import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionRequest } from "../../src/core/extensions/types.ts";
import type { ToolRequestUserInputParams } from "../../src/modes/app-server/protocol/generated/v2/ToolRequestUserInputParams.ts";
import type { RpcEnvelope } from "../../src/modes/app-server/rpc/envelope.ts";
import { createRegistry } from "../../src/modes/app-server/rpc/registry.ts";
import { ApprovalBridge, createAppServerUIContext } from "../../src/modes/app-server/server/approvals.ts";
import { NotificationRouter } from "../../src/modes/app-server/server/notifications.ts";
import { UserInputBridge } from "../../src/modes/app-server/server/user-input-bridge.ts";
import type { UserInputOutboundMessage } from "../../src/modes/app-server/server/user-input-types.ts";
import { createRoutedServerCore } from "../../src/modes/app-server/turn-adapter.ts";

const params: QuestionRequest = {
	requestId: "tool-1",
	waitForAnswer: true,
	timeoutMs: 1000,
	questions: [
		{
			id: "choice",
			header: "Choice",
			question: "Which?",
			options: [{ label: "A", description: "First" }, { label: "B" }],
			multiSelect: true,
		},
		{ id: "text", header: "Text", question: "Details?", options: [], multiSelect: false },
	],
};
function setup(subscribers = 1) {
	const sent: UserInputOutboundMessage[] = [];
	const bridge = new UserInputBridge((_thread, message) => {
		sent.push(message);
		return subscribers;
	});
	const ask = (request = params) => bridge.requestUserInput("thread-1", "turn-1", "tool-1", request);
	return { bridge, sent, ask };
}
function requestId(sent: UserInputOutboundMessage[]) {
	const request = sent.find((message) => "id" in message);
	if (!request || !("id" in request)) throw new Error("missing request");
	return request.id;
}
afterEach(() => vi.useRealTimers());

describe("app-server user input", () => {
	it("emits generated-compatible params with additive question fields", async () => {
		const { bridge, sent, ask } = setup();
		const answer = ask();
		const request = sent[0];
		if (!request || !("id" in request)) throw new Error("missing request");
		const generated: ToolRequestUserInputParams = request.params;
		expect(generated).toEqual({
			threadId: "thread-1",
			turnId: "turn-1",
			itemId: "tool-1",
			autoResolutionMs: null,
			timeoutMs: 1000,
			waitForAnswer: true,
			questions: [
				{
					...params.questions[0],
					isOther: true,
					isSecret: false,
					options: [
						{ label: "A", description: "First" },
						{ label: "B", description: "" },
					],
				},
				{ ...params.questions[1], isOther: true, isSecret: false, options: null },
			],
		});
		expect(request.method).toBe("item/tool/requestUserInput");
		bridge.cancelPendingForThread("thread-1");
		await expect(answer).resolves.toMatchObject({ status: "cancelled" });
	});
	it("first responder wins and partial answers plus comment resolve", async () => {
		const { bridge, sent, ask } = setup(2);
		const answer = ask();
		const id = requestId(sent);
		expect(
			bridge.resolveResponse({ id, result: { answers: { choice: { answers: ["A"] } }, comment: "Proceed" } }),
		).toBe(true);
		expect(bridge.resolveResponse({ id, result: { answers: {} } })).toBe(false);
		await expect(answer).resolves.toEqual({
			status: "comment-submitted",
			answers: { choice: { selected: ["A"] } },
			comment: "Proceed",
			unanswered: ["text"],
		});
		expect(sent.filter((message) => message.method === "serverRequest/resolved")).toHaveLength(1);
	});
	it("maps fully answered replies and free text", async () => {
		const { bridge, sent, ask } = setup();
		const answer = ask();
		bridge.resolveResponse({
			id: requestId(sent),
			result: { answers: { choice: { answers: ["A"] }, text: { answers: ["details"] } } },
		});
		await expect(answer).resolves.toMatchObject({
			status: "answered",
			unanswered: [],
			answers: { text: { selected: [], text: "details" } },
		});
	});
	it("replays only pending requests for the subscribing thread", async () => {
		const { bridge, sent, ask } = setup();
		const answer = ask();
		expect(bridge.replayPendingForThread("other")).toBe(0);
		expect(bridge.replayPendingForThread("thread-1")).toBe(1);
		expect(sent[1]).toEqual(sent[0]);
		bridge.cancelPendingForThread("thread-1");
		await answer;
		expect(bridge.replayPendingForThread("thread-1")).toBe(0);
	});
	it("cancels on thread end with a resolved notification", async () => {
		const { bridge, sent, ask } = setup();
		const answer = ask();
		const id = requestId(sent);
		expect(bridge.cancelPendingForThread("other")).toBe(0);
		expect(bridge.cancelPendingForThread("thread-1")).toBe(1);
		await expect(answer).resolves.toMatchObject({ status: "cancelled", unanswered: ["choice", "text"] });
		expect(sent[1]).toEqual({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: id } });
		expect(bridge.pendingCount).toBe(0);
	});
	it("resolves unavailable immediately without subscribers or timers", async () => {
		vi.useFakeTimers();
		const { bridge, ask } = setup(0);
		await expect(ask()).resolves.toMatchObject({ status: "unavailable" });
		expect(bridge.pendingCount).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("progress resets the idle timer and preserves the draft on timeout", async () => {
		vi.useFakeTimers();
		const { bridge, sent, ask } = setup();
		const answer = ask();
		await vi.advanceTimersByTimeAsync(900);
		expect(
			bridge.progress({ requestId: requestId(sent), answers: { choice: { answers: ["B"] } }, comment: "draft" }),
		).toBe(true);
		await vi.advanceTimersByTimeAsync(900);
		expect(bridge.pendingCount).toBe(1);
		await vi.advanceTimersByTimeAsync(100);
		await expect(answer).resolves.toMatchObject({
			status: "timed_out",
			answers: { choice: { selected: ["B"] } },
			comment: "draft",
			autoResolvedAfterMs: 1900,
		});
		expect(vi.getTimerCount()).toBe(0);
	});
	it("unknown and malformed responses leave pending input unchanged", async () => {
		const { bridge, sent, ask } = setup();
		const answer = ask();
		expect(bridge.resolveResponse({ id: "unknown", result: { answers: {} } })).toBe(false);
		expect(() =>
			bridge.resolveResponse({ id: requestId(sent), result: { answers: { choice: { answers: [42] } } } }),
		).toThrow();
		expect(bridge.pendingCount).toBe(1);
		bridge.cancelPendingForThread("thread-1");
		await answer;
	});
	it("delegates UI questions and handles abort and progress callbacks", async () => {
		const { bridge, sent } = setup();
		const abort = new AbortController();
		const onProgress = vi.fn();
		const ui = createAppServerUIContext(new ApprovalBridge(() => 0), "thread-1", bridge, () => "turn-1");
		const answer = ui.question?.(params, { signal: abort.signal, onProgress });
		bridge.progress({ requestId: requestId(sent), answers: {}, comment: "draft" });
		expect(onProgress).toHaveBeenCalledWith({ answers: {}, comment: "draft" });
		abort.abort();
		await expect(answer).resolves.toMatchObject({ status: "cancelled" });
	});
	it("routes responses and progress through the initialized server connection", async () => {
		vi.useFakeTimers();
		const { bridge, sent, ask } = setup();
		const output: RpcEnvelope[] = [];
		const core = createRoutedServerCore(
			createRegistry(),
			new NotificationRouter(),
			new ApprovalBridge(() => 0),
			undefined,
			{},
			bridge,
		);
		core.addConnection({
			id: "client",
			transportKind: "stdio",
			send: (message) => {
				output.push(message);
			},
			close: () => {},
		});
		try {
			await core.receive("client", {
				kind: "request",
				message: { id: 1, method: "initialize", params: { clientInfo: { name: "test", version: "1" } } },
			});
			const answer = ask();
			const id = requestId(sent);
			await core.receive("client", { kind: "response", message: { id: "unknown", result: { answers: {} } } });
			expect(output.at(-1)).toMatchObject({ id: "unknown", error: { code: -32600 } });
			expect(bridge.pendingCount).toBe(1);
			await vi.advanceTimersByTimeAsync(900);
			await core.receive("client", {
				kind: "notification",
				message: { method: "item/tool/userInputProgress", params: { requestId: id, answers: {} } },
			});
			await vi.advanceTimersByTimeAsync(900);
			expect(bridge.pendingCount).toBe(1);
			await core.receive("client", {
				kind: "response",
				message: { id, result: { answers: {}, comment: "continue" } },
			});
			await expect(answer).resolves.toMatchObject({ status: "comment-submitted" });
		} finally {
			bridge.cancelPendingForThread("thread-1");
			core.removeConnection("client");
		}
	});
});
