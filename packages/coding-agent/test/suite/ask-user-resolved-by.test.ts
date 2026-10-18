import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, expect, it } from "vitest";
import { getPendingQuestions } from "../../src/core/extensions/builtin/ask-user/registry.ts";
import type { QuestionRequest, QuestionResponse } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { AskUserQuestionComponent } from "../../src/modes/interactive/components/ask-user-question.ts";
import type { TuiControlSurface } from "../../src/modes/interactive/session-control-commands.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { ConnectionQuestionBridge } from "../../src/modes/rpc/connection-question-bridge.ts";
import { controlRequest } from "../helpers/session-control-client.ts";
import { type EndpointFixture, startEndpoint } from "../helpers/session-control-fixture.ts";
import { closureFixture, executeQuestion } from "./ask-user-closure-support.ts";
import { createFakeInteractiveMode } from "./helpers/ask-user-async-fake-mode.ts";

const fixtures: Awaited<ReturnType<typeof closureFixture>>[] = [];
const endpoints: EndpointFixture[] = [];
beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(async () => {
	for (const endpoint of endpoints.splice(0)) await endpoint.endpoint.dispose();
	for (const fixture of fixtures.splice(0)) {
		for (const entry of getPendingQuestions(fixture.delivery.harness.sessionManager.getSessionId())) entry.cancel();
		fixture.delivery.harness.cleanup();
	}
});

it.each([true, false])("attributes a TUI widget answer, wait=%s", async (wait) => {
	const fixture = await closureFixture();
	fixtures.push(fixture);
	let widget: AskUserQuestionComponent | undefined;
	const ctx = fixture.delivery.context(
		(request) =>
			new Promise((resolve) => {
				widget = new AskUserQuestionComponent(request, resolve, { timeoutMs: 0 });
			}),
	);
	const execution = executeQuestion(fixture, ctx, "widget", wait);
	const completion = fixture.delivery.settled(ctx, "widget");
	if (!widget) throw new Error("missing question widget");
	widget.clickOption(0, true);
	const response = await completion;
	const result = await execution;
	expect(response).toMatchObject({ status: "answered", resolvedBy: "local_ui", answers: { q1: { selected: ["A"] } } });
	if (wait) expect(result.details).toMatchObject({ resolvedBy: "local_ui" });
	expect(fixture.closed).toEqual([{ requestId: "widget", status: "answered", resolvedBy: "local_ui" }]);
	expect(fixture.settled).toHaveLength(1);
	expect(fixture.settled[0]).toMatchObject({ response: { resolvedBy: "local_ui" } });
	expect(fixture.delivery.deliveries).toHaveLength(wait ? 0 : 1);
});

it.each([true, false])("attributes an RPC connection comment and broadcasts its surface, wait=%s", async (wait) => {
	const fixture = await closureFixture();
	fixtures.push(fixture);
	const frames: object[] = [];
	const bridge = new ConnectionQuestionBridge((frame) => frames.push(frame));
	const ctx = fixture.delivery.context((request, options) => bridge.ask(request, options));
	const execution = executeQuestion(fixture, ctx, "rpc", wait);
	const completion = fixture.delivery.settled(ctx, "rpc");
	const id = bridge.pendingQuestions()[0]?.id;
	if (!id) throw new Error("missing RPC question");
	expect(bridge.respond({ type: "extension_ui_response", id, answers: {}, comment: "ship it" })).toBe(true);
	expect(await completion).toMatchObject({
		status: "comment-submitted",
		resolvedBy: "rpc_connection",
		comment: "ship it",
	});
	const result = await execution;
	if (wait) expect(result.details).toMatchObject({ resolvedBy: "rpc_connection" });
	expect(frames.at(-1)).toMatchObject({ type: "question_resolved", resolvedBy: "rpc_connection" });
	expect(fixture.closed).toEqual([{ requestId: "rpc", status: "comment-submitted", resolvedBy: "rpc_connection" }]);
	expect(fixture.settled).toHaveLength(1);
	expect(fixture.settled[0]).toMatchObject({ response: { resolvedBy: "rpc_connection" } });
});

async function terminalQuestion(fixture: Awaited<ReturnType<typeof closureFixture>>) {
	const fake = createFakeInteractiveMode();
	const question = fake.createExtensionUIContext().question;
	if (!question) throw new Error("missing TUI bridge");
	const pending: Map<string, { request: QuestionRequest; finish(response: QuestionResponse): void }> = Reflect.get(
		fake,
		"pendingQuestions",
	);
	const surface: Pick<TuiControlSurface, "pendingQuestionIds" | "pendingQuestion" | "answerQuestion"> = {
		pendingQuestionIds: () => [...pending.keys()],
		pendingQuestion: (id) => pending.get(id)?.request,
		answerQuestion: (id, response) => {
			const entry = pending.get(id);
			entry?.finish(response);
			return entry !== undefined;
		},
	};
	const endpoint = await startEndpoint({ harness: fixture.delivery.harness, questions: surface });
	endpoints.push(endpoint);
	return { fake, endpoint, ctx: fixture.delivery.context(question) };
}

it.each([true, false])("attributes a control endpoint answer, wait=%s", async (wait) => {
	const fixture = await closureFixture();
	fixtures.push(fixture);
	const { endpoint, ctx } = await terminalQuestion(fixture);
	let socket = endpoint.socket;
	// The control endpoint answers pending async TUI questions. Blocking metadata
	// formatting is exercised by the same tool with a deferred endpoint response.
	const pending = Promise.withResolvers<QuestionResponse>();
	const answeringCtx = wait ? fixture.delivery.context(() => pending.promise) : ctx;
	if (wait) {
		const original = endpoint.endpoint;
		await original.dispose();
		endpoints.pop();
		const request = {
			questions: [{ id: "q1", header: "Library", question: "Which library?", options: [], multiSelect: false }],
		};
		const blockingEndpoint = await startEndpoint({
			harness: fixture.delivery.harness,
			questions: {
				pendingQuestionIds: () => ["endpoint"],
				pendingQuestion: () => request,
				answerQuestion: (_id, response) => {
					pending.resolve(response);
					return true;
				},
			},
		});
		endpoints.push(blockingEndpoint);
		socket = blockingEndpoint.socket;
	}
	const execution = executeQuestion(fixture, answeringCtx, "endpoint", wait);
	const completion = fixture.delivery.settled(answeringCtx, "endpoint");
	const reply = await controlRequest(socket, {
		type: "extension_ui_response",
		id: "answer",
		uiRequestId: "endpoint",
		answers: { q1: { selected: ["B"] } },
	});
	expect(reply).toMatchObject({ kind: "answered", record: { success: true } });
	expect(await completion).toMatchObject({ status: "answered", resolvedBy: "control_endpoint" });
	const result = await execution;
	if (wait) expect(result.details).toMatchObject({ resolvedBy: "control_endpoint" });
	expect(fixture.closed).toEqual([{ requestId: "endpoint", status: "answered", resolvedBy: "control_endpoint" }]);
	expect(fixture.settled).toHaveLength(1);
	expect(fixture.settled[0]).toMatchObject({ response: { resolvedBy: "control_endpoint" } });
});

it.each(["local_ui", "control_endpoint"] as const)(
	"keeps the first %s answer when surfaces race and closes once",
	async (winner) => {
		const fixture = await closureFixture();
		fixtures.push(fixture);
		const { fake, endpoint, ctx } = await terminalQuestion(fixture);
		await executeQuestion(fixture, ctx, "race", false);
		const entry = getPendingQuestions(ctx.sessionManager.getSessionId())[0];
		if (!entry) throw new Error("missing pending race question");
		fake.pressEditorKey("\x1ba");
		const widget = fake.editorContainer.children.find((child) => child instanceof AskUserQuestionComponent);
		if (!widget) throw new Error("missing expanded question");
		if (winner === "local_ui") widget.clickOption(0, true);
		const reply = await controlRequest(endpoint.socket, {
			type: "extension_ui_response",
			id: "remote",
			uiRequestId: "race",
			answers: { q1: { selected: ["B"] } },
		});
		if (winner === "control_endpoint") widget.clickOption(0, true);
		expect(reply).toMatchObject({ kind: "answered", record: { success: winner === "control_endpoint" } });
		expect(await entry.completion).toMatchObject({
			resolvedBy: winner,
			answers: { q1: { selected: [winner === "local_ui" ? "A" : "B"] } },
		});
		// Late abort/cancellation must not publish another closure for the winner.
		entry.cancel();
		entry.cancel();
		expect(fixture.closed).toEqual([{ requestId: "race", status: "answered", resolvedBy: winner }]);
		expect(fixture.settled).toHaveLength(1);
		expect(fixture.settled[0]).toMatchObject({ response: { resolvedBy: winner } });
		expect(fixture.delivery.deliveries).toHaveLength(1);
	},
);
