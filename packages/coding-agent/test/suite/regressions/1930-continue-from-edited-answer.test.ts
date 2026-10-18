import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, modelSupportsAssistantPrefill } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { CONTINUE_FROM_LEAF_CUSTOM_TYPE, ContinueFromLeafError } from "../../../src/core/continue-from-leaf.ts";
import type { SessionMessageEntry } from "../../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

function assistantEntries(harness: Harness): SessionMessageEntry[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "assistant");
}

function lastAssistantText(harness: Harness): string {
	const messages = harness.session.agent.state.messages.filter(
		(message): message is AssistantMessage => message.role === "assistant",
	);
	return getMessageText(messages[messages.length - 1] as AssistantMessage);
}

function recordingResponse(sent: Message[][], text: string): FauxResponseFactory {
	return (context) => {
		sent.push([...context.messages]);
		return fauxAssistantMessage(text);
	};
}

async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
	return pending.then(
		() => undefined,
		(error: unknown) => error,
	);
}

const PROVIDER_FAMILIES = [
	{ family: "a Claude-family model", api: "anthropic-messages" },
	{ family: "an OpenAI-family model", api: "openai-responses" },
] as const;

describe("continue from an edited answer with no new prompt (#1930)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function conversation(api: string): Promise<{ harness: Harness; sent: Message[][] }> {
		const harness = await createHarness({ api, persistSession: true });
		harnesses.push(harness);
		const sent: Message[][] = [];
		harness.setResponses([recordingResponse(sent, "The capital of France is Lyon.")]);
		await harness.session.prompt("What is the capital of France?");
		return { harness, sent };
	}

	for (const { family, api } of PROVIDER_FAMILIES) {
		it(`continues on ${family} from the edited text, without a visible prompt`, async () => {
			const { harness, sent } = await conversation(api);
			const [answer] = assistantEntries(harness);
			if (!answer) throw new Error("expected the first answer");
			await harness.session.editAssistantMessage(answer.id, "The capital of France is Paris.", {
				summarize: false,
			});
			harness.setResponses([recordingResponse(sent, "It has been since the 10th century.")]);

			await harness.session.continueFromLeaf();
			await harness.session.agent.waitForIdle();

			// The model saw the edited answer, not the original.
			const request = sent[sent.length - 1] ?? [];
			const assistantsSent = request.filter((message) => message.role === "assistant").map(getMessageText);
			expect(assistantsSent).toContain("The capital of France is Paris.");
			expect(assistantsSent).not.toContain("The capital of France is Lyon.");
			// The request ends on a user turn (the hidden nudge), never on an assistant prefill.
			expect(request[request.length - 1]?.role).toBe("user");
			// The new answer continues the conversation.
			expect(lastAssistantText(harness)).toBe("It has been since the 10th century.");
			// Exactly one user prompt was ever typed; the nudge is a hidden custom message.
			const visibleUsers = harness.session.agent.state.messages.filter((message) => message.role === "user");
			expect(visibleUsers.map(getMessageText)).toEqual(["What is the capital of France?"]);
			const nudges = harness.session.agent.state.messages.filter(
				(message) => message.role === "custom" && message.customType === CONTINUE_FROM_LEAF_CUSTOM_TYPE,
			);
			expect(nudges).toHaveLength(1);
			expect(nudges[0]).toMatchObject({ display: false });
		});
	}

	it("refuses with nothing_to_continue on a session with no messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const error = await rejectionOf(harness.session.continueFromLeaf());

		expect(error).toBeInstanceOf(ContinueFromLeafError);
		expect((error as ContinueFromLeafError).code).toBe("nothing_to_continue");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("refuses with leaf_not_assistant when the conversation ends on a user message, and sends nothing", async () => {
		const { harness } = await conversation("anthropic-messages");
		const question = harness.sessionManager
			.getEntries()
			.find((entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "user");
		if (!question) throw new Error("expected the question");
		// Editing a prompt leaves it as the new leaf without starting a turn; that is a Retry, not a continuation.
		await harness.session.editUserMessage(question.id, "What is the capital of Italy?", { summarize: false });
		const callsBefore = harness.faux.state.callCount;

		const error = await rejectionOf(harness.session.continueFromLeaf());

		expect(error).toBeInstanceOf(ContinueFromLeafError);
		expect((error as ContinueFromLeafError).code).toBe("leaf_not_assistant");
		expect(harness.faux.state.callCount).toBe(callsBefore);
		expect(
			harness.session.agent.state.messages.some(
				(message) => message.role === "custom" && message.customType === CONTINUE_FROM_LEAF_CUSTOM_TYPE,
			),
		).toBe(false);
	});

	it("refuses with streaming while a response is running, and leaves that response untouched", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const release = Promise.withResolvers<void>();
		harness.setResponses([
			async () => {
				await release.promise;
				return fauxAssistantMessage("Done thinking.");
			},
		]);
		const running = harness.session.prompt("Think about it");
		await new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "agent_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const error = await rejectionOf(harness.session.continueFromLeaf());
		release.resolve();
		await running;
		await harness.session.agent.waitForIdle();

		expect(error).toBeInstanceOf(ContinueFromLeafError);
		expect((error as ContinueFromLeafError).code).toBe("streaming");
		expect(lastAssistantText(harness)).toBe("Done thinking.");
		expect(
			harness.session.agent.state.messages.some(
				(message) => message.role === "custom" && message.customType === CONTINUE_FROM_LEAF_CUSTOM_TYPE,
			),
		).toBe(false);
	});

	it("surfaces a provider error on the continued turn like any other turn, as a turn event after admission", async () => {
		const { harness } = await conversation("anthropic-messages");
		const callsBefore = harness.faux.state.callCount;
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })]);

		// The reply is at admission (the error has not happened yet); the provider
		// failure then reaches the client through the turn's message_end, not the reply.
		await harness.session.continueFromLeaf();
		const eventsBeforeError = harness.eventsOfType("message_end").length;
		await harness.session.agent.waitForIdle();

		expect(harness.faux.state.callCount).toBe(callsBefore + 1);
		expect(harness.eventsOfType("message_end").length).toBeGreaterThan(eventsBeforeError);
		const errored = harness
			.eventsOfType("message_end")
			.map((event) => event.message)
			.filter(
				(message): message is AssistantMessage => message.role === "assistant" && message.stopReason === "error",
			);
		expect(errored.map((message) => message.errorMessage)).toEqual(["invalid_api_key"]);
		// The conversation before the failed turn is kept, so the user can retry from it.
		const answers = harness.session.agent.state.messages
			.filter((message): message is AssistantMessage => message.role === "assistant")
			.map(getMessageText);
		expect(answers).toContain("The capital of France is Lyon.");
	});
	it("resolves when the continued turn STARTS, not after the turn ends (#848)", async () => {
		const { harness } = await conversation("anthropic-messages");
		// A continuation whose response hangs until released: any design that answers
		// only after the turn ends cannot return before this release fires.
		let releaseTurn: (() => void) | undefined;
		const turnDone = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		harness.setResponses([
			() => turnDone.then(() => fauxAssistantMessage("The capital of France is Paris, finally.")),
		]);

		const reply = harness.session.continueFromLeaf();
		// The reply must be ready while the continued turn is still in flight. A
		// turn-end acknowledgment would leave this pending until releaseTurn runs.
		await Promise.race([
			reply,
			new Promise((_, reject) => setTimeout(() => reject(new Error("reply not sent at admission")), 5000)),
		]);

		// The turn is still running (its response was never released); release it and
		// let the continuation finish so the session tears down cleanly.
		releaseTurn?.();
		await harness.session.agent.waitForIdle();
		const last = harness.session.agent.state.messages.at(-1);
		expect(last?.role === "assistant" ? getMessageText(last) : undefined).toBe(
			"The capital of France is Paris, finally.",
		);
	});
});

describe("assistant prefill capability", () => {
	it("is off for every model unless a model is explicitly marked after a probe", () => {
		expect(modelSupportsAssistantPrefill({ api: "anthropic-messages" }, { thinkingEnabled: false })).toBe(false);
		expect(modelSupportsAssistantPrefill({ api: "openai-responses" }, { thinkingEnabled: false })).toBe(false);
		expect(
			modelSupportsAssistantPrefill(
				{ api: "openai-completions", supportsAssistantPrefill: true },
				{ thinkingEnabled: true },
			),
		).toBe(true);
	});

	it("is off on the Anthropic Messages API while extended thinking is on, even for a marked model", () => {
		const marked = { api: "anthropic-messages", supportsAssistantPrefill: true } as const;

		expect(modelSupportsAssistantPrefill(marked, { thinkingEnabled: true })).toBe(false);
		expect(modelSupportsAssistantPrefill(marked, { thinkingEnabled: false })).toBe(true);
	});
});
