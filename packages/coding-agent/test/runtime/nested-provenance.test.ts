// senpi#5234 (RT8, brain/hand split): a nested tool call carries the issuing assistant message of the model-issued
// call it descends from, so a host without a transcript can run it. Guards the F22 nested executeTool surface.
import type { AgentToolCall, AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { NestedToolCallRunner, rootToolCallId } from "../../src/core/nested-tool-calls.ts";

const issuer = {
	role: "assistant",
	content: [{ type: "toolCall", id: "call-1", name: "outer", arguments: {} }],
} as unknown as AssistantMessage;

interface Seen {
	id: string;
	parentToolCallId: string;
	issuedBy: AssistantMessage | undefined;
}

function hostWithoutTranscript(issuers: ReadonlyMap<string, AssistantMessage>) {
	const seen: Seen[] = [];
	let runner: NestedToolCallRunner;
	runner = new NestedToolCallRunner({
		getTools: () => [],
		isSequential: () => false,
		issuerOf: (toolCallId) => issuers.get(toolCallId),
		runToolCall: async (toolCall: AgentToolCall, parentToolCallId, _signal, _onUpdate, issuedBy) => {
			seen.push({ id: toolCall.id, parentToolCallId, issuedBy });
			if (toolCall.name === "middle") await runner.execute(toolCall.id, "inner", {});
			return {
				toolCall,
				result: { content: [{ type: "text", text: toolCall.name }], details: {} },
				isError: false,
			} satisfies AgentToolCallOutcome;
		},
		emit: async () => {},
	});
	return { runner, seen };
}

describe("nested tool call provenance (senpi#5234)", () => {
	it("names the model-issued call a nested call descends from", () => {
		expect(rootToolCallId("call-1")).toBe("call-1");
		expect(rootToolCallId("call-1/2")).toBe("call-1");
		expect(rootToolCallId("call-1/2/1")).toBe("call-1");
	});

	it("gives a nested call, and a nested call of it, the root call's issuing message", async () => {
		const { runner, seen } = hostWithoutTranscript(new Map([["call-1", issuer]]));

		await runner.execute("call-1", "middle", {});

		expect(seen).toEqual([
			{ id: "call-1/1", parentToolCallId: "call-1", issuedBy: issuer },
			{ id: "call-1/1/1", parentToolCallId: "call-1/1", issuedBy: issuer },
		]);
	});

	it("passes no issuer when the root call has none recorded", async () => {
		const { runner, seen } = hostWithoutTranscript(new Map());

		await runner.execute("call-9", "leaf", {});

		expect(seen).toEqual([{ id: "call-9/1", parentToolCallId: "call-9", issuedBy: undefined }]);
	});
});
