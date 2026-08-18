import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import btwExtension from "../../src/core/extensions/builtin/btw/index.ts";
import {
	buildSideQueryContext,
	getSideQueryPromptContextWindow,
	runSideQuery,
	SIDE_QUERY_INSTRUCTION,
} from "../../src/core/extensions/builtin/btw/side-query.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function estimatePromptTokens(context: {
	systemPrompt?: string;
	messages: Parameters<typeof estimateTokens>[0][];
}): number {
	return (
		estimateTokens({ role: "user", content: context.systemPrompt ?? "", timestamp: 0 }) +
		context.messages.reduce((total, message) => total + estimateTokens(message), 0)
	);
}

describe("buildSideQueryContext", () => {
	it("appends the side instruction to the system prompt and the question as the final user message", () => {
		const context = buildSideQueryContext({
			systemPrompt: "BASE PROMPT",
			history: [{ role: "user", content: "earlier", timestamp: 1 }],
			question: "what did I ask?",
		});
		expect(context.systemPrompt).toContain("BASE PROMPT");
		expect(context.systemPrompt).toContain(SIDE_QUERY_INSTRUCTION);
		expect(context.tools).toEqual([]);
		expect(context.messages).toHaveLength(2);
		expect(context.messages[1]).toMatchObject({ role: "user" });
		expect(getMessageText(context.messages[1])).toBe("what did I ask?");
	});

	it("does not mutate the caller's history array", () => {
		const history = [{ role: "user", content: "earlier", timestamp: 1 }] as const;
		const mutable = [...history];
		buildSideQueryContext({ systemPrompt: "BASE", history: mutable, question: "q" });
		expect(mutable).toHaveLength(1);
	});

	it("bounds an oversized snapshot to the selected model prompt window", () => {
		const promptContextWindow = 4_500;
		const oldestMarker = `oldest-${"a".repeat(4_000)}`;
		const newestMarker = `newest-${"b".repeat(4_000)}`;
		const input = {
			systemPrompt: "BASE",
			history: [
				{ role: "user" as const, content: oldestMarker, timestamp: 1 },
				fauxAssistantMessage("old answer", { timestamp: 2 }),
				{ role: "user" as const, content: newestMarker, timestamp: 3 },
				fauxAssistantMessage("new answer", { timestamp: 4 }),
			],
			question: "what is newest?",
			promptContextWindow,
		};

		const context = buildSideQueryContext(input);

		expect(estimatePromptTokens(context)).toBeLessThanOrEqual(promptContextWindow);
		expect(context.messages.some((message) => getMessageText(message) === oldestMarker)).toBe(false);
		expect(context.messages.some((message) => getMessageText(message) === newestMarker)).toBe(true);
		expect(getMessageText(context.messages.at(-1))).toBe("what is newest?");
	});

	it("keeps mandatory prompt content and valid tool pairs at the budget boundary", () => {
		const promptContextWindow = 900;
		const question = "keep this exact question";
		const context = buildSideQueryContext({
			systemPrompt: `BASE-${"s".repeat(800)}`,
			history: [
				{ role: "user", content: `old-${"o".repeat(2_000)}`, timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.md" } }],
					api: "faux",
					provider: "faux",
					model: "faux-1",
					usage: {
						input: 125,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 125,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: `result-${"r".repeat(2_000)}` }],
					isError: false,
					timestamp: 3,
				},
				{ role: "user", content: "newest context", timestamp: 4 },
			],
			question,
			promptContextWindow,
		});

		expect(context.systemPrompt).toContain("BASE-");
		expect(context.systemPrompt).toContain(SIDE_QUERY_INSTRUCTION);
		expect(getMessageText(context.messages.at(-1))).toBe(question);
		expect(estimatePromptTokens(context)).toBeLessThanOrEqual(promptContextWindow);
		const toolCallIds = new Set(
			context.messages.flatMap((message) =>
				message.role === "assistant"
					? message.content.filter((part) => part.type === "toolCall").map((part) => part.id)
					: [],
			),
		);
		expect(
			context.messages
				.filter((message) => message.role === "toolResult")
				.every((message) => toolCallIds.has(message.toolCallId)),
		).toBe(true);
	});

	it("counts a large system prompt against the side-query budget", () => {
		const promptContextWindow = 14_000;
		const context = buildSideQueryContext({
			systemPrompt: `BASE-${"s".repeat(10_000)}`,
			history: [{ role: "user", content: `old-${"o".repeat(6_000)}`, timestamp: 1 }],
			question: "keep the newest question",
			promptContextWindow,
		});

		expect(estimatePromptTokens(context)).toBeLessThanOrEqual(promptContextWindow);
		expect(getMessageText(context.messages.at(-1))).toBe("keep the newest question");
	});

	it("reserves at most half the context window for side-query output", () => {
		expect(getSideQueryPromptContextWindow({ contextWindow: 2_000, maxTokens: 256 })).toBe(1_744);
		expect(getSideQueryPromptContextWindow({ contextWindow: 2_000, maxTokens: 4_000 })).toBe(1_000);
		expect(getSideQueryPromptContextWindow({ contextWindow: 2_000, maxTokens: 0 })).toBe(2_000);
	});
});

describe("runSideQuery", () => {
	const registrations: Array<{ unregister(): void }> = [];

	afterEach(() => {
		while (registrations.length > 0) {
			registrations.pop()?.unregister();
		}
	});

	function setup() {
		const faux = registerFauxProvider();
		registrations.push(faux);
		return faux;
	}

	it("streams deltas and resolves the full reply without touching tools", async () => {
		const faux = setup();
		faux.setResponses([fauxAssistantMessage("the answer is 4")]);

		const deltas: string[] = [];
		const result = await runSideQuery(
			{
				model: faux.getModel(),
				auth: { apiKey: "faux-key" },
				sessionId: "session-1",
				establishmentTimeoutMs: 5_000,
			},
			buildSideQueryContext({ systemPrompt: "BASE", history: [], question: "2+2?" }),
			{ onTextDelta: (delta) => deltas.push(delta) },
		);

		expect(result.replyText).toBe("the answer is 4");
		expect(deltas.join("")).toBe("the answer is 4");
		const call = faux.getCallLog().at(-1);
		expect(call?.context.tools).toEqual([]);
		expect(call?.options?.sessionId).toMatch(/^session-1:btw:/);
	});

	it("rejects when the provider errors", async () => {
		const faux = setup();
		faux.setResponses([
			() => {
				throw new Error("provider exploded");
			},
		]);

		await expect(
			runSideQuery(
				{
					model: faux.getModel(),
					auth: { apiKey: "faux-key" },
					sessionId: "session-1",
					establishmentTimeoutMs: 5_000,
				},
				buildSideQueryContext({ systemPrompt: "BASE", history: [], question: "q" }),
				{},
			),
		).rejects.toThrow(/provider exploded/);
	});

	it("times out when the provider never produces an event", async () => {
		const faux = setup();
		faux.setResponses([fauxAssistantMessage("unused")]);

		await expect(
			runSideQuery(
				{
					model: faux.getModel(),
					auth: { apiKey: "faux-key" },
					sessionId: "session-1",
					establishmentTimeoutMs: 25,
					streamFn: ((_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) =>
						(async function* () {
							await new Promise((_, reject) => {
								options?.signal?.addEventListener("abort", () => reject(options.signal?.reason));
							});
						})()) as never,
				},
				buildSideQueryContext({ systemPrompt: "BASE", history: [], question: "q" }),
				{},
			),
		).rejects.toThrow(/timed? ?out|did not produce/i);
	});

	it("rejects immediately when the signal is already aborted", async () => {
		const faux = setup();
		faux.setResponses([fauxAssistantMessage("unused")]);
		const controller = new AbortController();
		controller.abort();

		await expect(
			runSideQuery(
				{
					model: faux.getModel(),
					auth: { apiKey: "faux-key" },
					sessionId: "session-1",
					establishmentTimeoutMs: 5_000,
				},
				buildSideQueryContext({ systemPrompt: "BASE", history: [], question: "q" }),
				{ signal: controller.signal },
			),
		).rejects.toThrow();
		expect(faux.state.callCount).toBe(0);
	});
});

describe("/btw extension command", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function setup() {
		const harness = await createHarness({ extensionFactories: [btwExtension] });
		harnesses.push(harness);
		return harness;
	}

	it("answers a side question without polluting session history", async () => {
		const harness = await setup();
		harness.setResponses([fauxAssistantMessage("main answer"), fauxAssistantMessage("side answer")]);

		await harness.session.prompt("main question");
		const messagesBefore = harness.session.messages.length;
		await harness.session.prompt("/btw what did I just ask?");

		expect(harness.session.messages.length).toBe(messagesBefore);
		const sideCall = harness.faux.getCallLog().at(-1);
		expect(sideCall?.context.tools).toEqual([]);
		const sideMessages = sideCall?.context.messages ?? [];
		expect(getMessageText(sideMessages.at(-1))).toBe("what did I just ask?");
		expect(sideMessages.some((message) => getMessageText(message) === "main question")).toBe(true);
		expect(sideCall?.context.systemPrompt).toContain(SIDE_QUERY_INSTRUCTION);
	});

	it("shows usage feedback instead of calling the provider when the question is empty", async () => {
		const harness = await setup();
		harness.setResponses([fauxAssistantMessage("unused")]);

		await harness.session.prompt("/btw");

		expect(harness.faux.state.callCount).toBe(0);
	});

	it("runs in parallel with an in-flight main turn", async () => {
		const harness = await setup();
		let releaseMain!: () => void;
		let mainEntered!: () => void;
		const mainGate = new Promise<void>((resolve) => {
			releaseMain = resolve;
		});
		const mainInFlight = new Promise<void>((resolve) => {
			mainEntered = resolve;
		});
		harness.setResponses([
			async () => {
				mainEntered();
				await mainGate;
				return fauxAssistantMessage("main done");
			},
			fauxAssistantMessage("side done"),
		]);

		const mainPrompt = harness.session.prompt("slow main question");
		await mainInFlight;
		const sidePrompt = harness.session.prompt("/btw parallel question");
		await sidePrompt;
		releaseMain();
		await mainPrompt;

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(getMessageText(harness.session.messages[1])).toBe("main done");
	});

	it("snapshots context synchronously so a concurrent main turn cannot create a mixed generation", async () => {
		const harness = await setup();
		let releaseSide!: () => void;
		const sideGate = new Promise<void>((resolve) => {
			releaseSide = resolve;
		});
		let sideEntered!: () => void;
		const sideInFlight = new Promise<void>((resolve) => {
			sideEntered = resolve;
		});
		harness.setResponses([
			fauxAssistantMessage("first answer"),
			async () => {
				sideEntered();
				await sideGate;
				return fauxAssistantMessage("side answer");
			},
			fauxAssistantMessage("second answer"),
		]);

		await harness.session.prompt("first question");
		const sidePrompt = harness.session.prompt("/btw snapshot question");
		await sideInFlight;
		await harness.session.prompt("second question");
		releaseSide();
		await sidePrompt;

		const sideCall = harness.faux.getCallLog()[1];
		const userTexts = (sideCall?.context.messages ?? [])
			.filter((message) => message.role === "user")
			.map((message) => getMessageText(message));
		expect(userTexts).toEqual(["first question", "snapshot question"]);
	});

	it("aborts the previous side query when a new /btw arrives", async () => {
		const harness = await setup();
		let firstAborted = false;
		let firstEntered!: () => void;
		const firstInFlight = new Promise<void>((resolve) => {
			firstEntered = resolve;
		});
		harness.setResponses([
			async (_context, options) => {
				firstEntered();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) {
						firstAborted = true;
						resolve();
						return;
					}
					options?.signal?.addEventListener("abort", () => {
						firstAborted = true;
						resolve();
					});
				});
				throw new Error("aborted");
			},
			fauxAssistantMessage("second side answer"),
		]);

		const first = harness.session.prompt("/btw first");
		await firstInFlight;
		const second = harness.session.prompt("/btw second");
		await Promise.all([first, second]);

		expect(firstAborted).toBe(true);
		const lastCall = harness.faux.getCallLog().at(-1);
		expect(getMessageText(lastCall?.context.messages.at(-1))).toBe("second");
	});
});
