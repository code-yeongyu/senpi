import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type Model,
} from "@earendil-works/pi-ai";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import { createHarness, type Harness } from "../harness.ts";

const WINDOW = 100_000;
const API = "senpi-2925-overhead";
const FINAL = "FINAL REPORT: the survey is complete.";

const page = (n: number, chars: number): string =>
	`page ${n} `.concat("lorem ipsum dolor sit amet ".repeat(Math.ceil(chars / 27)));

const usage = (input: number) => ({
	input,
	output: 50,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + 50,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

// A provider whose reported usage includes a fixed system-prompt and tool-schema overhead that the
// transcript does not show, as a real provider's does: on a 100K window that overhead leaves room for
// only a few large tool results (the shape of the replayed Haiku runs in senpi#2925).
async function overheadSurvey(overhead: number, pageChars: number[]): Promise<Harness> {
	const fetched = { count: 0 };
	const harness = await createHarness({
		settings: { compaction: { enabled: true } },
		extensionFactories: [
			compactionExtension,
			(pi) => {
				pi.registerTool({
					name: "fetch_page",
					label: "Fetch page",
					description: "Return the full text of page n",
					parameters: Type.Object({ n: Type.Number() }),
					execute: async (_id, params) => {
						const n = (params as { n: number }).n;
						fetched.count = Math.max(fetched.count, n);
						return { content: [{ type: "text", text: page(n, pageChars[n - 1] ?? 10) }], details: {} };
					},
				});
			},
		],
	});
	const respond = (_model: unknown, context: { messages: { content: unknown }[] }) => {
		const input = overhead + Math.ceil(JSON.stringify(context.messages).length / 4);
		const isSummary = JSON.stringify(context.messages.at(-1)?.content ?? "").includes("[INTERNAL ");
		let message: AssistantMessage;
		if (input > WINDOW) {
			message = {
				...fauxAssistantMessage(""),
				stopReason: "error",
				errorMessage: `prompt is too long: ${input} tokens > ${WINDOW} maximum`,
			};
		} else if (isSummary) {
			message = fauxAssistantMessage("<summary>Fetched the earlier pages; continue with the next one.</summary>");
		} else if (fetched.count < pageChars.length) {
			const n = fetched.count + 1;
			message = fauxAssistantMessage([fauxToolCall("fetch_page", { n }, { id: `call-${n}` })], {
				stopReason: "toolUse",
			});
		} else {
			message = fauxAssistantMessage([fauxText(FINAL)]);
		}
		const done = { ...message, api: API, provider: API, model: API, usage: usage(input) };
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: done.stopReason, message: done } as never);
		stream.end(done);
		return stream;
	};
	registerApiProvider({ api: API, stream: respond as never, streamSimple: respond as never }, API);
	const model: Model<typeof API> = {
		...harness.getModel(),
		api: API,
		provider: API,
		id: API,
		name: "Small window with overhead",
		baseUrl: API,
		contextWindow: WINDOW,
		maxTokens: 24_000,
	};
	const runtime = harness.modelRegistry.modelRuntime;
	await runtime.registerProvider(API, { api: API, apiKey: "test-key", baseUrl: API, models: [model] });
	const registered = runtime.getModel(API, API);
	if (!registered) throw new Error("test setup: overhead model was not registered");
	await harness.session.bindExtensions({});
	await harness.session.setModel(registered);
	return harness;
}

function lastAssistant(harness: Harness): AssistantMessage | undefined {
	return harness.session.agent.state.messages.filter((m): m is AssistantMessage => m.role === "assistant").at(-1);
}

describe("senpi#2925: a required compaction inside one tool-heavy turn", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		unregisterApiProviders(API);
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each([
		{ shape: "two pages, as the replayed survey run", pages: [43_442, 18_149] },
		{ shape: "four pages", pages: [43_442, 18_149, 20_000, 20_000] },
		{ shape: "three large pages", pages: [40_000, 40_000, 40_000] },
	])("splits the current turn and delivers the answer ($shape)", async ({ pages }) => {
		// Given 70.5K of fixed overhead, so the first page already crosses the hard limit while the
		// transcript holds nothing older than the current turn.
		const harness = await overheadSurvey(70_500, pages);
		harnesses.push(harness);

		// When the turn runs.
		await harness.session.prompt("Survey the pages and write a report.");

		// Then the earlier steps of the turn were summarized and the turn finished.
		const last = lastAssistant(harness);
		expect(last?.errorMessage).toBeUndefined();
		expect(last?.content).toEqual([expect.objectContaining({ type: "text", text: FINAL })]);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
	});
});

describe("senpi#2925: the split-turn retry answers only a compaction that found nothing to compact", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("does not retry a compaction an extension rejected, even with an earlier attempt's flag left set", async () => {
		// Given a session with older content to compact, an extension that rejects every compaction, and a
		// "nothing to compact" outcome left over from an earlier attempt.
		let beforeCompactCalls = 0;
		const harness = await createHarness({
			models: [{ id: "small-window", contextWindow: 20_000, maxTokens: 4_096 }],
			settings: {
				compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1, speculativeEnabled: false },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => {
						beforeCompactCalls += 1;
						return { cancel: true, reason: "rejected by test extension" };
					});
				},
			],
		});
		harnesses.push(harness);
		const now = Date.now() - 1_000;
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "first request" }],
			timestamp: now,
		});
		harness.sessionManager.appendMessage(
			fauxAssistantMessage("older answer ".concat("x".repeat(60_000)), { timestamp: now + 1 }),
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "second request" }],
			timestamp: now + 2,
		});
		const assistant = fauxAssistantMessage("latest answer ".concat("y".repeat(20_000)), { timestamp: now + 3 });
		harness.sessionManager.appendMessage(assistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		Reflect.set(harness.session, "_compactionSkippedTooSmall", true);

		// When the threshold check runs and the extension rejects the compaction.
		const checkCompaction = Reflect.get(harness.session, "_checkCompaction") as (
			message: AssistantMessage,
			skipAbortedCheck: boolean,
			inlineReason: "threshold",
		) => Promise<boolean>;
		const compacted = await checkCompaction.call(harness.session, assistant, true, "threshold");

		// Then that one rejected attempt is the only one: it is not retried as if it had found nothing to compact.
		expect(compacted).toBe(false);
		expect(beforeCompactCalls).toBe(1);
	});
});
