import { afterEach, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { MANUAL_CONTINUE_CUSTOM_TYPE } from "../../../src/core/manual-continue.ts";
import { releaseQuestionInput } from "../../../src/core/question-input.ts";
import { getUserTexts, type Harness } from "../harness.ts";
import { heldHarness, wake } from "./3853-review-support.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

const goalContinuations = (h: Harness) =>
	h.session.messages.filter((message) => message.role === "custom" && message.customType === "goal-continuation");

function goalReleasingExtension(released: string[], onInput?: (pi: ExtensionAPI) => void) {
	return (pi: ExtensionAPI) => {
		onInput?.(pi);
		pi.on("session_start", (_event, ctx) => ctx.noteHeldWake?.("goal"));
		pi.on("held_wakes_released", (event) => {
			released.push(...Object.keys(event.sources));
			if (event.sources.goal)
				pi.sendMessage(
					{ customType: "goal-continuation", content: "fresh continuation", display: false },
					{ triggerTurn: true },
				);
		});
	};
}

// senpi#3853 review r2 H-A: human input admitted into a turn that was already streaming (not a release
// turn) must still finish the release once that run settles, so the goal continues afterwards.
it.each(["steer", "followUp"] as const)(
	"finishes the input release after a %s lands in an already streaming turn",
	async (kind) => {
		const released: string[] = [];
		const { h, entered, release } = await heldHarness({ extensionFactories: [goalReleasingExtension(released)] });
		harnesses.push(h);
		await h.session.sendCustomMessage(wake, { triggerTurn: true });
		const goalSettled = Promise.withResolvers<void>();
		let goalStarted = false;
		h.session.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "custom" &&
				event.message.customType === "goal-continuation"
			)
				goalStarted = true;
			if (goalStarted && event.type === "agent_idle") goalSettled.resolve();
		});
		const running = h.session.sendCustomMessage(
			{ customType: MANUAL_CONTINUE_CUSTOM_TYPE, content: "continue", display: false },
			{ triggerTurn: true },
		);
		await entered.promise;
		await h.session[kind]("human input");
		release.resolve();
		await running;
		await goalSettled.promise;
		expect(released).toContain("goal");
		expect(goalContinuations(h)).toHaveLength(1);
		expect(h.session.paused).toBe(false);
		expect(h.session.pausedNoticeCount).toBe(0);
	},
);

async function expectResumeDelivers(h: Harness, released: readonly string[]): Promise<void> {
	const before = h.faux.state.callCount;
	await h.session.resumeSession();
	await h.session.waitForIdle();
	expect(h.faux.state.callCount - before).toBeGreaterThan(0);
	expect(released).toContain("goal");
	expect(h.session.paused).toBe(false);
}

async function heldWithInput(onInput?: (pi: ExtensionAPI) => void) {
	const released: string[] = [];
	const held = await heldHarness({ extensionFactories: [goalReleasingExtension(released, onInput)] });
	harnesses.push(held.h);
	held.release.resolve();
	return { ...held, released };
}

// senpi#3853 review r2 M-A: an input that opened a release and ends with no disposition (thrown or cancelled)
// gives it back, so custody stays with the hold (still paused, nothing released) and an explicit Resume delivers.
it("gives a goal-only release back when the input is refused before acceptance", async () => {
	const { h, released } = await heldWithInput();
	await expect(h.session.prompt("refused", { signal: AbortSignal.abort() })).rejects.toThrow(
		"Prompt cancelled before acceptance",
	);
	expect(h.session.paused).toBe(true);
	expect(released).toEqual([]);
	await expectResumeDelivers(h, released);
});

it("gives the release back when the input is refused before acceptance", async () => {
	const { h, released } = await heldWithInput();
	await h.session.sendCustomMessage(wake, { triggerTurn: true });
	await expect(h.session.prompt("refused", { signal: AbortSignal.abort() })).rejects.toThrow(
		"Prompt cancelled before acceptance",
	);
	expect(h.faux.state.callCount).toBe(0);
	expect(h.session.paused).toBe(true);
	expect(released).toEqual([]);
	await expectResumeDelivers(h, released);
});

it("gives the release back when the input is aborted before admission", async () => {
	const controller = new AbortController();
	const { h, released } = await heldWithInput((pi) =>
		pi.on("input", () => {
			controller.abort();
			return { action: "continue" };
		}),
	);
	await h.session.sendCustomMessage(wake, { triggerTurn: true });
	await expect(h.session.prompt("aborted", { signal: controller.signal })).rejects.toThrow(
		"Prompt cancelled before acceptance",
	);
	expect(h.faux.state.callCount).toBe(0);
	expect(h.session.paused).toBe(true);
	expect(released).toEqual([]);
	await expectResumeDelivers(h, released);
});

// senpi#3853 review r3: a person's input that ends "handled" with no follow-on (a no-op command, an input
// hook that consumes it) or an answer delivered without a follow-on must settle too: the release is given
// back, so the session stays paused and Resume delivers. Reviewer repro: goal + one held codemode wake.
it.each([
	[
		"a no-op command",
		"/noop",
		(pi: ExtensionAPI) => pi.registerCommand("noop", { description: "No-op", handler: async () => {} }),
	],
	[
		"an input hook that handles it",
		"handled elsewhere",
		(pi: ExtensionAPI) => pi.on("input", () => ({ action: "handled" })),
	],
] as const)("gives the release back when %s ends the input with no follow-on", async (_name, text, install) => {
	const { h, released } = await heldWithInput(install);
	await h.session.sendCustomMessage(wake, { triggerTurn: true });
	await h.session.prompt(text);
	expect(h.faux.state.callCount).toBe(0);
	expect(h.session.paused).toBe(true);
	expect(released).toEqual([]);
	await expectResumeDelivers(h, released);
});

it("gives a goal-only release back when a no-op command ends the input", async () => {
	const { h, released } = await heldWithInput((pi) =>
		pi.registerCommand("noop", { description: "No-op", handler: async () => {} }),
	);
	await h.session.prompt("/noop");
	expect(h.session.paused).toBe(true);
	expect(released).toEqual([]);
	await expectResumeDelivers(h, released);
});

it("gives the release back when an answer arrives with no follow-on", async () => {
	const { h, released } = await heldWithInput();
	await h.session.sendCustomMessage(wake, { triggerTurn: true });
	releaseQuestionInput(h.session.extensionRunner.createContext());
	await new Promise<void>((resolve) => queueMicrotask(resolve));
	expect(h.faux.state.callCount).toBe(0);
	expect(h.session.paused).toBe(true);
	expect(released).toEqual([]);
	await expectResumeDelivers(h, released);
});

// senpi#3853 review r4: an answer delivered while agent_settled handlers run is deferred past that window.
// Its origin is captured at delivery, so it still starts a person's turn instead of a held engine wake.
it("starts a turn for an answer delivered while agent_settled handlers run", async () => {
	let answered = false;
	const { h, released } = await heldWithInput((pi) =>
		pi.on("agent_settled", async (_event, ctx) => {
			if (answered) return;
			answered = true;
			releaseQuestionInput(ctx);
			pi.sendUserMessage("my answer", { deliverAs: "followUp" });
			await Promise.resolve();
		}),
	);
	await h.session.sendCustomMessage(wake, { triggerTurn: true });
	const answerSettled = Promise.withResolvers<void>();
	let answerStarted = false;
	h.session.subscribe((event) => {
		if (event.type === "message_start" && event.message.role === "user") answerStarted = true;
		if (answerStarted && event.type === "agent_idle") answerSettled.resolve();
	});
	await h.session.sendCustomMessage(
		{ customType: MANUAL_CONTINUE_CUSTOM_TYPE, content: "continue", display: false },
		{ triggerTurn: true },
	);
	await answerSettled.promise;
	await h.session.waitForIdle();
	expect(getUserTexts(h)).toContain("my answer");
	expect(released).toContain("goal");
	expect(h.session.paused).toBe(false);
});
