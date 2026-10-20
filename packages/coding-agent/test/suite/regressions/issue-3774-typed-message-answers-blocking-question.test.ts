/**
 * senpi#3774: while a blocking ask-user question waits, a regular message the user submits is that
 * question's answer. It settles the question at once (no idle timeout), becomes its tool result,
 * is never queued as a steer, and every surface learns it was "answered with your message".
 * Async questions keep their routing: the message is steered and the question stays open.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ImageContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import askUserExtension from "../../../src/core/extensions/builtin/ask-user/index.ts";
import { getPendingQuestions } from "../../../src/core/extensions/builtin/ask-user/registry.ts";
import { ConnectionQuestionBridge } from "../../../src/modes/rpc/connection-question-bridge.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

const CALL_ID = "call-typed";
const TYPED = "use beta, it is lighter";
const IMAGE: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
const QUESTION = {
	header: "Library",
	question: "Which library?",
	options: [{ label: "alpha" }, { label: "beta" }],
	multiSelect: false,
};

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) {
		for (const entry of getPendingQuestions(harness.sessionManager.getSessionId())) entry.cancel();
		harness.cleanup();
	}
});

async function questionWorld(tools: AgentTool[] = []) {
	const frames: object[] = [];
	const asked = Promise.withResolvers<void>();
	const bridge = new ConnectionQuestionBridge((record) => {
		frames.push(record);
		if ("method" in record && record.method === "question") asked.resolve();
	});
	const harness = await createHarness({
		tools,
		extensionFactories: [askUserExtension],
		settings: { askUser: { enabled: true, timeoutMinutes: 30 } },
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({
		uiContext: createTestUiContext({ question: (request, options) => bridge.ask(request, options) }),
		mode: "rpc",
	});
	const askCall = (waitForAnswer: boolean) =>
		fauxAssistantMessage(
			[fauxToolCall("ask_user_question", { questions: [QUESTION], waitForAnswer }, { id: CALL_ID })],
			{
				stopReason: "toolUse",
			},
		);
	return { harness, frames, asked: asked.promise, askCall };
}

function askResult(harness: Harness) {
	const result = harness.session.messages.find(
		(message) => message.role === "toolResult" && message.toolName === "ask_user_question",
	);
	if (result?.role !== "toolResult") throw new Error("no ask-user tool result");
	return result;
}

const submissions = [
	{
		route: "a prompt while streaming (TUI editor, RPC prompt)",
		submit: (harness: Harness, text: string, images?: ImageContent[]) =>
			harness.session.prompt(text, { streamingBehavior: "steer", ...(images ? { images } : {}) }),
	},
	{
		route: "an RPC steer",
		submit: (harness: Harness, text: string, images?: ImageContent[]) => harness.session.steer(text, images),
	},
];

describe("senpi#3774 a typed message answers the blocking question", () => {
	it.each(submissions)("settles it from $route at once, with no steer left", async ({ submit }) => {
		const { harness, frames, asked, askCall } = await questionWorld();
		harness.setResponses([askCall(true), fauxAssistantMessage("going with beta")]);
		const run = harness.session.prompt("pick a library");
		await asked;

		await submit(harness, TYPED);
		expect(getPendingQuestions(harness.sessionManager.getSessionId())).toEqual([]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.pendingMessageCount).toBe(0);

		await run;
		const result = askResult(harness);
		expect(result.details).toMatchObject({
			status: "comment-submitted",
			resolvedBy: "typed_message",
			freeText: TYPED,
			userWords: [{ label: `The user's comment for question ${CALL_ID}`, text: TYPED }],
		});
		expect(result.content).toEqual([
			{
				type: "text",
				text: `The user answered with a message: (see [The user's comment for question ${CALL_ID}] below)`,
			},
		]);
		expect(frames.filter((frame) => "type" in frame && frame.type === "question_resolved")).toEqual([
			expect.objectContaining({ outcome: "comment-submitted", resolvedBy: "typed_message", comment: TYPED }),
		]);
		const typedAsUserTurn = harness.session.messages.filter(
			(message) => message.role === "user" && JSON.stringify(message.content).includes(TYPED),
		);
		expect(typedAsUserTurn).toEqual([]);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant" });
	});

	it("carries the message's images in the tool result", async () => {
		const { harness, asked, askCall } = await questionWorld();
		harness.setResponses([askCall(true), fauxAssistantMessage("got the screenshot")]);
		const run = harness.session.prompt("pick a library");
		await asked;
		await harness.session.prompt("this one", { streamingBehavior: "steer", images: [IMAGE] });
		await run;
		const result = askResult(harness);
		expect(result.content).toEqual([expect.objectContaining({ type: "text" }), IMAGE]);
		expect(result.details).toMatchObject({ resolvedBy: "typed_message", freeText: "this one" });
	});

	it("shows 'answered with your message' on the TUI question card", async () => {
		const { harness, asked, askCall } = await questionWorld();
		harness.setResponses([askCall(true), fauxAssistantMessage("going with beta")]);
		const run = harness.session.prompt("pick a library");
		await asked;
		await harness.session.prompt(TYPED, { streamingBehavior: "steer" });
		await run;
		const result = askResult(harness);
		const tool = harness.session.getToolDefinition("ask_user_question");
		if (!tool?.renderResult) throw new Error("no ask-user renderer");
		const rendered = tool.renderResult(
			{ content: result.content, details: result.details },
			{ expanded: true, isPartial: false },
			{} as never,
			{} as never,
		);
		expect(rendered).toBeInstanceOf(Text);
		const lines = (rendered as Text).render(400).map((line) => line.trimEnd());
		expect(lines).toEqual(["answered with your message", `The user answered with a message: ${TYPED}`]);
	});

	it("leaves an async question open and steers the message as before", async () => {
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
		const { harness, frames, asked, askCall } = await questionWorld([waitTool]);
		harness.setResponses([
			askCall(false),
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("spare"),
		]);
		const run = harness.session.prompt("pick a library");
		await asked;
		await waitStarted.promise;

		await harness.session.prompt(TYPED, { streamingBehavior: "steer" });
		expect(harness.session.getSteeringMessages()).toEqual([TYPED]);
		expect(
			getPendingQuestions(harness.sessionManager.getSessionId()).map((entry) => entry.request.requestId),
		).toEqual([CALL_ID]);

		release.resolve();
		await run;
		expect(frames.filter((frame) => "type" in frame && frame.type === "question_resolved")).toEqual([]);
		expect(
			harness.session.messages.some(
				(message) => message.role === "user" && JSON.stringify(message.content).includes(TYPED),
			),
		).toBe(true);
	});
});
