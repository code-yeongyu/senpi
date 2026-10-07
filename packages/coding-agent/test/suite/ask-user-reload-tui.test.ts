import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, expect, it } from "vitest";
import { getPendingQuestions } from "../../src/core/extensions/builtin/ask-user/registry.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { ASK_USER_WIDGET_KEY } from "../../src/modes/interactive/components/ask-user-async-widget.ts";
import { AskUserQuestionComponent } from "../../src/modes/interactive/components/ask-user-question.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createFakeInteractiveMode } from "./helpers/ask-user-async-fake-mode.ts";
import { type AskUserDelivery, createAskUserDelivery } from "./helpers/ask-user-delivery.ts";

const deliveries: AskUserDelivery[] = [];
beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	for (const delivery of deliveries.splice(0)) {
		for (const entry of getPendingQuestions(delivery.harness.sessionManager.getSessionId())) entry.cancel();
		delivery.harness.cleanup();
	}
});

// #1857: exercise the actual widget/overlay bridge, not just its options.
it("restores the draft into the reattached TUI component after reload", async () => {
	const delivery = await createAskUserDelivery();
	deliveries.push(delivery);
	const mode = createFakeInteractiveMode();
	const question = mode.createExtensionUIContext().question;
	if (!question) throw new Error("missing TUI bridge");
	const context = delivery.context(question);
	await delivery.harness.session.bindExtensions({
		uiContext: context.ui,
		mode: "tui",
	});
	await delivery.tool.execute(
		"tui-reload",
		{
			questions: [
				{
					header: "Library",
					question: "Which library?",
					multiSelect: false,
					options: [
						{ label: "A", description: "First" },
						{ label: "B", description: "Second" },
					],
				},
			],
			waitForAnswer: false,
		},
		undefined,
		undefined,
		context as ExtensionToolContext,
	);
	mode.pressEditorKey("\x1ba");
	const component = mode.editorContainer.children.find((child) => child instanceof AskUserQuestionComponent);
	if (!component) throw new Error("missing question overlay");
	component.handleInput("1");
	component.handleInput("\x1b");
	const draft = { answers: { q1: { selected: ["A"] } } };
	const completion = delivery.settled(context, "tui-reload");
	await emitSessionShutdownEvent(delivery.harness.getExtensionRunner(), {
		type: "session_shutdown",
		reason: "reload",
	});
	await delivery.harness.getExtensionRunner().emit({ type: "session_start", reason: "reload" });
	expect(mode.widgetText(ASK_USER_WIDGET_KEY)).toBeDefined();
	mode.pressEditorKey("\x1ba");
	const restored = mode.editorContainer.children.find((child) => child instanceof AskUserQuestionComponent);
	if (!restored) throw new Error("missing reattached question overlay");
	expect(stripAnsi(restored.render(80).join("\n"))).toContain("1. A \u2713");
	expect(delivery.deliveries).toEqual([]);
	restored.handleInput("\x1b[13;5u");
	await expect(completion).resolves.toMatchObject({ status: "answered", ...draft });
	expect(delivery.deliveries).toHaveLength(1);
});
