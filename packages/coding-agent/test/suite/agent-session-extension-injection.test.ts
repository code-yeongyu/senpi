import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

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

const COMPACTION_REJECTION = "Context remains above the compaction threshold because compaction did not complete";

async function createCompactionGatedHarness(gate: { reject: boolean }): Promise<Harness> {
	const harness = await createHarness({
		models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1_000 }],
		settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => {
					if (gate.reject) {
						return {
							cancel: true,
							rejectionCause: "cancelled-by-extension",
							reason: "forced rejection",
						};
					}
					return {
						compaction: {
							summary: "recovered summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				});
			},
		],
	});

	const now = Date.now();
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "earlier prompt" }],
		timestamp: now - 3000,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("earlier response", { timestamp: now - 2000 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(50),
	});
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "previous prompt" }],
		timestamp: now - 1000,
	});
	const overflowAssistant: AssistantMessage = {
		...fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "context_length_exceeded",
			timestamp: now - 500,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(100),
	};
	harness.sessionManager.appendMessage(overflowAssistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return harness;
}

describe("AgentSession extension injection retention", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("retains a followUp injection when the prompt path rejects, and delivers it after recovery", async () => {
		const gate = { reject: true };
		const harness = await createCompactionGatedHarness(gate);
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not reach provider yet")]);

		await expect(harness.session.sendUserMessage("lead-brief-c62b6acb", { deliverAs: "followUp" })).rejects.toThrow(
			COMPACTION_REJECTION,
		);
		expect(harness.faux.state.callCount).toBe(0);

		expect(harness.session.getFollowUpMessages()).toContain("lead-brief-c62b6acb");

		gate.reject = false;
		harness.setResponses([fauxAssistantMessage("compacted reply"), fauxAssistantMessage("followup reply")]);
		await expect(harness.session.prompt("next prompt")).resolves.toBeUndefined();

		const userTexts = getUserTexts(harness);
		expect(userTexts).toContain("next prompt");
		expect(userTexts.filter((text) => text.includes("lead-brief-c62b6acb"))).toHaveLength(1);
		expect(harness.session.getFollowUpMessages()).toHaveLength(0);
	});

	it("retains a steer injection when the prompt path rejects, and delivers it after recovery", async () => {
		const gate = { reject: true };
		const harness = await createCompactionGatedHarness(gate);
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not reach provider yet")]);

		await expect(harness.session.sendUserMessage("steer-brief-32e080cf", { deliverAs: "steer" })).rejects.toThrow(
			COMPACTION_REJECTION,
		);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.getSteeringMessages()).toContain("steer-brief-32e080cf");

		gate.reject = false;
		harness.setResponses([fauxAssistantMessage("steered reply")]);
		await expect(harness.session.prompt("next prompt")).resolves.toBeUndefined();

		const userTexts = getUserTexts(harness);
		expect(userTexts.filter((text) => text.includes("steer-brief-32e080cf"))).toHaveLength(1);
		expect(harness.session.getSteeringMessages()).toHaveLength(0);
	});

	it("does not double-queue a followUp that the streaming path already accepted", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("tool done"),
			fauxAssistantMessage("queued followup reply"),
		]);

		const waitForToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});
		const promptPromise = harness.session.prompt("start");
		await waitForToolStart;

		await expect(harness.session.sendUserMessage("queued-brief", { deliverAs: "followUp" })).resolves.toBeUndefined();
		expect(harness.session.getFollowUpMessages()).toEqual(["queued-brief"]);

		releaseToolExecution?.();
		await promptPromise;

		const userTexts = getUserTexts(harness);
		expect(userTexts.filter((text) => text.includes("queued-brief"))).toHaveLength(1);
		expect(harness.session.getFollowUpMessages()).toHaveLength(0);
	});
});
