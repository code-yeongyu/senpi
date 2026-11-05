import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createQaToolFixture } from "../fixtures/qa-tool/qa-tool-fixture.ts";
import { createHarness, getMessageText, type Harness } from "../suite/harness.ts";

// G1 (plan P0-02a): today's full preparation and handler order for one tool call, pinned once per path.
const ORDER_ONCE = ["activate", "shim", "hook1", "pre", "hook2", "body(42)"];

type QaFixture = ReturnType<typeof createQaToolFixture>;
const opened: Array<{ harness: Harness; fixture: QaFixture }> = [];

afterEach(() => {
	for (const { harness, fixture } of opened.splice(0)) {
		harness.cleanup();
		fixture.cleanup();
	}
});

async function openQaSession(): Promise<{ harness: Harness; fixture: QaFixture }> {
	const fixture = createQaToolFixture();
	const harness = await createHarness({ extensionFactories: fixture.extensionFactories });
	opened.push({ harness, fixture });
	fixture.trustPreToolUseHook(harness.tempDir);
	harness.session.setActiveToolsByName(["read"]);
	expect(harness.session.getActiveToolNames()).not.toContain("qa");
	return { harness, fixture };
}

function toolCallArguments(harness: Harness): unknown[] {
	return harness.session.messages
		.filter((message): message is AssistantMessage => message.role === "assistant")
		.flatMap((message) => message.content.filter((part): part is ToolCall => part.type === "toolCall"))
		.map((part) => part.arguments);
}

function toolResults(harness: Harness): ToolResultMessage[] {
	return harness.session.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

describe("G1: tool preparation and handler order, once", () => {
	it("runs activate, shim, hook1, shell PreToolUse, hook2, body once for a model tool call", async () => {
		// Given
		const { harness, fixture } = await openQaSession();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("qa", { legacy: "42" }, { id: "g1-model" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		// When
		await harness.session.prompt("run qa");

		// Then
		expect(fixture.readTrace()).toEqual(ORDER_ONCE);
		expect(fixture.handlerValueTypes).toEqual(["number", "number"]);
		expect(fixture.readPreToolUseStdin()).toMatchObject({
			hook_event_name: "PreToolUse",
			tool_name: "qa",
			tool_input: { value: 42 },
			tool_use_id: "g1-model",
		});
		expect(toolCallArguments(harness)).toEqual([{ legacy: "42" }]);
		const [result] = toolResults(harness);
		expect(result?.isError).toBe(false);
		expect(getMessageText(result)).toBe("qa:42");
	});

	it("runs the same order once through pi.executeTool with activation opt-in", async () => {
		// Given
		const { harness, fixture } = await openQaSession();
		const params = { legacy: "42" };

		// When
		const result = await fixture.api().executeTool("qa", params, { activateInactiveTool: true });

		// Then
		expect(fixture.readTrace()).toEqual(ORDER_ONCE);
		expect(fixture.handlerValueTypes).toEqual(["number", "number"]);
		expect(fixture.readPreToolUseStdin()).toMatchObject({ tool_name: "qa", tool_input: { value: 42 } });
		expect(params).toEqual({ legacy: "42" });
		expect(getMessageText(result)).toBe("qa:42");
		expect(harness.session.getActiveToolNames()).toContain("qa");
	});

	it("runs no handler, hook, or body when the shim's output fails validation", async () => {
		// Given
		const { harness, fixture } = await openQaSession();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("qa", { value: "bad" }, { id: "g1-invalid" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		// When
		await harness.session.prompt("run qa");

		// Then
		expect(fixture.readTrace()).toEqual(["activate", "shim"]);
		expect(fixture.handlerValueTypes).toEqual([]);
		expect(toolCallArguments(harness)).toEqual([{ value: "bad" }]);
		const [result] = toolResults(harness);
		expect(result?.isError).toBe(true);
	});
});
