import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
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
});
