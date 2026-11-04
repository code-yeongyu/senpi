// S18b / S36 (senpi#5728): a session runs model-issued batches on the prepared pipeline, its only pipeline. Its equality
// with the removed scheduler is pinned path by path at the loop boundary (packages/agent prepared-parity, proven against
// that scheduler before its removal); what stays here is session-level only: a batch that repeats a call ID is refused,
// and every call writes one `prepared` receipt.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../suite/harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const echo: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo the arguments back",
	parameters: Type.Object({}, { additionalProperties: true }),
	execute: async (_id, params) => ({ content: [{ type: "text", text: JSON.stringify(params) }], details: {} }),
};

async function turn(ids: readonly string[]) {
	const harness = await createHarness({ tools: [echo] });
	harnesses.push(harness);
	const receipts: string[] = [];
	harness.agent.onExecutionPipeline = (witness) => {
		receipts.push(`${witness.pipeline}:${witness.toolCallId}`);
	};
	harness.setResponses([
		fauxAssistantMessage(
			ids.map((id, index) => ({ ...fauxToolCall("echo", { n: index }), id })),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	let error: string | undefined;
	await harness.session.prompt("go").catch((caught: unknown) => {
		error = caught instanceof Error ? caught.message : String(caught);
	});
	for (const message of harness.session.messages)
		if (message.role === "assistant" && message.errorMessage !== undefined) error ??= message.errorMessage;
	const results = harness.session.messages.flatMap((message) =>
		message.role === "toolResult" ? [message.content] : [],
	);
	return { receipts, results, error };
}

describe("a session's prepared pipeline", () => {
	it("refuses a batch that repeats a call ID instead of silently running one call twice", async () => {
		const { results, error } = await turn(["call-dup", "call-dup"]);

		expect(results).not.toContainEqual([{ type: "text", text: JSON.stringify({ n: 1 }) }]);
		expect(error).toMatch(/duplicate tool call id/);
	});

	it("writes one prepared receipt per call", async () => {
		const { receipts } = await turn(["call-0", "call-1"]);

		expect(receipts).toEqual(["prepared:call-0", "prepared:call-1"]);
	});
});
