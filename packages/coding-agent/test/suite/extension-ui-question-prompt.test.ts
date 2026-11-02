import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import type {
	ExtensionFactory,
	ExtensionUIContext,
	UIPromptEndEvent,
	UIPromptStartEvent,
} from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";

const QUESTION_REQUEST = {
	requestId: "req-1",
	questions: [
		{
			id: "q1",
			header: "Auth method",
			question: "Which auth should we use?",
			options: [{ label: "OAuth" }, { label: "API key" }],
			multiSelect: false,
		},
	],
	waitForAnswer: true,
	timeoutMs: 1_800_000,
};

const QUESTION_RESPONSE = {
	status: "answered" as const,
	answers: { q1: { selected: ["OAuth"] } },
	unanswered: [] as string[],
};

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

async function createRunner(factory: ExtensionFactory): Promise<ExtensionRunner> {
	const cwd = process.cwd();
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(factory, cwd, createEventBus(), runtime, "question-prompt.ts");
	const sessionManager = SessionManager.inMemory();
	const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	return new ExtensionRunner([extension], runtime, cwd, sessionManager, modelRegistry);
}

describe("ExtensionUIContext.question prompt wrapping", () => {
	it("emits ui_prompt_start{kind:question} then ui_prompt_end around the call", async () => {
		const events: Array<UIPromptStartEvent | UIPromptEndEvent> = [];
		const runner = await createRunner((pi) => {
			pi.on("ui_prompt_start", (event) => {
				events.push(event);
			});
			pi.on("ui_prompt_end", (event) => {
				events.push(event);
			});
		});

		let resolveAnswer: (value: typeof QUESTION_RESPONSE) => void = () => {};
		const answer = new Promise<typeof QUESTION_RESPONSE>((resolve) => {
			resolveAnswer = resolve;
		});
		let invoked = false;
		const ui = {} as ExtensionUIContext;
		ui.question = async () => {
			invoked = true;
			return answer;
		};

		runner.setUIContext(ui, "tui");
		const question = runner.createContext().ui.question;
		expect(typeof question).toBe("function");
		if (typeof question !== "function") {
			throw new Error("expected ctx.ui.question to be a function");
		}

		const resultPromise = question(QUESTION_REQUEST);
		await flushMicrotasks();
		expect(invoked).toBe(true);
		expect(events).toEqual([
			{
				type: "ui_prompt_start",
				reason: "ui_prompt",
				kind: "question",
				title: "Auth method",
			},
		]);

		resolveAnswer(QUESTION_RESPONSE);
		await expect(resultPromise).resolves.toEqual(QUESTION_RESPONSE);
		await flushMicrotasks();
		expect(events).toEqual([
			{
				type: "ui_prompt_start",
				reason: "ui_prompt",
				kind: "question",
				title: "Auth method",
			},
			{
				type: "ui_prompt_end",
				reason: "ui_prompt",
				kind: "question",
				title: "Auth method",
			},
		]);
	});

	it("leaves ctx.ui.question undefined when the underlying ui has no question method", async () => {
		const runner = await createRunner(() => {});
		expect(() => runner.setUIContext({} as ExtensionUIContext, "tui")).not.toThrow();
		expect(runner.createContext().ui.question).toBeUndefined();
	});
});
