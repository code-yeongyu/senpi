// senpi#5349 / code-yeongyu/oh-my-openagent#12096: bash_input is judged before it is written only when the call is plain
// typing. Every other call reaches a program the guard cannot see and is judged where it runs (senpi#5358). The tool
// only records what it was asked to send.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { ExecuteToolError } from "../../src/core/extensions/types.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const killGuard = builtinExtensions.find((extension) => extension.id === "kill-guard")?.factory;
const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function send(params: Record<string, unknown>): Promise<{ blocked: boolean; text: string; sent: number }> {
	if (killGuard === undefined) throw new Error("missing builtin extension: kill-guard");
	let sent = 0;
	const bashInput: AgentTool = {
		name: "bash_input",
		label: "bash_input",
		description: "records bash_input",
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async () => {
			sent += 1;
			return { content: [{ type: "text", text: "sent" }], details: {} };
		},
	};
	const harness = await createHarness({ tools: [bashInput], extensionFactories: [killGuard] });
	harnesses.push(harness);
	await harness.session.bindExtensions({ uiContext: createTestUiContext() });
	try {
		await harness.session.executeTool("bash_input", { bash_id: "b1", ...params });
		return { blocked: false, text: "", sent };
	} catch (error) {
		if (error instanceof ExecuteToolError && error.code === "blocked")
			return { blocked: true, text: error.message, sent };
		throw error;
	}
}

describe("kill guard on bash_input", () => {
	it.each([
		["a submitted kill line", { input: "kill -9 -1" }],
		["a kill line ended by a line break", { input: "kill -9 -1\n", submit: false }],
		["a kill line submitted with an enter key", { input: "kill -9 -1", submit: false, keys: ["enter"] }],
		["a kill line typed with backspaces", { input: "kilk\x7fl -9 -2\b1" }],
		["a kill line after an allowed one", { input: "echo ok\nkill -9 -1\npartial", submit: false }],
	])("refuses %s before it is written", async (_shape, params) => {
		const outcome = await send(params);

		expect(outcome.blocked).toBe(true);
		expect(outcome.text).toContain("[senpi:kill-guard]");
		expect(outcome.sent).toBe(0);
	});

	it.each([
		["a narrow kill line", { input: "kill 4242" }],
		["unsubmitted text", { input: "kill -9 -1", submit: false }],
		["a line edited with ctrl+a", { input: "ill -9 -1\x01k\n", submit: false }],
		["a line edited with Home", { input: "ill -9 -1\x1b[Hk" }],
		["a line completed with tab", { input: "kil\t -9 -1\n", submit: false }],
		["vim's Escape then a command", { input: "\x1b:wq\r", submit: false }],
		["the escape key", { keys: ["escape"] }],
		["ctrl+z", { keys: ["ctrl+z"] }],
		["history recall", { keys: ["up", "enter"] }],
		["history expansion", { input: "!!" }],
		["text with a ctrl+u", { input: "kill -9 -1", submit: false, keys: ["ctrl+u", "enter"] }],
	])("does not refuse %s", async (_shape, params) => {
		const outcome = await send(params);

		expect(outcome).toEqual({ blocked: false, text: "", sent: 1 });
	});
});
