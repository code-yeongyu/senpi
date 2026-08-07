import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { BTW_HISTORY_ENTRY_TYPE } from "../../src/core/extensions/builtin/btw/history.ts";
import btwExtension from "../../src/core/extensions/builtin/btw/index.ts";
import {
	buildSideQueryContext,
	runSideQuery,
	SIDE_QUERY_INSTRUCTION,
} from "../../src/core/extensions/builtin/btw/side-query.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/index.ts";
import { theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

type Notification = {
	readonly message: string;
	readonly type: "info" | "warning" | "error" | undefined;
};

function createUiContext(
	onNotify: (message: string, type: "info" | "warning" | "error" | undefined) => void,
): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: onNotify,
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>(): Promise<T> => {
			throw new Error("custom UI is not implemented in /btw side-query tests");
		},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "themes are not used by /btw side-query tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

describe("buildSideQueryContext", () => {
	const messagePairs = (messages: ReturnType<typeof buildSideQueryContext>["messages"]) =>
		messages.map((message) => [message.role, getMessageText(message)]);

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

	it("places prior btw messages after history and before the final question", () => {
		const context = buildSideQueryContext({
			systemPrompt: "BASE",
			history: [{ role: "user", content: "main thread", timestamp: 1 }],
			priorBtw: [
				{ role: "user", content: "earlier btw question" },
				{ role: "assistant", content: "earlier btw answer" },
			],
			question: "follow up?",
		});

		expect(messagePairs(context.messages)).toEqual([
			["user", "main thread"],
			["user", "earlier btw question"],
			["assistant", "earlier btw answer"],
			["user", "follow up?"],
		]);
	});

	it("keeps history followed by the final question when prior btw messages are omitted", () => {
		const context = buildSideQueryContext({
			systemPrompt: "BASE",
			history: [{ role: "assistant", content: "earlier answer", timestamp: 1 }],
			question: "what now?",
		});

		expect(messagePairs(context.messages)).toEqual([
			["assistant", "earlier answer"],
			["user", "what now?"],
		]);
	});

	it("does not mutate the caller's history or prior btw arrays", () => {
		const history = [{ role: "user", content: "main thread", timestamp: 1 }] as const;
		const priorBtw = [
			{ role: "user", content: "earlier btw question" },
			{ role: "assistant", content: "earlier btw answer" },
		] as const;
		const originalHistory = [...history];
		const originalPriorBtw = [...priorBtw];

		buildSideQueryContext({ systemPrompt: "BASE", history, priorBtw, question: "follow up?" });

		expect([history.length, priorBtw.length]).toEqual([1, 2]);
		expect({ history, priorBtw }).toEqual({ history: originalHistory, priorBtw: originalPriorBtw });
	});

	it("treats an empty prior btw array like omitted prior btw messages", () => {
		const history = [{ role: "assistant", content: "earlier answer", timestamp: 1 }] as const;
		const omitted = buildSideQueryContext({ systemPrompt: "BASE", history, question: "what now?" });
		const empty = buildSideQueryContext({ systemPrompt: "BASE", history, priorBtw: [], question: "what now?" });

		expect(messagePairs(empty.messages)).toEqual(messagePairs(omitted.messages));
	});

	it("includes language matching instruction in the system prompt", () => {
		const context = buildSideQueryContext({
			systemPrompt: "BASE PROMPT",
			history: [],
			question: "무엇을 해야 하나요?",
		});
		expect(SIDE_QUERY_INSTRUCTION).toContain("same language");
		expect(context.systemPrompt).toContain("same language");
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

	async function setupWithNotifications() {
		const harness = await setup();
		const notifications: Notification[] = [];
		await harness.session.bindExtensions({
			mode: "print",
			uiContext: createUiContext((message, type) => notifications.push({ message, type })),
		});
		return { harness, notifications };
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

	it("shows usage feedback when question is empty", async () => {
		// Given a /btw command with no stored side-question history
		const { harness, notifications } = await setupWithNotifications();
		harness.setResponses([fauxAssistantMessage("unused")]);

		// When the user opens bare /btw
		await harness.session.prompt("/btw");

		// Then it opens the history surface as an empty-state notification without calling the provider
		expect(harness.faux.state.callCount).toBe(0);
		expect(notifications).toEqual([
			{
				message: "No side questions yet in this session.",
				type: "info",
			},
		]);
	});

	it("lists persisted side questions when question is empty", async () => {
		// Given two completed side questions stored in this session
		const { harness, notifications } = await setupWithNotifications();
		harness.sessionManager.appendCustomEntry(BTW_HISTORY_ENTRY_TYPE, {
			question: "first side question",
			answer: "first side answer",
			timestamp: 1,
		});
		harness.sessionManager.appendCustomEntry(BTW_HISTORY_ENTRY_TYPE, {
			question: "second side question",
			answer: "second side answer",
			timestamp: 2,
		});
		harness.setResponses([fauxAssistantMessage("unused")]);

		// When the user opens bare /btw
		await harness.session.prompt("/btw");

		// Then the non-TUI history output contains both stored Q&A pairs and no provider call is made
		expect(harness.faux.state.callCount).toBe(0);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.type).toBe("info");
		expect(notifications[0]?.message).toContain("first side question");
		expect(notifications[0]?.message).toContain("first side answer");
		expect(notifications[0]?.message).toContain("second side question");
		expect(notifications[0]?.message).toContain("second side answer");
	});

	it("keeps the main session message count unchanged when question is empty", async () => {
		// Given a stored side question and no main conversation messages
		const { harness } = await setupWithNotifications();
		harness.sessionManager.appendCustomEntry(BTW_HISTORY_ENTRY_TYPE, {
			question: "stored side question",
			answer: "stored side answer",
			timestamp: 1,
		});
		const messagesBefore = harness.session.messages.length;

		// When the user opens bare /btw
		await harness.session.prompt("/btw");

		// Then the history viewer does not append a user or assistant message to the main session
		expect(harness.session.messages.length).toBe(messagesBefore);
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

	function getBtwHistoryEntries(harness: Harness) {
		return harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === BTW_HISTORY_ENTRY_TYPE);
	}

	it("persists a completed side question as a custom history entry without polluting session history", async () => {
		// Given a main session turn followed by a side question
		const harness = await setup();
		const question = "what should I remember?";
		const replyText = "Remember the full streamed answer.\nIt has two lines.";
		harness.setResponses([fauxAssistantMessage("main answer"), fauxAssistantMessage(replyText)]);

		// When the side query settles successfully
		await harness.session.prompt("main question");
		const messagesBefore = harness.session.messages.length;
		await harness.session.prompt(`/btw ${question}`);

		// Then the main message history is unchanged and exactly one custom history entry is persisted
		expect(harness.session.messages.length).toBe(messagesBefore);
		const historyEntries = getBtwHistoryEntries(harness);
		expect(historyEntries).toHaveLength(1);
		const entry = historyEntries[0];
		expect(entry?.type).toBe("custom");
		expect(entry?.customType).toBe(BTW_HISTORY_ENTRY_TYPE);
		expect(entry?.type === "custom" ? entry.data : undefined).toEqual({
			question,
			answer: replyText,
			timestamp: expect.any(Number),
		});
	});

	it("injects the previous side question and answer into the next side query", async () => {
		// Given one completed side question in the current session
		const harness = await setup();
		harness.setResponses([fauxAssistantMessage("answer to q1"), fauxAssistantMessage("answer to q2")]);
		await harness.session.prompt("/btw q1");

		// When the user asks a second side question
		await harness.session.prompt("/btw q2");

		// Then the second side call includes q1's Q&A before the new final question
		const secondCall = harness.faux.getCallLog().at(-1);
		const sideMessages = secondCall?.context.messages ?? [];
		const sideTexts = sideMessages.map((message) => getMessageText(message));
		expect(sideTexts.some((text) => text.includes("q1") && text.includes("answer to q1"))).toBe(true);
		expect(getMessageText(sideMessages.at(-1))).toBe("q2");
	});

	it("injects only the newest ten prior side questions into a side query", async () => {
		// Given twelve stored side-question history entries in this session
		const harness = await setup();
		for (let index = 1; index <= 12; index += 1) {
			const label = index.toString().padStart(2, "0");
			harness.sessionManager.appendCustomEntry(BTW_HISTORY_ENTRY_TYPE, {
				question: `side question ${label}`,
				answer: `side answer ${label}`,
				timestamp: index,
			});
		}
		harness.setResponses([fauxAssistantMessage("new side answer")]);

		// When the user asks a new side question
		await harness.session.prompt("/btw newest side question");

		// Then only entries 03 through 12 are injected before the new final question
		const sideCall = harness.faux.getCallLog().at(-1);
		const sideText = (sideCall?.context.messages ?? []).map((message) => getMessageText(message)).join("\n---\n");
		expect(sideText).not.toContain("side question 01");
		expect(sideText).not.toContain("side answer 01");
		expect(sideText).not.toContain("side question 02");
		expect(sideText).not.toContain("side answer 02");
		for (let index = 3; index <= 12; index += 1) {
			const label = index.toString().padStart(2, "0");
			expect(sideText).toContain(`side question ${label}`);
			expect(sideText).toContain(`side answer ${label}`);
		}
		expect(getMessageText(sideCall?.context.messages.at(-1))).toBe("newest side question");
	});

	it("does not persist history when a side query fails", async () => {
		// Given a provider that fails the side query
		const harness = await setup();
		harness.setResponses([
			() => {
				throw new Error("provider exploded");
			},
		]);
		const messagesBefore = harness.session.messages.length;

		// When the side query fails
		await harness.session.prompt("/btw failing question");

		// Then no custom history entry is persisted and no main message is added
		expect(harness.session.messages.length).toBe(messagesBefore);
		expect(getBtwHistoryEntries(harness)).toHaveLength(0);
	});

	it("does not persist history when a side query is aborted", async () => {
		// Given a side query waiting for its abort signal
		const harness = await setup();
		let aborted = false;
		let sideEntered!: () => void;
		const sideInFlight = new Promise<void>((resolve) => {
			sideEntered = resolve;
		});
		harness.setResponses([
			async (_context, options) => {
				sideEntered();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) {
						aborted = true;
						resolve();
						return;
					}
					options?.signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
							resolve();
						},
						{ once: true },
					);
				});
				throw new Error("aborted");
			},
		]);
		const messagesBefore = harness.session.messages.length;

		// When a session switch aborts the in-flight side query
		const sidePrompt = harness.session.prompt("/btw abortable question");
		await sideInFlight;
		await harness.getExtensionRunner().emit({
			type: "session_before_switch",
			reason: "new",
			targetSessionFile: undefined,
		});
		await sidePrompt;

		// Then the abort is observed without a history write or main message write
		expect(aborted).toBe(true);
		expect(harness.session.messages.length).toBe(messagesBefore);
		expect(getBtwHistoryEntries(harness)).toHaveLength(0);
	});
});
