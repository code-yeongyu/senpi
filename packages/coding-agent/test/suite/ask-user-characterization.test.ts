// Refs #1645. Test-only baseline: only rows b2 and e intentionally change in the keyboard-model increment.
import { setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { GOAL_CONTINUATION_SCHEDULED_EVENT } from "../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import type { QuestionRequest, QuestionResponse } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { UserInputBridge } from "../../src/modes/app-server/server/user-input-bridge.ts";
import { ASK_USER_WIDGET_KEY } from "../../src/modes/interactive/components/ask-user-async-widget.ts";
import { AskUserQuestionComponent } from "../../src/modes/interactive/components/ask-user-question.ts";
import { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { ConnectionQuestionBridge } from "../../src/modes/rpc/connection-question-bridge.ts";
import { createFakeInteractiveMode, type FakeInteractiveMode } from "./helpers/ask-user-async-fake-mode.ts";
import { createGoalAskUserWorld, type GoalAskUserWorld, QUESTION_TIMEOUT_MS } from "./helpers/goal-ask-user.ts";

const ENTER = "\r";
const ESC = "\x1b";
const ALT_A = "\x1ba";
const ALT_UP = "\x1b[1;3A";
const SHIFT_TAB = "\x1b[Z";
const TAB = "\t";
const NOW = 1_800_000_000_000;
const controllers: AbortController[] = [];
let world: GoalAskUserWorld | undefined;

function request(requestId = "characterization"): QuestionRequest {
	return {
		requestId,
		questions: [
			{
				id: "auth",
				header: "Auth",
				question: "Which flow?",
				options: [{ label: "OAuth" }, { label: "API key" }],
				multiSelect: false,
			},
		],
		waitForAnswer: false,
		timeoutMs: QUESTION_TIMEOUT_MS,
	};
}

function ask(fake: FakeInteractiveMode, value = request()): Promise<QuestionResponse> {
	const controller = new AbortController();
	controllers.push(controller);
	const pending = fake.createExtensionUIContext().question?.(value, { signal: controller.signal });
	if (!pending) throw new Error("Question UI is unavailable");
	return pending;
}

function component(fake: FakeInteractiveMode): AskUserQuestionComponent | undefined {
	return fake.editorContainer.children.find((child) => child instanceof AskUserQuestionComponent);
}

function withEditor() {
	const fake = createFakeInteractiveMode({ isStreaming: true });
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
	Object.assign(fake, { editor, defaultEditor: editor, keybindings, updateShortcutOverlay: vi.fn() });
	fake.editorContainer.clear();
	fake.editorContainer.addChild(editor);
	fake.ui.setFocus(editor);
	editor.onExtensionShortcut = (data) => fake.handleAskUserShortcut(data);
	fake.setupEditorSubmitHandler();
	return { fake, editor };
}

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(async () => {
	for (const controller of controllers.splice(0)) controller.abort();
	await world?.cleanup();
	world = undefined;
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("ask-user characterization", () => {
	it("a: empty Enter opens the pending component", async () => {
		const fake = createFakeInteractiveMode();
		void ask(fake);
		await fake.submitEditorText("");
		expect(component(fake)).toBeInstanceOf(AskUserQuestionComponent);
		expect(fake.ui.setFocus).toHaveBeenLastCalledWith(component(fake));
	});

	it("b1: text typed after arrival resolves as a comment", async () => {
		const { fake, editor } = withEditor();
		const pending = ask(fake);
		editor.handleInput("hello");
		editor.handleInput(ENTER);
		await expect(pending).resolves.toMatchObject({ status: "comment-submitted", comment: "hello" });
		expect(fake.session.prompt).not.toHaveBeenCalled();
	});

	it("b2: text present before arrival stays an ordinary chat message", async () => {
		const { fake, editor } = withEditor();
		editor.handleInput("existing draft");
		const settled = vi.fn();
		void ask(fake).then(settled);
		editor.handleInput(ENTER);
		await Promise.resolve();
		expect(settled).not.toHaveBeenCalled();
		expect(fake.session.prompt).toHaveBeenCalledWith(
			"existing draft",
			expect.objectContaining({ streamingBehavior: "steer" }),
		);
	});

	it("c: Esc collapses without settling and preserves the draft", async () => {
		const fake = createFakeInteractiveMode();
		const settled = vi.fn();
		const value = request();
		void ask(fake, { ...value, questions: [...value.questions, { ...value.questions[0]!, id: "second" }] }).then(
			settled,
		);
		await fake.submitEditorText("");
		component(fake)?.handleInput("1");
		component(fake)?.handleInput(ESC);
		await Promise.resolve();
		expect(component(fake)).toBeUndefined();
		expect(settled).not.toHaveBeenCalled();
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toBeDefined();
		await fake.submitEditorText("");
		const reopened = component(fake);
		expect(reopened).toBeInstanceOf(AskUserQuestionComponent);
		// A composer comment after collapsing carries the selected answer.
		reopened?.handleInput(ESC);
		await fake.submitEditorText("keep selection");
		await Promise.resolve();
		expect(settled).toHaveBeenCalledWith(expect.objectContaining({ answers: { auth: { selected: ["OAuth"] } } }));
	});

	it("d: wait-mode single-select digit submits immediately", () => {
		const done = vi.fn();
		const question = new AskUserQuestionComponent({ ...request(), waitForAnswer: true }, done);
		question.handleInput("2");
		expect(done).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ status: "answered", answers: { auth: { selected: ["API key"] } } }),
		);
		question.dispose();
	});

	it("e: async single-select digit submits immediately", () => {
		const done = vi.fn();
		const progress = vi.fn();
		const question = new AskUserQuestionComponent(request(), done, { onProgress: progress });
		question.handleInput("2");
		expect(done).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "answered" }));
		expect(progress).toHaveBeenLastCalledWith(
			expect.objectContaining({ answers: { auth: { selected: ["API key"] } } }),
		);
		question.dispose();
	});

	it.each([
		["f1", ALT_A],
		["f2", "å"],
	])("%s: existing answer shortcut opens on darwin", (row, key) => {
		void row;
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		const { fake, editor } = withEditor();
		void ask(fake);
		editor.handleInput(key ?? "");
		expect(component(fake)).toBeInstanceOf(AskUserQuestionComponent);
		expect(editor.getText()).toBe("");
	});

	it("g: RPC resolves only one of two pending requests", async () => {
		const output = vi.fn();
		const bridge = new ConnectionQuestionBridge(output);
		const first = bridge.ask(request("first"));
		const second = bridge.ask(request("second"));
		const frames = bridge.pendingQuestions();
		expect(frames.map((frame) => frame.requestId)).toEqual(["first", "second"]);
		bridge.respond({ type: "extension_ui_response", id: frames[1]!.id, answers: { auth: { selected: ["OAuth"] } } });
		await expect(second).resolves.toMatchObject({ status: "answered" });
		expect(bridge.pendingQuestions().map((frame) => frame.requestId)).toEqual(["first"]);
		expect(output).toHaveBeenLastCalledWith(
			expect.objectContaining({ type: "question_resolved", requestId: "second" }),
		);
		bridge.cancelAll();
		await first;
	});

	it("h: app-server replays both pending requests for the thread", async () => {
		const send = vi.fn(() => 1);
		const bridge = new UserInputBridge(send);
		const pending = [
			bridge.requestUserInput("thread", "turn", "first", request("first")),
			bridge.requestUserInput("thread", "turn", "second", request("second")),
		];
		send.mockClear();
		expect(bridge.replayPendingForThread("thread")).toBe(2);
		expect(send.mock.calls).toHaveLength(2);
		expect(bridge.pendingCount).toBe(2);
		bridge.cancelPendingForThread("thread");
		await Promise.all(pending);
	});

	it("i1: one async question parks on its idle window instead of the backstop", async () => {
		vi.useRealTimers();
		world = await createGoalAskUserWorld("characterization-idle");
		await world.startTurn();
		await world.askAsync("idle");
		await world.endTurn();
		expect(world.eventsOn(GOAL_CONTINUATION_SCHEDULED_EVENT)).toEqual([
			expect.objectContaining({ delayMs: QUESTION_TIMEOUT_MS, wakeSources: { "ask-user": 1 } }),
		]);
	});

	it("i2: a past deadline parks for one more idle window", async () => {
		vi.useRealTimers();
		world = await createGoalAskUserWorld("characterization-past");
		await world.startTurn();
		await world.askAsync("past");
		vi.setSystemTime(Date.now() + QUESTION_TIMEOUT_MS + 1);
		await world.endTurn();
		expect(world.eventsOn(GOAL_CONTINUATION_SCHEDULED_EVENT)).toEqual([
			expect.objectContaining({ delayMs: QUESTION_TIMEOUT_MS }),
		]);
	});

	it("j1: shift+tab still cycles thinking with a pending question", () => {
		const { fake, editor } = withEditor();
		const cycleThinkingLevel = vi.fn(async () => "high");
		Object.assign(fake.session, { cycleThinkingLevel });
		(fake as unknown as { setupKeyHandlers(): void }).setupKeyHandlers();
		void ask(fake);
		editor.handleInput(SHIFT_TAB);
		expect(cycleThinkingLevel).toHaveBeenCalledExactlyOnceWith();
		expect(component(fake)).toBeUndefined();
	});

	it("j2: tab still invokes autocomplete with a pending question", async () => {
		const { fake, editor } = withEditor();
		const called = Promise.withResolvers<void>();
		const getSuggestions = vi.fn(async () => {
			called.resolve();
			return { items: [{ value: "candidate", label: "candidate" }], prefix: "" };
		});
		editor.setAutocompleteProvider({
			getSuggestions,
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		});
		void ask(fake);
		editor.handleInput(TAB);
		await called.promise;
		expect(getSuggestions).toHaveBeenCalledExactlyOnceWith([""], 0, 0, expect.objectContaining({ force: true }));
		expect(component(fake)).toBeUndefined();
	}, 1_000);

	it("k: the collapsed widget owns expiration without an external deadline getter", async () => {
		const fake = createFakeInteractiveMode();
		const pending = ask(fake, { ...request(), timeoutMs: 1_000 });
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(pending).resolves.toMatchObject({ status: "timed_out", unanswered: ["auth"] });
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toBeUndefined();
	});

	it("l: alt+up restores queued messages when no question is pending", () => {
		const { fake, editor } = withEditor();
		const clearAllQueues = vi.fn(() => ({ steering: ["queued draft"], followUp: [] }));
		Object.assign(fake, { clearAllQueues });
		(fake as unknown as { setupKeyHandlers(): void }).setupKeyHandlers();
		editor.handleInput(ALT_UP);
		expect(clearAllQueues).toHaveBeenCalledExactlyOnceWith({ abortWillFollow: false });
		expect(editor.getText()).toBe("queued draft");
	});

	it("m1: the RPC QuestionRequest frame is byte-identical", async () => {
		vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
		const output = vi.fn();
		const bridge = new ConnectionQuestionBridge(output);
		const pending = bridge.ask(request());
		expect(JSON.stringify(output.mock.calls[0]?.[0])).toBe(
			JSON.stringify({
				type: "extension_ui_request",
				method: "question",
				id: "00000000-0000-4000-8000-000000000001",
				requestId: "characterization",
				toolCallId: "characterization",
				waitForAnswer: false,
				questions: request().questions,
				timeout: QUESTION_TIMEOUT_MS,
				askedAtMs: NOW,
				deadlineAtMs: NOW + QUESTION_TIMEOUT_MS,
				remainingMs: QUESTION_TIMEOUT_MS,
			}),
		);
		bridge.cancelAll();
		await pending;
	});

	it("m2: the app-server QuestionRequest frame is byte-identical", async () => {
		const output: object[] = [];
		const bridge = new UserInputBridge((_thread, message) => {
			output.push(message);
			return 1;
		});
		const pending = bridge.requestUserInput("thread", "turn", "item", request());
		expect(JSON.stringify(output[0])).toBe(
			JSON.stringify({
				id: "user-input-0",
				method: "item/tool/requestUserInput",
				params: {
					threadId: "thread",
					turnId: "turn",
					itemId: "item",
					autoResolutionMs: null,
					timeoutMs: QUESTION_TIMEOUT_MS,
					waitForAnswer: false,
					questions: [
						{
							...request().questions[0],
							isOther: true,
							isSecret: false,
							options: [
								{ label: "OAuth", description: "" },
								{ label: "API key", description: "" },
							],
						},
					],
				},
			}),
		);
		bridge.cancelPendingForThread("thread");
		await pending;
	});
});
