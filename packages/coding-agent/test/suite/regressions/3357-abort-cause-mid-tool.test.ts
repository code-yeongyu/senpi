import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAbortCause } from "../../../src/core/agent-session.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#3357: a replacement that lands while a tool runs still names itself on that run's agent_end.

const CAUSE: AgentAbortCause = { kind: "session_replaced", reason: "new", targetSessionId: "s-next" };

describe("abortCause on a run stopped mid-tool (senpi#3357)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("carries the cause when the abort lands during tool execution", async () => {
		const blocking: AgentTool = {
			name: "block",
			label: "Block",
			description: "Block until aborted",
			parameters: Type.Object({}),
			execute: (_id, _params, signal) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		};
		const harness = await createHarness({ tools: [blocking] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage([fauxToolCall("block", {})], { stopReason: "toolUse" })]);
		const ends: Array<{ abortCause?: AgentAbortCause }> = [];
		const toolStarted = Promise.withResolvers<void>();
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start") toolStarted.resolve();
			if (event.type === "agent_end") ends.push(event);
		});
		const run = harness.session.prompt("start");
		await toolStarted.promise;

		await harness.session.abort({ cause: CAUSE });
		await run;

		expect(ends).toHaveLength(1);
		expect(ends[0]?.abortCause).toStrictEqual(CAUSE);
	});
});
