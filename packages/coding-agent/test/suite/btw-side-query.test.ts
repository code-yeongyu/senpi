import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import btwExtension from "../../src/core/extensions/builtin/btw/index.ts";
import {
	buildSideQueryContext,
	runSideQuery,
	SIDE_QUERY_INSTRUCTION,
} from "../../src/core/extensions/builtin/btw/side-query.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

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
		harness.setResponses([
			fauxAssistantMessage("first answer"),
			async () => {
				await sideGate;
				return fauxAssistantMessage("side answer");
			},
			fauxAssistantMessage("second answer"),
		]);

		await harness.session.prompt("first question");
		const sidePrompt = harness.session.prompt("/btw snapshot question");
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
