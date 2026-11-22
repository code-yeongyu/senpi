/**
 * senpi#3768 / senpi#3588: an async `ask_user_question` answered during a busy run with the user's
 * own words (a comment, or a typed answer) is steered in as one user message with several text
 * blocks. Once it reaches the model it must leave every queue view: `getSteeringMessages()` (what
 * the TUI's `Steering:` line renders), `pendingMessageCount`, `getQueuedInputs()`, the last
 * `queue_update`, and the RPC state snapshot. Before the fix it stayed listed for the rest of the
 * session, which reads to the user as an answer that was never applied.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import askUserExtension from "../../../src/core/extensions/builtin/ask-user/index.ts";
import type { QuestionRequest, QuestionResponse } from "../../../src/core/extensions/types.ts";
import { userMessageText, userTextContent } from "../../../src/core/user-text-blocks.ts";
import { buildRpcSessionState } from "../../../src/modes/rpc/connection-handler.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

type QueueUpdate = Extract<AgentSessionEvent, { type: "queue_update" }>;

function queueView(harness: Harness) {
	const rpc = buildRpcSessionState(harness.session);
	return {
		steering: [...harness.session.getSteeringMessages()],
		pending: harness.session.pendingMessageCount,
		queuedInputs: harness.session.getQueuedInputs().length,
		rpc: {
			steering: rpc.steering,
			followUp: rpc.followUp,
			ordered: rpc.ordered.length,
			pending: rpc.pendingMessageCount,
		},
	};
}

const EMPTY = {
	steering: [],
	pending: 0,
	queuedInputs: 0,
	rpc: { steering: [], followUp: [], ordered: 0, pending: 0 },
};

const answers: Array<{ name: string; words: string; respond: (request: QuestionRequest) => QuestionResponse }> = [
	{
		name: "a comment",
		words: "call it gamma",
		respond: (request) => ({
			status: "comment-submitted",
			answers: {},
			unanswered: request.questions.map((question) => question.id),
			comment: "call it gamma",
		}),
	},
	{
		name: "typed words",
		words: "delta, typed by hand",
		respond: (request) => ({
			status: "answered",
			answers: Object.fromEntries(
				request.questions.map((question) => [question.id, { selected: [], text: "delta, typed by hand" }]),
			),
			unanswered: [],
		}),
	},
];

describe("senpi#3768 an async ask-user answer with the user's words leaves the steer queue once delivered", () => {
	it("the queue key reads back the text every queued content was built from", () => {
		const blocks = ["[Answer to question q-1]\nsee below", "[The user's comment for question q-1]", "ship it"];
		const text = blocks.join("\n");
		expect(userMessageText(userTextContent(text, blocks))).toBe(text);
		expect(userMessageText(userTextContent(`${text}!`, blocks))).toBe(`${text}!`);
		expect(userMessageText(text)).toBe(text);
	});

	it.each(answers)("answered with $name", async ({ words, respond }) => {
		const asked = Promise.withResolvers<QuestionRequest>();
		const answer = Promise.withResolvers<QuestionResponse>();
		const release = Promise.withResolvers<void>();
		const waitStarted = Promise.withResolvers<void>();
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				waitStarted.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [askUserExtension],
			settings: { askUser: { enabled: true, timeoutMinutes: 30 } },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				question: (request) => {
					asked.resolve(request);
					return answer.promise;
				},
			}),
			mode: "tui",
		});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("ask_user_question", {
					questions: [
						{
							header: "Name",
							question: "Which name?",
							options: [{ label: "alpha" }, { label: "beta" }],
							multiSelect: false,
						},
					],
					waitForAnswer: false,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("after the answer"),
			fauxAssistantMessage("spare"),
		]);
		const answerSteered = Promise.withResolvers<void>();
		const updates: QueueUpdate[] = [];
		const delivered: unknown[] = [];
		const atDelivery: Array<ReturnType<typeof queueView>> = [];
		harness.session.subscribe((event) => {
			if (event.type === "queue_update") {
				updates.push(event);
				if (event.steering.length > 0) answerSteered.resolve();
			}
			if (event.type !== "message_end" || event.message.role !== "user") return;
			const content = event.message.content;
			const first = Array.isArray(content) ? content[0] : undefined;
			if (first?.type === "text" && first.text.startsWith("[Answer to question ")) {
				delivered.push(content);
				atDelivery.push(queueView(harness));
			}
		});

		const run = harness.session.prompt("start");
		const request = await asked.promise;
		await waitStarted.promise;
		answer.resolve(respond(request));
		await answerSteered.promise;
		const queued = queueView(harness);
		expect(queued.steering).toHaveLength(1);
		expect(queued.steering[0]).toContain(`[Answer to question ${request.requestId}]`);
		expect(queued.pending).toBe(1);
		expect(queued.rpc.steering).toEqual(queued.steering);
		release.resolve();
		await run;
		await harness.session.waitForSettledSessionWork();

		expect(delivered).toHaveLength(1);
		expect(Array.isArray(delivered[0]) && (delivered[0] as unknown[]).length).toBeGreaterThan(1);
		expect(JSON.stringify(delivered[0])).toContain(words);
		expect(atDelivery).toEqual([EMPTY]);
		expect(queueView(harness)).toEqual(EMPTY);
		const last = updates.at(-1);
		expect(last?.steering).toEqual([]);
		expect(last?.followUp).toEqual([]);
		expect(last?.ordered).toEqual([]);
	});
});
