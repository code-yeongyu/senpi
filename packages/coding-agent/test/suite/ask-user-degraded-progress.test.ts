import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { degradeQuestion } from "../../src/modes/rpc/connection-question-bridge.ts";
import { createAskUserDelivery } from "./helpers/ask-user-delivery.ts";

const QUESTIONS = [
	{ header: "Auth", question: "Which flow?", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
	{ header: "Library", question: "Which library?", options: [{ label: "C" }, { label: "D" }], multiSelect: false },
];

afterEach(() => vi.useRealTimers());

async function fallbackWithFirstAnswered() {
	const delivery = await createAskUserDelivery(1);
	const secondOpen = Promise.withResolvers<void>();
	const select = vi
		.fn()
		.mockResolvedValueOnce("A")
		.mockImplementationOnce((_title: string, _options: string[], opts?: { signal?: AbortSignal }) => {
			secondOpen.resolve();
			return new Promise<undefined>((resolve) =>
				opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true }),
			);
		});
	const ctx = delivery.context((request, opts) => degradeQuestion({ select, input: vi.fn() }, request, opts));
	const run = (signal?: AbortSignal) =>
		delivery.tool.execute(
			"tool-degraded",
			{ questions: QUESTIONS, waitForAnswer: true },
			signal,
			undefined,
			ctx as ExtensionToolContext,
		);
	return { run, secondOpen: secondOpen.promise };
}

const textOf = (result: { content: { type: string; text?: string }[] }) =>
	result.content.map((part) => part.text ?? "").join("");

// sisyphuslabs/omo-desktop-app#4042: the extension settles an idle timeout from its own draft, so the
// fallback must report each answer as progress or the model reads a bare timeout. A turn abort is a
// lifecycle cancel and stays a dismissal even with that draft.
it("keeps the dismissal when the turn is aborted after the fallback's first answer", async () => {
	const fallback = await fallbackWithFirstAnswered();
	const controller = new AbortController();
	const result = fallback.run(controller.signal);
	await fallback.secondOpen;
	controller.abort();
	expect(textOf(await result)).toBe("The user dismissed the question.");
});

it("shows the fallback's answered question when the question times out", async () => {
	const fallback = await fallbackWithFirstAnswered();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const result = fallback.run();
	await fallback.secondOpen;
	await vi.advanceTimersByTimeAsync(60_000);
	const text = textOf(await result);
	expect(text).toContain("Before going idle the user had selected: Auth: A");
	expect(text).toContain("Unanswered: Library");
});
