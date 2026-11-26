import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { AskUserQuestionComponent } from "../../../src/modes/interactive/components/ask-user-question.ts";
import { ExtensionSelectorComponent } from "../../../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import type { Harness } from "../harness.ts";
import { createFakeInteractiveMode } from "../helpers/ask-user-async-fake-mode.ts";
import { createBoundLifecycleHarness, runToAgentIdle } from "../lifecycle-test-harness.ts";

// senpi#3864: real TUI reply callbacks feed the same session admission authority.
const harnesses: Harness[] = [];
beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	vi.useRealTimers();
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

async function pendingWork() {
	const h = await createBoundLifecycleHarness();
	harnesses.push(h);
	expect(h.session.lifecycle).toBeDefined();
	const child = h.session.workObligations.open("task:review", "children");
	h.setResponses([fauxAssistantMessage("Waiting for review.")]);
	await runToAgentIdle(h, () => h.session.prompt("Review the change."));
	expect(h.session.requestSelfSettle().recorded).toBe(true);
	const fake = createFakeInteractiveMode();
	fake.session.admitHumanAnswer.mockImplementation(() => h.session.admitHumanAnswer());
	return { h, child, fake };
}

it("invalidates a standing request when a local approval resumes the current work", async () => {
	// Given an epoch with a self-settle request and an open TUI approval.
	const { h, child, fake } = await pendingWork();
	const revision = h.session.lifecycle.humanInputRevision;
	const answer = fake.createExtensionUIContext().confirm("Review", "Approve this result?");
	const selector = fake.ui.getFocusedComponent();
	if (!(selector instanceof ExtensionSelectorComponent)) throw new Error("Expected a real extension selector");

	// When a real selection callback accepts the user's choice.
	selector.handleInput("\r");
	expect(await answer).toBe(true);
	child.close("cancelled");

	// Then the reply is counted once and the earlier intent cannot settle.
	expect(h.session.lifecycle.humanInputRevision).toBe(revision + 1);
	expect(h.session.lifecycle.settleDecision).toBeUndefined();
});

it("admits a local blocking question answer before its promise resumes", async () => {
	// Given a blocking question in the real overlay implementation.
	const { h, child, fake } = await pendingWork();
	const revision = h.session.lifecycle.humanInputRevision;
	const question = fake.createExtensionUIContext().question;
	if (!question) throw new Error("Expected the question UI");
	const answer = question({
		requestId: "review",
		waitForAnswer: true,
		timeoutMs: 60_000,
		questions: [
			{ id: "review", header: "Review", question: "Approve?", options: [{ label: "Approve" }], multiSelect: false },
		],
	});
	const overlay = fake.ui.getFocusedComponent();
	if (!(overlay instanceof AskUserQuestionComponent)) throw new Error("Expected the real question overlay");

	// When the user submits the selection through the component.
	overlay.clickOption(0, true);
	expect(await answer).toMatchObject({ status: "answered", resolvedBy: "local_ui" });
	child.close("cancelled");

	// Then the current epoch records the answer without starting another turn.
	expect(h.session.lifecycle.humanInputRevision).toBe(revision + 1);
	expect(h.events.filter((event) => event.type === "agent_start")).toHaveLength(1);
	expect(h.session.lifecycle.settleDecision).toBeUndefined();
});

it("leaves a resumed question's answer to its user-message delivery", async () => {
	// Given a resumed blocking question, whose answer is delivered as a user message (senpi#3864 review, #3964).
	const { h, child, fake } = await pendingWork();
	const revision = h.session.lifecycle.humanInputRevision;
	const question = fake.createExtensionUIContext().question;
	if (!question) throw new Error("Expected the question UI");
	const answer = question(
		{
			requestId: "review",
			waitForAnswer: true,
			timeoutMs: 60_000,
			questions: [
				{
					id: "review",
					header: "Review",
					question: "Approve?",
					options: [{ label: "Approve" }],
					multiSelect: false,
				},
			],
		},
		{ deliver: "user-message" },
	);
	const overlay = fake.ui.getFocusedComponent();
	if (!(overlay instanceof AskUserQuestionComponent)) throw new Error("Expected the real question overlay");

	// When the user answers in the overlay.
	overlay.clickOption(0, true);
	expect(await answer).toMatchObject({ status: "answered", resolvedBy: "local_ui" });
	child.close("cancelled");

	// Then the overlay does not report it, so the delivery counts it exactly once.
	expect(fake.session.admitHumanAnswer).not.toHaveBeenCalled();
	expect(h.session.lifecycle.humanInputRevision).toBe(revision);
});

it("does not classify an automatic dialog timeout as a human answer", async () => {
	// Given the same approval with a short configured timeout.
	const { h, child, fake } = await pendingWork();
	const revision = h.session.lifecycle.humanInputRevision;
	vi.useFakeTimers();
	const answer = fake.createExtensionUIContext().confirm("Review", "Approve?", { timeout: 10 });

	// When only the dialog's timer expires.
	await vi.advanceTimersToNextTimerAsync();
	expect(await answer).toBe(false);
	child.close("cancelled");

	// Then automatic closure preserves the standing agent intent.
	expect(h.session.lifecycle.humanInputRevision).toBe(revision);
	expect(h.session.lifecycle.settleDecision).toMatchObject({ decisionId: expect.any(String) });
});
