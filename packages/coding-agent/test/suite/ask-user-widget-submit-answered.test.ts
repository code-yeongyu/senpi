import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { QuestionRequest, QuestionResponse } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createFakeInteractiveMode } from "./helpers/ask-user-async-fake-mode.ts";

const request: QuestionRequest = {
	requestId: "all-answered",
	waitForAnswer: false,
	timeoutMs: 0,
	questions: [
		{
			id: "auth",
			header: "Auth",
			question: "Choose authentication",
			multiSelect: false,
			options: [{ label: "OAuth" }, { label: "API key" }],
		},
	],
};

type ClickPendingQuestion = (state: unknown, option: number | "own-answer") => void;
const clickPendingQuestion = Reflect.get(InteractiveMode.prototype, "clickPendingQuestion") as ClickPendingQuestion;

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

describe("pending question widget with nothing unanswered", () => {
	it.each([0, "own-answer"] as const)("submits the draft on a %s click instead of re-answering", async (option) => {
		const fake = createFakeInteractiveMode();
		const abort = new AbortController();
		try {
			// The host reads the draft a restored question carries (registry QuestionDialogOptions).
			const options = { signal: abort.signal, initialDraft: { answers: { auth: { selected: ["API key"] } } } };
			const pending = fake.createExtensionUIContext().question!(request, options);
			const states = Reflect.get(fake, "pendingQuestions") as Map<string, unknown>;

			expect(() => clickPendingQuestion.call(fake, states.get(request.requestId), option)).not.toThrow();

			await expect(pending).resolves.toEqual({
				status: "answered",
				resolvedBy: "local_ui",
				answers: { auth: { selected: ["API key"] } },
				unanswered: [],
			} satisfies QuestionResponse);
		} finally {
			abort.abort();
		}
	});
});
