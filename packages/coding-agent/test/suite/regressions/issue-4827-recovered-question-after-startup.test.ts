import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import askUserExtension from "../../../src/core/extensions/builtin/ask-user/index.ts";
import { getPendingQuestions } from "../../../src/core/extensions/builtin/ask-user/registry.ts";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type QuestionResponse,
	RUNTIME_EXTENSION_PATH,
} from "../../../src/core/extensions/types.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#4827: a dangling question recovered on resume was published from ask-user's early session_start
// handler while later startup handlers still ran, so a client could answer it in the middle of startup.

const CALL_ID = "call_4827";
const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const ANSWER: QuestionResponse = { status: "answered", answers: { q1: { selected: ["A"] } }, unanswered: [] };

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) {
		for (const entry of getPendingQuestions(harness.session.sessionManager.getSessionId()))
			entry.cancel("session_closed");
		harness.cleanup();
	}
});

function danglingQuestion(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: CALL_ID,
				name: "ask_user_question",
				arguments: {
					questions: [{ header: "Library", question: "Which library?", multiSelect: false }],
					waitForAnswer: true,
				},
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-6",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: 2,
	};
}

async function startWithLaterStartupHandler() {
	const order: string[] = [];
	const delivered: unknown[] = [];
	let hold: { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
	let askUserApi: ExtensionAPI | undefined;
	const recordDelivery: ExtensionAPI["sendUserMessage"] = (content) => {
		delivered.push(content);
	};
	const extensionsResult = await createTestExtensionsResult([
		{
			factory: (pi: ExtensionAPI) => {
				askUserApi = pi;
				pi.sendUserMessage = recordDelivery;
				askUserExtension(pi);
			},
		},
		{
			factory: (pi: ExtensionAPI) => {
				pi.on("session_start", async (_event, ctx) => {
					if (hold) {
						hold.entered.resolve();
						await hold.release.promise;
					}
					ctx.ui.setStatus("later-startup", "ready");
					order.push("later-startup:status");
				});
			},
		},
	]);
	const harness = await createHarness({
		resourceLoader: { ...createTestResourceLoader(), getExtensions: () => extensionsResult },
		settings: { askUser: { enabled: true, timeoutMinutes: 30 } },
	});
	harnesses.push(harness);
	const answer = Promise.withResolvers<QuestionResponse>();
	const runner = harness.getExtensionRunner();
	const base = runner.createContext();
	const question: NonNullable<ExtensionContext["ui"]["question"]> = (request) => {
		order.push(`question:${request.requestId}`);
		return answer.promise;
	};
	await harness.session.bindExtensions({ uiContext: { ...base.ui, question }, mode: "rpc" });
	if (!askUserApi) throw new Error("ask-user factory never ran");
	askUserApi.sendUserMessage = recordDelivery;
	order.length = 0;
	harness.session.sessionManager.appendMessage({ role: "user", content: "pick a library", timestamp: 1 });
	harness.session.sessionManager.appendMessage(danglingQuestion());
	return {
		harness,
		runner,
		order,
		delivered,
		answer,
		holdLaterHandler() {
			hold = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
			return hold;
		},
		pending: () => getPendingQuestions(harness.session.sessionManager.getSessionId()),
	};
}

it("publishes a recovered question only after a suspended later startup handler returns", async () => {
	const started = await startWithLaterStartupHandler();
	const hold = started.holdLaterHandler();

	const resumed = started.runner.emit({ type: "session_start", reason: "resume" });
	try {
		await hold.entered.promise;
		// The later handler is suspended mid-startup: nothing may be answerable yet.
		expect(started.order).toEqual([]);
		expect(started.pending()).toEqual([]);
	} finally {
		hold.release.resolve();
		await resumed;
	}

	expect(started.order).toEqual(["later-startup:status", `question:${CALL_ID}`]);
	const [entry] = started.pending();
	if (!entry) throw new Error("recovered question was not published");
	started.answer.resolve(ANSWER);
	await entry.completion;
	expect(started.delivered).toHaveLength(1);
});

it("drops the deferred publish without an unhandled rejection when the session is replaced mid-startup", async () => {
	const started = await startWithLaterStartupHandler();
	const hold = started.holdLaterHandler();
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	// The later test handler itself touches its retired ctx after release; only the deferred publish is under test.
	const publishErrors: string[] = [];
	started.runner.onError((error) => {
		if (error.extensionPath === RUNTIME_EXTENSION_PATH) publishErrors.push(error.error);
	});
	const sessionId = started.harness.session.sessionManager.getSessionId();
	try {
		const resumed = started.runner.emit({ type: "session_start", reason: "resume" });
		await hold.entered.promise;
		// A switch or new session disposes the old session (and invalidates its runner) while its
		// session_start dispatch is still suspended in a later handler.
		started.harness.session.dispose();
		hold.release.resolve();
		await resumed;
		// One macrotask turn: Node reports unhandled rejections after the microtask queue drains.
		await new Promise<void>((resolve) => setImmediate(resolve));
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}

	expect(unhandled).toEqual([]);
	expect(publishErrors).toEqual([]);
	expect(started.order).not.toContain(`question:${CALL_ID}`);
	expect(getPendingQuestions(sessionId)).toEqual([]);
});

it("keeps the same startup-then-question order when no startup handler suspends", async () => {
	const started = await startWithLaterStartupHandler();

	await started.runner.emit({ type: "session_start", reason: "resume" });
	await started.runner.emit({ type: "session_start", reason: "reload" });

	expect(started.order).toEqual(["later-startup:status", `question:${CALL_ID}`, "later-startup:status"]);
	expect(started.pending()).toHaveLength(1);
});
