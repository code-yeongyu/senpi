import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalNotifier } from "../src/extension/eval-notifier.ts";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { FakeKernel, fakeExtensionContext } from "./eval/fakes.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("EvalNotifier", () => {
	it("scopes once-per-cell delivery to one session generation", () => {
		const messages: string[] = [];
		const notifier = new EvalNotifier({
			sendUserMessage: (content) => messages.push(content),
			getContext: () => ({ ...fakeExtensionContext(), mode: "tui", model: fakeModel() }),
			getMode: () => "wake",
		});

		notifier.notify([{ cellId: "reused-cell", content: "first session" }]);
		notifier.notify([{ cellId: "reused-cell", content: "duplicate in first session" }]);
		notifier.reset();
		notifier.notify([{ cellId: "reused-cell", content: "second session" }]);

		expect(messages).toEqual(["first session", "second session"]);
	});

	it("wakes the main agent when a detached cell is killed by the hard limit", async () => {
		vi.useFakeTimers();
		const delivered: Array<{ content: string; deliverAs?: string }> = [];
		const notifier = new EvalNotifier({
			sendUserMessage: (content, options) =>
				delivered.push({ content, ...(options?.deliverAs === undefined ? {} : { deliverAs: options.deliverAs }) }),
			getContext: () => ({ ...fakeExtensionContext(), mode: "tui", model: fakeModel() }),
			getMode: () => "wake",
		});
		const manager = new EvalDetachedCellManager({ hardLimitSeconds: 2, notifier });
		const cell = manager.create("killed-cell", { language: "js", code: "await forever", summary: "runaway" });
		manager.markRunning(cell, new FakeKernel([]), () => ({
			content: [{ type: "text", text: "partial" }],
			details: { language: "js", languages: ["js"], durationMs: 0, toolCalls: [], truncated: false },
		}));
		manager.detach(cell);

		await vi.advanceTimersByTimeAsync(2_000);
		await manager.flushNotifications();

		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.deliverAs).toBe("steer");
		expect(delivered[0]?.content).toContain("killed-cell");
		expect(delivered[0]?.content).toContain("2s hard limit");
	});
});

function fakeModel(): Model<Api> {
	return {
		id: "test",
		name: "test",
		api: "fake-api",
		provider: "fake",
		baseUrl: "https://fake.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000,
		maxTokens: 100,
	};
}
