import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { loadExtensions } from "../../src/core/extensions/loader.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "../suite/harness.ts";
import { createTestResourceLoader } from "../utilities.ts";

const fixturePath = fileURLToPath(new URL("../fixtures/closure-ext/index.ts", import.meta.url));

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

type Placement = "ui-bound" | "headless";

interface ClosureTrace {
	bodyInputs: unknown[];
	resultDetails: unknown;
	providerClosureLines: string[];
	toolLifecycle: string[];
}

const LIFECYCLE_EVENTS = new Set(["agent_start", "turn_start", "tool_hook_status", "turn_end", "agent_end"]);

function toolLifecycle(harness: Harness): string[] {
	return harness.events.flatMap((event) => {
		if (event.type === "tool_execution_start") return [`tool_execution_start ${event.toolName}`];
		if (event.type === "tool_execution_end") {
			return [`tool_execution_end ${event.toolName} details=${JSON.stringify(event.result.details)}`];
		}
		return LIFECYCLE_EVENTS.has(event.type) ? [event.type] : [];
	});
}

function closureLine(systemPrompt: string): string {
	return systemPrompt.split("\n").find((line) => line.startsWith("closure-ext ")) ?? "<missing>";
}

async function runTwoTurns(placement: Placement): Promise<ClosureTrace> {
	const bodyInputs: unknown[] = [];
	const echoTool: AgentTool = {
		name: "echo",
		label: "Echo",
		description: "Echo the arguments back",
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async (_toolCallId, params) => {
			bodyInputs.push(structuredClone(params));
			return { content: [{ type: "text", text: JSON.stringify(params) }], details: { echoed: params } };
		},
	};
	const extensionsResult = await loadExtensions([fixturePath], process.cwd());
	expect(extensionsResult.errors).toEqual([]);
	const harness = await createHarness({
		tools: [echoTool],
		resourceLoader: createTestResourceLoader({ extensionsResult }),
	});
	harnesses.push(harness);
	await harness.session.bindExtensions(
		placement === "ui-bound" ? { mode: "rpc", uiContext: createTestUiContext(), shutdownHandler: () => {} } : {},
	);

	const providerClosureLines: string[] = [];
	harness.setResponses([
		(context) => {
			providerClosureLines.push(closureLine(getCurrentSystemPrompt(context.messages)));
			return fauxAssistantMessage([fauxToolCall("echo", { n: 0 })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage("turn one done"),
		(context) => {
			providerClosureLines.push(closureLine(getCurrentSystemPrompt(context.messages)));
			return fauxAssistantMessage("turn two done");
		},
	]);
	await harness.session.prompt("call echo");
	const resultDetails = getToolResult(harness, "echo").details;
	await harness.session.prompt("what did the tool see?");

	return {
		bodyInputs,
		resultDetails,
		providerClosureLines,
		toolLifecycle: toolLifecycle(harness),
	};
}

describe("G5: one unmodified extension shares one closure across loop and tool events", () => {
	it.each(["ui-bound", "headless"] as const)(
		"%s: before_agent_start, tool_call and tool_result see and write the same state",
		async (placement) => {
			// Given the unmodified closure-ext fixture loaded by path.
			// When turn one calls echo({ n: 0 }) once and turn two only answers.
			const trace = await runTwoTurns(placement);

			// Then the tool_call patch carries turn one's counter into the body,
			// the tool_result details carry the same counter,
			expect(trace.bodyInputs).toEqual([{ n: 1 }]);
			expect(trace.resultDetails).toEqual({ n: 1 });
			// and turn two's provider request reads the state turn one's tool_result wrote.
			expect(trace.providerClosureLines).toEqual([
				"closure-ext turn=1 lastResultN=none",
				"closure-ext turn=2 lastResultN=1",
			]);
		},
	);

	it("produces the same trace UI-bound and headless", async () => {
		const uiBound = await runTwoTurns("ui-bound");
		const headless = await runTwoTurns("headless");

		expect(headless).toEqual(uiBound);
	});
});
