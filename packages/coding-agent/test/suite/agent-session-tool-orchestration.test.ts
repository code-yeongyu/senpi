import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * A tool that calls other tools, built only on the extension API: its own name, exposure, loadout
 * hook, and ctx.executeTool(). Codemode and tool search use the same mechanisms.
 */
function orchestratorExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "echo",
		label: "echo",
		description: "Echo text.",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_id, { text }) => ({ content: [{ type: "text", text: `echo: ${text}` }], details: {} }),
	});
	pi.registerTool({
		name: "helper",
		label: "helper",
		description: "Only reachable from other tools.",
		parameters: Type.Object({}),
		exposure: "codemode",
		execute: async () => ({ content: [{ type: "text", text: "helped" }], details: {} }),
	});
	pi.registerTool({
		name: "run_tools",
		label: "run_tools",
		description: "Runs tools.",
		parameters: Type.Object({}),
		exposure: "model-only",
		// The fork types prepareLoadout but does not wire it (D-2), so the loadout hook is not exercised here.
		execute: async (_id, _params, _signal, _onUpdate, ctx) => {
			const helper = await ctx.executeTool("helper", {});
			const echo = await ctx.executeTool("echo", { text: "hi" });
			const self = await ctx.executeTool("run_tools", {});
			const text = [helper, echo, self]
				.map((outcome) => (outcome.result.content[0] as { text: string }).text)
				.join(" | ");
			return { content: [{ type: "text", text }], details: {} };
		},
	});
}

describe("AgentSession tool orchestration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("supports tools that call other tools under any name through the extension API", async () => {
		const toolCalls: string[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				orchestratorExtension,
				(pi) => {
					pi.on("tool_call", (event) => {
						toolCalls.push(`${event.toolName}:${event.parentToolCallId ?? "top"}`);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		// The fork maps the "codemode" exposure alias to eval exposure, which stays active (C-EX-1).
		expect(harness.session.getActiveToolNames()).toEqual(["echo", "helper", "run_tools"]);
		// The fork's bash/powershell/grep builtins carry eval exposure, so they are callable too;
		// the model-only run_tools is not.
		expect(harness.session.getCallableToolNames()).toEqual(["bash", "powershell", "grep", "echo", "helper"]);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("run_tools", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		const result = harness.session.messages.find(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		if (!result) throw new Error("No tool result");
		expect(result.content).toEqual([{ type: "text", text: "helped | echo: hi | Tool run_tools not found" }]);
		const parent = result.toolCallId;
		expect(toolCalls).toEqual(["run_tools:top", `helper:${parent}`, `echo:${parent}`]);
		expect(result.nestedCalls?.calls.map((call) => [call.id, call.name, call.status])).toEqual([
			[`${parent}/1`, "helper", "ok"],
			[`${parent}/2`, "echo", "ok"],
			[`${parent}/3`, "run_tools", "error"],
		]);
		// The record is persisted with the session.
		const persisted = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(persisted?.type === "message" && persisted.message).toMatchObject({ nestedCalls: result.nestedCalls });
	});

	it("leaves results without nested calls unchanged", async () => {
		const harness = await createHarness({ initialActiveToolNames: [], extensionFactories: [orchestratorExtension] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expect(result && "nestedCalls" in result).toBe(false);
	});
});
