import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function seedSession(harness: Harness, userText: string, usageTokens: number): void {
	const now = Date.now();
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: userText }],
		timestamp: now - 3000,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("server-side summarized response", { timestamp: now - 2000 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(usageTokens),
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function lastAssistant(harness: Harness) {
	const messages = harness.session.agent.state.messages;
	const message = messages[messages.length - 1];
	if (message?.role !== "assistant") throw new Error("Expected a seeded assistant message");
	return message;
}

function stubRunAutoCompaction(harness: Harness) {
	const stub = vi.fn(async (_reason: "overflow" | "threshold", _willRetry: boolean): Promise<boolean> => true);
	Reflect.set(harness.session, "_runAutoCompaction", stub);
	return stub;
}

async function checkCompaction(harness: Harness): Promise<void> {
	const checkCompactionFn = Reflect.get(harness.session, "_checkCompaction");
	if (typeof checkCompactionFn !== "function") throw new Error("Expected AgentSession._checkCompaction");
	await checkCompactionFn.call(harness.session, lastAssistant(harness));
}

function getAutoCompactionReason(harness: Harness): "overflow" | "threshold" | undefined {
	const reasonFn = Reflect.get(harness.session, "_getAutoCompactionReason");
	if (typeof reasonFn !== "function") throw new Error("Expected AgentSession._getAutoCompactionReason");
	return reasonFn.call(harness.session, lastAssistant(harness));
}

async function createThresholdHarness(): Promise<Harness> {
	return await createHarness({
		models: [{ id: "faux-cursor-like", contextWindow: 128_000, maxTokens: 1_000 }],
		settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 16_384 } },
	});
}

describe("compaction threshold with small provider usage over a large transcript", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("triggers threshold compaction when the local transcript estimate dwarfs provider usage", async () => {
		const harness = await createThresholdHarness();
		harnesses.push(harness);
		// ~150k estimated tokens of transcript vs a threshold of 111,616; the
		// provider (server-side summarized conversation) reports only 18k.
		seedSession(harness, "x".repeat(600_000), 18_000);

		expect(getAutoCompactionReason(harness)).toBe("threshold");

		const runAutoCompaction = stubRunAutoCompaction(harness);
		await checkCompaction(harness);
		expect(runAutoCompaction).toHaveBeenCalledWith("threshold", false);
	});

	it("does not compact when both provider usage and the transcript estimate sit below the threshold", async () => {
		const harness = await createThresholdHarness();
		harnesses.push(harness);
		seedSession(harness, "short prompt", 18_000);

		expect(getAutoCompactionReason(harness)).toBeUndefined();

		const runAutoCompaction = stubRunAutoCompaction(harness);
		await checkCompaction(harness);
		expect(runAutoCompaction).not.toHaveBeenCalled();
	});

	it("still compacts on provider usage alone when the transcript estimate is small", async () => {
		const harness = await createThresholdHarness();
		harnesses.push(harness);
		seedSession(harness, "short prompt", 120_000);

		expect(getAutoCompactionReason(harness)).toBe("threshold");

		const runAutoCompaction = stubRunAutoCompaction(harness);
		await checkCompaction(harness);
		expect(runAutoCompaction).toHaveBeenCalledWith("threshold", false);
	});
});
