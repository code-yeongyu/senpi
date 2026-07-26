import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { EvalNotifier } from "../src/extension/eval-notifier.ts";
import { fakeExtensionContext } from "./eval/fakes.ts";

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
