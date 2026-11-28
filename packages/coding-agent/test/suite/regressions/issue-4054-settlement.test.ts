import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("raw listener session settlement (#4054)", () => {
	it("lets sequential end listeners each complete inside their own budget", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
		harness = await createHarness();
		const firstEntered = Promise.withResolvers<void>();
		const secondEntered = Promise.withResolvers<void>();
		const settlementEntered = Promise.withResolvers<void>();
		const firstRelease = Promise.withResolvers<void>();
		const secondRelease = Promise.withResolvers<void>();
		const order: string[] = [];
		const waitForIdle = harness.agent.waitForIdle.bind(harness.agent);
		vi.spyOn(harness.agent, "waitForIdle").mockImplementation(() => {
			settlementEntered.resolve();
			return waitForIdle();
		});
		const unsubscribeFirst = harness.agent.subscribe(async (event) => {
			if (event.type !== "agent_end") return;
			firstEntered.resolve();
			await firstRelease.promise;
			order.push("first");
		});
		const unsubscribeSecond = harness.agent.subscribe(async (event) => {
			if (event.type !== "agent_end") return;
			secondEntered.resolve();
			await secondRelease.promise;
			order.push("second");
		});
		harness.setResponses([fauxAssistantMessage("Clean stop")]);
		const prompt = harness.session.prompt("first");
		try {
			await firstEntered.promise;
			await settlementEntered.promise;
			await vi.advanceTimersByTimeAsync(45_000);
			firstRelease.resolve();
			await secondEntered.promise;
			await vi.advanceTimersByTimeAsync(20_000);
			expect(harness.agent.signal?.aborted).toBe(false);
			expect(order).toEqual(["first"]);
			secondRelease.resolve();
			await prompt;
			expect(order).toEqual(["first", "second"]);
			expect(harness.session.isIdle).toBe(true);
		} finally {
			firstRelease.resolve();
			secondRelease.resolve();
			unsubscribeFirst();
			unsubscribeSecond();
			await prompt;
		}
	});

	it.each(["deadline", "escape"] as const)("settles via %s and accepts the next prompt", async (reason) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const entered = Promise.withResolvers<void>();
		const endObserved = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness = await createHarness();
		const ends: Array<{ failure?: unknown }> = [];
		const unsubscribeSession = harness.session.subscribe((event) => {
			if (event.type !== "agent_end") return;
			ends.push(event);
			endObserved.resolve();
		});
		let held = false;
		const unsubscribe = harness.agent.subscribe((event) => {
			if (event.type !== "agent_end" || held) return;
			held = true;
			entered.resolve();
			return release.promise;
		});
		harness.setResponses([fauxAssistantMessage("Clean stop"), fauxAssistantMessage("Second prompt answered")]);
		const first = harness.session.prompt("first");
		let abort: Promise<void> | undefined;
		try {
			await entered.promise;
			await endObserved.promise;
			if (reason === "escape") abort = harness.session.abort();
			await vi.advanceTimersByTimeAsync(reason === "deadline" ? 61_000 : 10_000);
			expect(harness.session.isStreaming).toBe(false);
			expect(harness.agent.state.isStreaming).toBe(false);
			await first;
			await abort;
			if (reason === "deadline") {
				// The timeout is the session's own failure: no provider diagnosis or provider action is reported.
				const failure = harness.session.messages.findLast((message) => message.role === "assistant");
				expect(failure).toMatchObject({ stopReason: "error", failureSource: "local" });
				expect(ends.at(-1)?.failure).toBeUndefined();
			}
			await harness.session.prompt("second");
			expect(getUserTexts(harness)).toContain("second");
			expect(harness.session.isIdle).toBe(true);
		} finally {
			release.resolve();
			unsubscribe();
			unsubscribeSession();
			await first;
			await abort;
		}
	});
});
