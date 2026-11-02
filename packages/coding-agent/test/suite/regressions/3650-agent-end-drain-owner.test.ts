// senpi#3650 review (H1) and senpi#3351: input queued while agent_end handlers run must reach the model exactly once
// and the session must settle, however many microtask hops the handlers before it take. Two owners can drain it (the
// agent core after agent_end, or the session's own continuation); neither may wait on the other.
import { setTimeout as setRealTimeout } from "node:timers";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

function settledWithin<T>(work: Promise<T>, ms = 10_000): Promise<"settled" | "stuck"> {
	return Promise.race([
		work.then(() => "settled" as const),
		new Promise<"stuck">((resolve) => setRealTimeout(() => resolve("stuck"), ms)),
	]);
}

function asyncNoopAgentEndHandlers(count: number) {
	return (pi: ExtensionAPI): void => {
		for (let index = 0; index < count; index += 1) pi.on("agent_end", async () => {});
	};
}

describe("senpi#3650 / senpi#3351 the agent_end drain owner does not depend on microtask timing", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it.each([0, 1, 2, 5])(
		"delivers a follow-up queued by an agent_end handler after %i other async agent_end handlers",
		async (before) => {
			// given async agent_end handlers ahead of one that queues a follow-up on the first turn
			let sent = false;
			const harness = await createHarness({
				extensionFactories: [
					asyncNoopAgentEndHandlers(before),
					(pi: ExtensionAPI) => {
						pi.on("agent_end", async () => {
							if (sent) return;
							sent = true;
							pi.sendUserMessage("conflict report", { deliverAs: "followUp" });
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("reply"), fauxAssistantMessage("follow-up reply")]);

			// when the first turn ends
			const outcome = await settledWithin(harness.session.prompt("hello").then(() => harness.session.waitForIdle()));

			// then the follow-up ran exactly once and the session settled
			expect(outcome).toBe("settled");
			expect(getUserTexts(harness)).toEqual(["hello", "conflict report"]);
			expect(harness.session.isStreaming).toBe(false);
		},
		30_000,
	);

	it.each(["sync", "microtask"] as const)(
		"delivers a steer queued from an agent_end session subscriber (%s) and settles",
		async (timing) => {
			// given a session subscriber that steers once from inside agent_end (the senpi#3351 repro)
			const harness = await createHarness({ settings: { retry: { enabled: false } } });
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("ok 1"), fauxAssistantMessage("ok 2")]);
			let sent = false;
			harness.session.subscribe((event) => {
				if (event.type !== "agent_end" || sent) return;
				sent = true;
				const steer = (): void => void harness.session.prompt("late steer", { streamingBehavior: "steer" });
				if (timing === "sync") steer();
				else queueMicrotask(steer);
			});

			// when the first turn ends
			const outcome = await settledWithin(harness.session.prompt("first").then(() => harness.session.waitForIdle()));

			// then the steer reached the model once and the session settled
			expect(outcome).toBe("settled");
			expect(getUserTexts(harness)).toEqual(["first", "late steer"]);
			expect(harness.session.isStreaming).toBe(false);
		},
		30_000,
	);
});
