import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) {
		harness.cleanup();
	}
});

function toolResultTexts(harness: Harness, toolName: string): string[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message)
		.filter((message): message is typeof message & { role: "toolResult"; toolName: string } => {
			const candidate = message as { role?: string; toolName?: string };
			return candidate.role === "toolResult" && candidate.toolName === toolName;
		})
		.map((message) => getMessageText(message));
}

function goalContinuationEntries(harness: Harness) {
	return harness.sessionManager.getEntries().filter((entry) => {
		return entry.type === "custom_message" && entry.customType === "goal-continuation";
	});
}

describe("goal extension end-to-end through the real AgentSession", () => {
	it("registers, creates, and completes a goal through real tool execution (budget-free)", async () => {
		const harness = await createHarness({ extensionFactories: [goalExtension] });
		harnesses.push(harness);

		expect(harness.session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["create_goal", "update_goal", "get_goal"]),
		);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("create_goal", { objective: "Ship the goal builtin" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("goal achieved"),
		]);
		await harness.session.prompt("set the goal and finish it");

		const createResults = toolResultTexts(harness, "create_goal");
		expect(createResults).toHaveLength(1);
		const created = JSON.parse(createResults[0] ?? "{}");
		expect(created.goal).toMatchObject({ objective: "Ship the goal builtin", status: "active" });
		expect(created.goal).not.toHaveProperty("tokenBudget");
		expect(createResults[0]?.toLowerCase()).not.toContain("budget");

		const updateResults = toolResultTexts(harness, "update_goal");
		expect(updateResults).toHaveLength(1);
		expect(JSON.parse(updateResults[0] ?? "{}").goal).toMatchObject({ status: "complete" });
	}, 20_000);

	it("does not queue another hidden continuation after aborting a retrying goal turn", async () => {
		const harness = await createHarness({
			extensionFactories: [goalExtension],
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "overloaded_error",
			}),
		]);
		const retryEnded = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					void harness.session.abort();
				}
				if (event.type === "auto_retry_end") {
					unsubscribe();
					resolve();
				}
			});
		});

		await harness.session.prompt("/goal keep working until explicitly stopped");
		await retryEnded;

		expect(goalContinuationEntries(harness)).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_end")).toEqual([
			expect.objectContaining({ success: false, finalError: "Retry cancelled" }),
		]);
		expect(harness.session.retryAttempt).toBe(0);
		expect(harness.session.isRetrying).toBe(false);
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.faux.state.callCount).toBe(1);
	}, 20_000);

	it("does not queue another hidden continuation after aborting during goal tool execution", async () => {
		let toolStarted: () => void = () => {};
		let releaseToolExecution: () => void = () => {};
		const waitForToolStart = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait until the test releases the tool",
			parameters: Type.Object({}),
			execute: async () => {
				toolStarted();
				await toolRelease;
				return { content: [{ type: "text", text: "waited" }], details: {} };
			},
		};
		const harness = await createHarness({
			extensionFactories: [goalExtension],
			tools: [waitTool],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("should not run after abort"),
		]);

		const promptPromise = harness.session.prompt("/goal keep working until explicitly stopped");
		await waitForToolStart;
		const continuationCountBeforeAbort = goalContinuationEntries(harness).length;
		const abortPromise = harness.session.abort();
		releaseToolExecution();
		await Promise.all([promptPromise, abortPromise]);

		expect(goalContinuationEntries(harness)).toHaveLength(continuationCountBeforeAbort);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.isStreaming).toBe(false);
	}, 20_000);
});
