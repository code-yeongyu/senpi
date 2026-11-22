import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import permissionSystemExtension from "../../../src/core/extensions/builtin/permission-system/index.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

function recordingBash(executed: string[]): AgentTool {
	return {
		name: "bash",
		label: "Bash",
		description: "Execute bash commands",
		parameters: Type.Object({ command: Type.String() }),
		execute: async (_toolCallId, params) => {
			const command = String((params as { command: string }).command);
			executed.push(command);
			return { content: [{ type: "text", text: `Executed: ${command}` }], details: {} };
		},
	};
}

it("asks again for a chained command after Allow always on its first command (senpi#4309)", async () => {
	const executed: string[] = [];
	const prompts: string[] = [];
	const answers = ["Allow always", "Deny"];
	const harness = await createHarness({
		tools: [recordingBash(executed)],
		extensionFlagValues: new Map([["permission-preset", "accept-edits"]]),
		extensionFactories: [permissionSystemExtension],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({
		uiContext: createTestUiContext({
			select: async (title: string) => {
				prompts.push(title);
				return answers[prompts.length - 1];
			},
		}),
	});
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "cd src" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("bash", { command: "cd src && rm -rf build" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);

	await harness.session.prompt("tidy up");

	expect(executed).toEqual(["cd src"]);
	expect(prompts).toHaveLength(2);
	expect(prompts[1]).toContain("rm");
});
