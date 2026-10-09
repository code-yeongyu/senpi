import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { PROMPT_STARTED_REASON } from "../../../src/core/prompt-cache-prefix-request.ts";
import { getAssistantTexts } from "../harness.ts";
import { cleanupPrewarmHarnesses, createPrewarmHarness, deferred, within } from "../prompt-cache-prewarm-harness.ts";

// senpi#2115: the prewarm preview pass must never run a handler's real-turn side effects.
describe("prompt-cache prewarm preview runs only preview-safe handlers (#2115)", () => {
	afterEach(cleanupPrewarmHarnesses);

	it("never calls a handler that did not opt in and records the prewarm as skipped", async () => {
		const pendingNotices = ["notice-1"];
		const delivered: string[] = [];
		const memory: ExtensionFactory = (pi) => {
			pi.on("before_agent_start", () => {
				const notice = pendingNotices.shift();
				if (notice !== undefined) delivered.push(notice);
				return undefined;
			});
		};
		let warmCalls = 0;
		const { harness, entryAppended } = await createPrewarmHarness(
			async () => {
				warmCalls += 1;
				return { supported: false };
			},
			{ extensionFactories: [memory] },
		);
		harness.setResponses([fauxAssistantMessage("answer")]);

		await harness.session.bindExtensions({});
		const entry = await within(entryAppended, "the skipped prewarm entry");
		expect(entry.data).toMatchObject({
			phase: "skipped",
			reason: expect.stringContaining("before_agent_start handlers not registered previewSafe"),
		});
		expect(delivered).toEqual([]);
		expect(warmCalls).toBe(0);

		await within(harness.session.prompt("hello"), "the first turn");
		expect(delivered).toEqual(["notice-1"]);
		expect(getAssistantTexts(harness)).toEqual(["answer"]);
	});

	it("cancels a preview still composing when a prompt starts its turn", async () => {
		const previewEntered = deferred<void>();
		const releasePreview = deferred<void>();
		const laterHandlerPreviews: boolean[] = [];
		const slow: ExtensionFactory = (pi) => {
			pi.on(
				"before_agent_start",
				async (event) => {
					if (event.preview === true) {
						previewEntered.resolve();
						await releasePreview.promise;
					}
					return { systemPrompt: `${event.systemPrompt}\n\nslow section` };
				},
				{ previewSafe: true },
			);
		};
		const later: ExtensionFactory = (pi) => {
			pi.on(
				"before_agent_start",
				(event) => {
					laterHandlerPreviews.push(event.preview === true);
					return undefined;
				},
				{ previewSafe: true },
			);
		};
		let warmCalls = 0;
		const { harness, entryAppended } = await createPrewarmHarness(
			async () => {
				warmCalls += 1;
				return { supported: false };
			},
			{ extensionFactories: [slow, later] },
		);
		const runner = harness.session.extensionRunner;
		const emit = runner.emitBeforeAgentStart.bind(runner);
		const previewDispatches: Promise<unknown>[] = [];
		vi.spyOn(runner, "emitBeforeAgentStart").mockImplementation((...args) => {
			const dispatch = emit(...args);
			if (args[4]?.preview === true) previewDispatches.push(dispatch);
			return dispatch;
		});
		harness.setResponses([fauxAssistantMessage("answer")]);

		await harness.session.bindExtensions({});
		await within(previewEntered.promise, "the preview pass");
		await within(harness.session.prompt("hello"), "the first turn");
		const entry = await within(entryAppended, "the skipped prewarm entry");
		expect(entry.data).toMatchObject({ phase: "skipped", reason: PROMPT_STARTED_REASON });
		expect(getAssistantTexts(harness)).toEqual(["answer"]);

		releasePreview.resolve();
		expect(previewDispatches).toHaveLength(1);
		await within(Promise.all(previewDispatches), "the cancelled preview dispatch");
		expect(laterHandlerPreviews).toEqual([false]);
		expect(warmCalls).toBe(0);
	});
});
