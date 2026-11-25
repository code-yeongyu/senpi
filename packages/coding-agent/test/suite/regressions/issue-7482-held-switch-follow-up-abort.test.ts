import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#7482 (omo#15026): after a held model switch applies at the pre-prompt compaction, the turn that compaction
// admitted must still be answered. Applying the switch invalidated compaction and aborted unconditionally, so the
// follow-up ended `aborted` with no text although the provider answered.

function seedLiveContext(harness: Harness, tokens: number, repeats = 30_000): void {
	const timestamp = Date.now();
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "large live context ".repeat(repeats) }],
		timestamp: timestamp - 1,
	});
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "still working" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: tokens - 1_000,
			output: 1_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

const MODELS = [
	{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
	{ id: "372k", contextWindow: 372_000, maxTokens: 32_000 },
];

async function createHeldSwitchHarness(): Promise<Harness> {
	return await createHarness({
		models: MODELS,
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", (event) => ({
					compaction: {
						summary: "compact summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
			},
		],
	});
}

const isSummaryRequest = (context: Parameters<FauxResponseFactory>[0]): boolean =>
	JSON.stringify(context.messages.at(-1)?.content ?? "").includes("[INTERNAL ");

const answering = (text: string): FauxResponseFactory =>
	async (context) => fauxAssistantMessage(isSummaryRequest(context) ? "<summary>Earlier work.</summary>" : text);

function lastAnswer(harness: Harness): { readonly text: string; readonly stopReason: string } {
	const last = harness.session.messages.findLast((message) => message.role === "assistant");
	if (!last || last.role !== "assistant") throw new Error("no assistant message");
	const text = last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
	return { text, stopReason: last.stopReason };
}

describe("#7482 the turn a held switch's compaction admitted is answered", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("answers the follow-up on the target model after the held switch applies", async () => {
		// given a switch the session holds until its next compaction
		const harness = await createHeldSwitchHarness();
		harnesses.push(harness);
		seedLiveContext(harness, 321_000);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing held switch target fixture");
		await harness.session.setModel(target);
		expect(harness.session.pendingModelSwitch?.model.id).toBe("372k");
		harness.setResponses([fauxAssistantMessage("answered on the target model")]);

		// when the next prompt compacts and applies the switch
		await harness.session.prompt("continue");

		// then the switch landed and the prompt got the provider's answer, not an empty aborted turn
		expect(harness.session.model?.id).toBe("372k");
		expect(harness.faux.getCallLog().at(-1)?.modelId).toBe("372k");
		expect(lastAnswer(harness)).toEqual({ text: "answered on the target model", stopReason: "stop" });
	});

	it("answers the follow-up when the built-in compaction extension runs the switch's compaction", async () => {
		// given the engine's own compaction extension (its restoration entries follow the compaction) and a held switch
		const harness = await createHarness({
			models: MODELS,
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			extensionFactories: [compactionExtension],
		});
		harnesses.push(harness);
		seedLiveContext(harness, 321_000);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing held switch target fixture");
		await harness.session.setModel(target);
		expect(harness.session.pendingModelSwitch?.model.id).toBe("372k");
		harness.setResponses(Array.from({ length: 6 }, () => answering("answered on the target model")));

		// when the next prompt compacts and applies the switch
		await harness.session.prompt("continue");

		// then the switch landed and the prompt got the provider's answer
		expect(harness.session.model?.id).toBe("372k");
		expect(lastAnswer(harness)).toEqual({ text: "answered on the target model", stopReason: "stop" });
	});

	it("answers the follow-up after an earlier turn was interrupted and then a held switch applies", async () => {
		// given a turn the user interrupted mid-stream, then a switch the session holds
		const harness = await createHeldSwitchHarness();
		harnesses.push(harness);
		let markStarted = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		harness.setResponses([
			async (_context, options) => {
				markStarted();
				await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()));
				return fauxAssistantMessage("never finished");
			},
		]);
		const interrupted = harness.session.prompt("hold this turn");
		await started;
		await harness.session.abort();
		await interrupted.catch(() => undefined);
		seedLiveContext(harness, 321_000);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing held switch target fixture");
		await harness.session.setModel(target);
		expect(harness.session.pendingModelSwitch?.model.id).toBe("372k");
		harness.setResponses([fauxAssistantMessage("answered on the target model")]);

		// when the next prompt compacts and applies the switch
		await harness.session.prompt("continue");

		// then the follow-up is answered, not ended by the earlier interrupt
		expect(harness.session.model?.id).toBe("372k");
		expect(lastAnswer(harness)).toEqual({ text: "answered on the target model", stopReason: "stop" });
	});

	it("answers the follow-up when a large tool overhead leaves the switched context above the reduction ceiling", async () => {
		// given a held switch to a small window, with the engine's compaction extension and a large tool schema overhead
		const harness = await createHarness({
			models: [
				{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
				{ id: "80k", contextWindow: 80_000, maxTokens: 8_000 },
			],
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			extensionFactories: [
				compactionExtension,
				(pi) => {
					pi.registerTool({
						name: "wide_tool",
						label: "Wide tool",
						description: "schema overhead ".repeat(6_000),
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				},
			],
		});
		harnesses.push(harness);
		seedLiveContext(harness, 56_000, 11_000);
		const target = harness.getModel("80k");
		if (!target) throw new Error("missing held switch target fixture");
		await harness.session.setModel(target);
		expect(harness.session.pendingModelSwitch?.model.id).toBe("80k");
		harness.setResponses(Array.from({ length: 8 }, () => answering("answered on the target model")));

		// when the next prompt compacts and applies the switch
		await harness.session.prompt("continue");

		// then the follow-up is answered on the target model
		expect(harness.session.model?.id).toBe("80k");
		expect(lastAnswer(harness)).toEqual({ text: "answered on the target model", stopReason: "stop" });
	});

	it("control: with no held switch the same prompt is answered", async () => {
		// given the same session and no switch held
		const harness = await createHeldSwitchHarness();
		harnesses.push(harness);
		seedLiveContext(harness, 321_000);
		harness.setResponses([fauxAssistantMessage("answered on the current model")]);

		// when
		await harness.session.prompt("continue");

		// then
		expect(harness.session.model?.id).toBe("million");
		expect(lastAnswer(harness)).toEqual({ text: "answered on the current model", stopReason: "stop" });
	});

	it("control: a model switch during a running compaction still aborts that compaction", async () => {
		// given a manual compaction whose summary request is still running
		const harness = await createHarness({
			models: [
				{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
				{ id: "372k", contextWindow: 372_000, maxTokens: 32_000 },
			],
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		seedLiveContext(harness, 100_000);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing switch target fixture");
		let markSummaryStarted = () => {};
		const summaryStarted = new Promise<void>((resolve) => {
			markSummaryStarted = resolve;
		});
		let releaseSummary = () => {};
		const summaryReleased = new Promise<void>((resolve) => {
			releaseSummary = resolve;
		});
		harness.setResponses([
			async () => {
				markSummaryStarted();
				await summaryReleased;
				return fauxAssistantMessage("summary that must not apply");
			},
		]);
		const compacting = harness.session.compact().then(
			() => "completed" as const,
			() => "rejected" as const,
		);
		await summaryStarted;

		// when the model is switched while that compaction runs
		await harness.session.setModel(target);
		releaseSummary();

		// then the switch invalidated the running compaction: it ended aborted and nothing was applied
		expect(await compacting).toBe("rejected");
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true });
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
	});
});
