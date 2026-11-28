import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequiredCompactionError } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * code-yeongyu/senpi#2073: the blocked-admission latch armed by an insufficient
 * compaction survived a revert to a wider-window model. The latch only compared
 * its armed content-token snapshot against the current context, so a model whose
 * window the unchanged context fits kept every extension-sourced prompt refused
 * with RequiredCompactionError and zero provider calls, while a person's prompt
 * was released unconditionally. The latch must resolve against the model
 * actually in force at admission and persist only while that model still cannot
 * fit the content (the #7921 automation behavior).
 */

function privateMethod(session: Harness["session"], name: string): (...args: unknown[]) => unknown {
	const method: unknown = Reflect.get(session, name);
	if (typeof method !== "function") throw new Error(`Expected AgentSession.${name}`);
	return method.bind(session);
}

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

/**
 * A session on the 20k `faux-narrow` model whose deterministic compaction
 * rejection armed `_blockedPostCompactionAssistant`, with a wider `faux-wide`
 * (400k) and an equally narrow `faux-narrow-2` registered for later switches.
 */
async function createLatchedNarrowHarness(): Promise<{
	harness: Harness;
	liveAssistant: AssistantMessage;
	attempts: () => number;
}> {
	let attempts = 0;
	const harness = await createHarness({
		models: [
			{ id: "faux-narrow", contextWindow: 20_000, maxTokens: 4_096 },
			{ id: "faux-narrow-2", contextWindow: 20_000, maxTokens: 4_096 },
			{ id: "faux-wide", contextWindow: 400_000, maxTokens: 8_192 },
		],
		settings: {
			compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1, speculativeEnabled: false },
		},
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", () => {
					attempts++;
					return { cancel: true, reason: "summary unavailable" };
				});
			},
		],
	});
	const timestamp = Date.now() - 1_000;
	harness.sessionManager.appendMessage({ role: "user", content: "old work", timestamp });
	const first = harness.sessionManager.getEntries()[0];
	if (!first) throw new Error("Expected a seeded entry");
	harness.sessionManager.appendCompaction("prior summary", first.id, 19_000);
	harness.sessionManager.appendMessage({ role: "user", content: "x".repeat(80_000), timestamp });
	const model = harness.getModel();
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("progress", { timestamp }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(19_500),
	};
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	const liveAssistant = harness.session.agent.state.messages.at(-1);
	if (liveAssistant?.role !== "assistant") throw new Error("Expected the live assistant response");
	await privateMethod(harness.session, "_checkCompaction")(liveAssistant, true);
	expect(attempts).toBe(1);
	expect(Reflect.get(harness.session, "_blockedPostCompactionAssistant")).toBeDefined();
	return { harness, liveAssistant, attempts: () => attempts };
}

/**
 * A single-model session whose latch armed on provider-reported usage while the
 * local content estimate stays small: the messages total a few hundred tokens
 * by the byte-derived estimate, but the assistant usage (19.5k of a 20k window)
 * drove the threshold arming. No model change ever happens.
 */
async function createUsageDrivenLatchHarness(): Promise<{ harness: Harness; attempts: () => number }> {
	let attempts = 0;
	const harness = await createHarness({
		models: [{ id: "faux-narrow", contextWindow: 20_000, maxTokens: 4_096 }],
		settings: {
			compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1, speculativeEnabled: false },
		},
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", () => {
					attempts++;
					return { cancel: true, reason: "summary unavailable" };
				});
			},
		],
	});
	const timestamp = Date.now() - 1_000;
	harness.sessionManager.appendMessage({ role: "user", content: "old work", timestamp });
	const first = harness.sessionManager.getEntries()[0];
	if (!first) throw new Error("Expected a seeded entry");
	harness.sessionManager.appendCompaction("prior summary", first.id, 19_000);
	harness.sessionManager.appendMessage({ role: "user", content: "small follow-up", timestamp });
	const model = harness.getModel();
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("progress", { timestamp }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(19_500),
	};
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	const liveAssistant = harness.session.agent.state.messages.at(-1);
	if (liveAssistant?.role !== "assistant") throw new Error("Expected the live assistant response");
	await privateMethod(harness.session, "_checkCompaction")(liveAssistant, true);
	expect(attempts).toBe(1);
	expect(Reflect.get(harness.session, "_blockedPostCompactionAssistant")).toBeDefined();
	return { harness, attempts: () => attempts };
}

describe("#2073: the blocked-admission latch resolves against the model in force", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("admits an extension prompt after a revert to a model whose window fits the context", async () => {
		const { harness, attempts } = await createLatchedNarrowHarness();
		harnesses.push(harness);

		const wide = harness.getModel("faux-wide");
		if (!wide) throw new Error("Expected the wide model to be registered");
		await harness.session.setModel(wide);

		harness.setResponses([fauxAssistantMessage("answered the automated nudge")]);
		await expect(harness.session.prompt("automated nudge", { source: "extension" })).resolves.toBeUndefined();
		expect(harness.faux.state.callCount).toBe(1);
		expect(attempts()).toBe(1);

		// The latch is stale evidence about the 20k model; admission released it
		// once the 400k window came into force, so automation was not refused.
		expect(Reflect.get(harness.session, "_blockedPostCompactionAssistant")).toBeUndefined();
	});

	it("keeps the latch across a switch to another model with the same window (#7921)", async () => {
		const { harness, attempts } = await createLatchedNarrowHarness();
		harnesses.push(harness);

		const narrow = harness.getModel("faux-narrow-2");
		if (!narrow) throw new Error("Expected the second narrow model to be registered");
		await harness.session.setModel(narrow);

		// The context is unchanged and still over the 20k budget of the model now
		// in force, so the automation latch must persist.
		expect(Reflect.get(harness.session, "_blockedPostCompactionAssistant")).toBeDefined();
		await expect(harness.session.prompt("automated nudge", { source: "extension" })).rejects.toBeInstanceOf(
			RequiredCompactionError,
		);
		expect(attempts()).toBe(1);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("keeps the latch when only provider usage, not local content, exceeds the budget", async () => {
		const { harness, attempts } = await createUsageDrivenLatchHarness();
		harnesses.push(harness);

		// No model change: the model in force is the one whose provider reported
		// 19.5k used of a 20k window. A small local byte-estimate is not evidence
		// the armed context fits; re-sending it must stay refused.
		harness.setResponses([fauxAssistantMessage("answered the automated nudge")]);
		await expect(harness.session.prompt("automated nudge", { source: "extension" })).rejects.toBeInstanceOf(
			RequiredCompactionError,
		);
		expect(attempts()).toBe(1);
		expect(harness.faux.state.callCount).toBe(0);
		expect(Reflect.get(harness.session, "_blockedPostCompactionAssistant")).toBeDefined();
	});
});
