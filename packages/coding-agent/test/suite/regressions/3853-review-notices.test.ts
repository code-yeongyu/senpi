import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { EngineTurnHold } from "../../../src/core/engine-turn-hold.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

// senpi#3853: the notice's source label identifies the producer, not always the goal.
it.each(["goal", "monitor", "codemode", "other"])("identifies the %s source in its held notice", (source) => {
	const notices: string[] = [];
	const ledger = new EngineTurnHold(
		[],
		true,
		() => {},
		(message) => notices.push(message),
		() => {},
	);
	ledger.start();
	ledger.note(source);
	expect(notices.at(-1)).toContain(source);
});

it("does not notify the human who just released a goal hold", async () => {
	const notices: string[] = [];
	const h = await createHarness({
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
		extensionFactories: [
			(pi) => {
				pi.on("session_start", (_event, ctx) => ctx.noteHeldWake?.("goal"));
				pi.on("agent_end", (_event, ctx) => {
					if (ctx.engineTurnsHeld?.()) ctx.noteHeldWake?.("goal");
				});
			},
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({
		mode: "rpc",
		shutdownHandler: () => {},
		uiContext: createTestUiContext({ notify: (message) => notices.push(message) }),
	});
	notices.length = 0;
	h.setResponses([fauxAssistantMessage([fauxText("done")])]);
	await h.session.prompt("continue");
	expect(notices).toEqual([]);
	expect(h.session.pausedNoticeCount).toBe(0);
});
