import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ENVIRONMENT_CONTEXT_MESSAGE_TYPE,
	formatEnvironmentContext,
	latestEnvironmentContext,
} from "../../../src/core/environment-context.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

// senpi#2093: cwd and date leave the system prompt and reach the model as an
// append-only environment-context message, so the prompt prefix stays cacheable.

const DAY_ONE = new Date("2026-09-24T12:00:00.000Z");
const DAY_TWO = new Date("2026-09-25T12:00:00.000Z");

function setToday(day: Date): void {
	vi.setSystemTime(day);
}

function environmentMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.filter(
		(message) => message.role === "custom" && message.customType === ENVIRONMENT_CONTEXT_MESSAGE_TYPE,
	);
}

function roles(messages: readonly AgentMessage[]): string[] {
	return messages.map((message) => (message.role === "custom" ? `custom:${message.customType}` : message.role));
}

function expectedText(harness: Harness, day: Date): string {
	return formatEnvironmentContext({
		cwd: harness.tempDir.replace(/\\/g, "/"),
		currentDate: day.toISOString().slice(0, 10),
	});
}

function withCompactionSummary(): Parameters<typeof createHarness>[0] {
	return {
		environmentContext: true,
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "compacted",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
			},
		],
	};
}

describe("senpi#2093: environment context message", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.useRealTimers();
	});

	async function start(options?: Parameters<typeof createHarness>[0]): Promise<Harness> {
		vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
		setToday(DAY_ONE);
		const harness = await createHarness({ environmentContext: true, ...options });
		harnesses.push(harness);
		return harness;
	}

	it("keeps the system prompt byte-identical across dates and working directories", async () => {
		const first = await start();
		first.setResponses([fauxAssistantMessage("one")]);
		await first.session.prompt("hi");

		setToday(DAY_TWO);
		const second = await createHarness({ environmentContext: true });
		harnesses.push(second);
		second.setResponses([fauxAssistantMessage("two")]);
		await second.session.prompt("hi");

		const firstRequest = first.faux.getCallLog()[0]?.context;
		const secondRequest = second.faux.getCallLog()[0]?.context;
		expect(first.tempDir).not.toBe(second.tempDir);
		expect(secondRequest?.systemPrompt).toBe(firstRequest?.systemPrompt);
		expect(firstRequest?.systemPrompt).not.toContain("Current date:");
		expect(firstRequest?.systemPrompt).not.toContain("Current working directory:");
		// senpi#2118: the environment context is the leading block of the prompt's user message.
		expect(getMessageText(firstRequest?.messages[0])).toBe(`${expectedText(first, DAY_ONE)}\nhi`);
		expect(getMessageText(secondRequest?.messages[0])).toBe(`${expectedText(second, DAY_TWO)}\nhi`);
	});

	it("sends exactly one hidden user-role environment message before the first user turn", async () => {
		const harness = await start();
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("hi");
		await harness.session.prompt("again");

		expect(roles(harness.session.messages)).toEqual([
			`custom:${ENVIRONMENT_CONTEXT_MESSAGE_TYPE}`,
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		const [environment] = environmentMessages(harness.session.messages);
		expect(environment?.role === "custom" && environment.display).toBe(false);
		const secondRequest = harness.faux.getCallLog()[1]?.context;
		expect(secondRequest?.messages[0]?.role).toBe("user");
		expect(getMessageText(secondRequest?.messages[0])).toBe(`${expectedText(harness, DAY_ONE)}\nhi`);
	});

	it("appends one new environment message before the next user turn after a date rollover", async () => {
		const harness = await start();
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("hi");
		const firstRequestMessages = harness.faux.getCallLog()[0]?.context.messages ?? [];

		setToday(DAY_TWO);
		await harness.session.prompt("tomorrow");

		expect(roles(harness.session.messages)).toEqual([
			`custom:${ENVIRONMENT_CONTEXT_MESSAGE_TYPE}`,
			"user",
			"assistant",
			`custom:${ENVIRONMENT_CONTEXT_MESSAGE_TYPE}`,
			"user",
			"assistant",
		]);
		const secondRequestMessages = harness.faux.getCallLog()[1]?.context.messages ?? [];
		expect(secondRequestMessages.slice(0, firstRequestMessages.length)).toEqual(firstRequestMessages);
		expect(secondRequestMessages).toHaveLength(3);
		expect(getMessageText(secondRequestMessages[2])).toBe(`${expectedText(harness, DAY_TWO)}\ntomorrow`);
	});

	it("replays the persisted environment message at its original position on resume", async () => {
		const harness = await start({ environmentContext: true, persistSession: true });
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("hi");
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("persisted harness has no session file");

		const resumed = SessionManager.open(sessionFile).buildSessionContext().messages;
		expect(roles(resumed)).toEqual([`custom:${ENVIRONMENT_CONTEXT_MESSAGE_TYPE}`, "user", "assistant"]);
		expect(getMessageText(resumed[0])).toBe(expectedText(harness, DAY_ONE));

		harness.session.agent.state.messages = resumed;
		await harness.session.prompt("same day");
		expect(environmentMessages(harness.session.messages)).toHaveLength(1);
		expect(getMessageText(harness.faux.getCallLog()[1]?.context.messages[0])).toBe(
			`${expectedText(harness, DAY_ONE)}\nhi`,
		);
	});

	it("keeps the latest environment context visible to the first turn after compaction", async () => {
		const harness = await start(withCompactionSummary());
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("one");
		setToday(DAY_TWO);
		await harness.session.prompt("two");

		await harness.session.compact();
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");

		harness.setResponses([fauxAssistantMessage("third")]);
		await harness.session.prompt("three");

		const request = harness.faux.getCallLog().at(-1)?.context.messages ?? [];
		const texts = request.map((message) => getMessageText(message));
		const latest = expectedText(harness, DAY_TWO);
		expect(texts.filter((text) => text.includes(latest))).toHaveLength(1);
		expect(texts.findIndex((text) => text.includes(latest))).toBeLessThanOrEqual(
			texts.findLastIndex((text) => text.endsWith("three")),
		);
		expect(texts.some((text) => text.includes(expectedText(harness, DAY_ONE)))).toBe(false);
		expect(latestEnvironmentContext(harness.session.messages)?.currentDate).toBe("2026-09-25");
	});
});
