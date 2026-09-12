/**
 * Async (`waitForAnswer:false`) questions are answered on one surface but
 * delivered by the extension: the answer - and the idle timeout - must reach
 * the model as exactly ONE framed user message no matter which bridge resolved
 * the question. These cases pin that contract for the RPC and app-server
 * bridges; the interactive TUI is covered in ask-user-async-tui.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, QuestionResponse } from "../../src/core/extensions/types.ts";
import { ApprovalBridge, createAppServerUIContext } from "../../src/modes/app-server/server/approvals.ts";
import { UserInputBridge } from "../../src/modes/app-server/server/user-input-bridge.ts";
import type { UserInputOutboundMessage } from "../../src/modes/app-server/server/user-input-types.ts";
import { ConnectionQuestionBridge } from "../../src/modes/rpc/connection-question-bridge.ts";
import { ASYNC_QUESTIONS, type AskUserDelivery, createAskUserDelivery } from "./helpers/ask-user-delivery.ts";

const TIMEOUT_MARKER = "(사용자가 답변을 안하고 timeout 으로 종료됨)";
const deliveries: AskUserDelivery[] = [];

afterEach(() => {
	for (const delivery of deliveries.splice(0)) delivery.harness.cleanup();
	vi.useRealTimers();
});

async function setup(timeoutMinutes?: number): Promise<AskUserDelivery> {
	const delivery = await createAskUserDelivery(timeoutMinutes);
	deliveries.push(delivery);
	return delivery;
}

/** Start an async question; the returned `settled` promise resolves after delivery ran. */
async function askAsync(
	delivery: AskUserDelivery,
	ctx: ExtensionContext,
	requestId: string,
): Promise<{ settled: Promise<QuestionResponse> }> {
	const result = await delivery.tool.execute(
		requestId,
		{ questions: ASYNC_QUESTIONS, waitForAnswer: false },
		undefined,
		undefined,
		ctx,
	);
	expect(result.details).toMatchObject({ accepted: true, status: "pending" });
	return { settled: delivery.settled(ctx, requestId) };
}

function rpcSetup(delivery: AskUserDelivery, idle = true) {
	/** Everything the bridge broadcasts to attached connections, in order. */
	const broadcasts: object[] = [];
	const bridge = new ConnectionQuestionBridge((record) => broadcasts.push(record));
	const ctx = delivery.context((request, opts) => bridge.ask(request, opts), idle);
	const pendingId = () => {
		const id = bridge.pendingQuestions()[0]?.id;
		if (id === undefined) throw new Error("the RPC bridge has no pending question");
		return id;
	};
	return { bridge, broadcasts, ctx, pendingId };
}

function appServerSetup(delivery: AskUserDelivery) {
	const sent: UserInputOutboundMessage[] = [];
	const bridge = new UserInputBridge((_threadId, message) => {
		sent.push(message);
		return 1;
	});
	const ui = createAppServerUIContext(new ApprovalBridge(() => 0), "thread-1", bridge, () => "turn-1");
	const question = ui.question;
	if (!question) throw new Error("the app-server UI context has no question bridge");
	const ctx = delivery.context((request, opts) => question.call(ui, request, opts));
	const pendingId = () => {
		const request = sent.find((message) => "id" in message);
		if (!request || !("id" in request)) throw new Error("the app-server bridge sent no request");
		return request.id;
	};
	return { bridge, ctx, pendingId };
}

describe("async ask-user delivery over the RPC bridge", () => {
	it("delivers an answer as exactly one framed user message", async () => {
		const delivery = await setup();
		const { bridge, ctx, pendingId } = rpcSetup(delivery);
		const { settled } = await askAsync(delivery, ctx, "rpc-answer");

		expect(
			bridge.respond({ type: "extension_ui_response", id: pendingId(), answers: { q1: { selected: ["OAuth"] } } }),
		).toBe(true);
		await settled;

		expect(delivery.deliveries).toEqual([
			{ content: "[Answer to question rpc-answer]\nLibrary: OAuth", options: { deliverAs: "followUp" } },
		]);
	});

	it("steers the answer into the turn that is still running", async () => {
		const delivery = await setup();
		const { bridge, ctx, pendingId } = rpcSetup(delivery, false);
		const { settled } = await askAsync(delivery, ctx, "rpc-steer");

		bridge.respond({ type: "extension_ui_response", id: pendingId(), answers: {}, comment: "use bun" });
		await settled;

		expect(delivery.deliveries).toEqual([
			{
				content: "[Answer to question rpc-steer]\nThe user responded: use bun\nUnanswered: Library",
				options: { deliverAs: "steer" },
			},
		]);
	});

	it("delivers the idle timeout as exactly one message that triggers a turn", async () => {
		const delivery = await setup(1);
		const { ctx } = rpcSetup(delivery);
		vi.useFakeTimers();
		const { settled } = await askAsync(delivery, ctx, "rpc-timeout");

		await vi.advanceTimersByTimeAsync(60_000);
		await settled;

		expect(delivery.deliveries).toHaveLength(1);
		expect(String(delivery.deliveries[0]?.content)).toContain(TIMEOUT_MARKER);
		expect(String(delivery.deliveries[0]?.content)).toContain("[Answer to question rpc-timeout]");
		expect(delivery.deliveries[0]?.options).toEqual({ deliverAs: "followUp" });
	});

	it("broadcasts the idle timeout as timed_out, not cancelled", async () => {
		// The extension-side idle timer (pending.ts) and the bridge's own timer are
		// armed for the same delay; whichever fires first, connections must see the
		// outcome the extension resolved.
		const delivery = await setup(1);
		const { broadcasts, ctx } = rpcSetup(delivery);
		vi.useFakeTimers();
		const { settled } = await askAsync(delivery, ctx, "rpc-timeout-outcome");

		await vi.advanceTimersByTimeAsync(60_000);
		await expect(settled).resolves.toMatchObject({ status: "timed_out" });

		const resolved = broadcasts.filter((record) => "type" in record && record.type === "question_resolved");
		expect(resolved).toHaveLength(1);
		expect(resolved[0]).toMatchObject({ outcome: "timed_out", requestId: "rpc-timeout-outcome" });
	});
});

describe("async ask-user delivery over the app-server bridge", () => {
	it("delivers an answer as exactly one framed user message", async () => {
		const delivery = await setup();
		const { bridge, ctx, pendingId } = appServerSetup(delivery);
		const { settled } = await askAsync(delivery, ctx, "app-answer");

		expect(bridge.resolveResponse({ id: pendingId(), result: { answers: { q1: { answers: ["OAuth"] } } } })).toBe(
			true,
		);
		await settled;

		expect(delivery.deliveries).toEqual([
			{ content: "[Answer to question app-answer]\nLibrary: OAuth", options: { deliverAs: "followUp" } },
		]);
	});

	it("delivers the idle timeout as exactly one message that triggers a turn", async () => {
		const delivery = await setup(1);
		const { ctx } = appServerSetup(delivery);
		vi.useFakeTimers();
		const { settled } = await askAsync(delivery, ctx, "app-timeout");

		await vi.advanceTimersByTimeAsync(60_000);
		await settled;

		expect(delivery.deliveries).toHaveLength(1);
		expect(String(delivery.deliveries[0]?.content)).toContain(TIMEOUT_MARKER);
		expect(delivery.deliveries[0]?.options).toEqual({ deliverAs: "followUp" });
	});

	it("delivers nothing when the question is cancelled with the thread", async () => {
		const delivery = await setup();
		const { bridge, ctx } = appServerSetup(delivery);
		const { settled } = await askAsync(delivery, ctx, "app-cancelled");

		expect(bridge.cancelPendingForThread("thread-1")).toBe(1);
		await expect(settled).resolves.toMatchObject({ status: "cancelled" });

		expect(delivery.deliveries).toEqual([]);
	});
});
