import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { wrapStreamWithInvokeRecovery } from "../../src/index.ts";
import type { AssistantMessage, Tool, ToolCall } from "../../src/types.ts";
import { bashTool, terminal, toolEvents } from "./invoke-recovery-scenario-fixtures.ts";
import { collectEvents, TextStreamHarness } from "./invoke-recovery-stream-fixtures.ts";

// Upstream gateways disguise tool names on the wire: ccapi-cf pascal-cases
// `todo` -> `Todo`, and CC-pool layers expose non-native tools as
// `mcp_<hash>-<Name>` (e.g. `mcp_49f0-Todo`). Reverse mapping only covers
// native tool_use blocks, so a leaked text invoke keeps the wire alias and the
// recovery resolver must still recognize the registered tool behind it.

const todoTool = {
	name: "todo",
	description: "Manage todos",
	parameters: Type.Object({
		op: Type.String(),
		task: Type.Optional(Type.String()),
	}),
} satisfies Tool;

const taskSendTool = {
	name: "task_send",
	description: "Send to a task",
	parameters: Type.Object({ to: Type.String() }),
} satisfies Tool;

const todoTwinTool = {
	name: "to_do",
	description: "Ambiguous twin of todo",
	parameters: Type.Object({ op: Type.String() }),
} satisfies Tool;

// Exact bytes captured from session 01a01381 event 1214 (ccapi-clb claude-opus-5),
// including the stray `count` text prefix the model emitted before the invoke.
const leakedTodoInvoke =
	'count\n<invoke name="mcp_49f0-Todo">\n<parameter name="op">done</parameter>\n<parameter name="task">Review loop until mergeable</parameter>\n</invoke>';

async function runLeak(input: string, tools: readonly Tool[]) {
	const producer = new TextStreamHarness();
	const wrapped = wrapStreamWithInvokeRecovery(producer.inner, tools);
	producer.start();
	producer.delta(input);
	producer.finish();
	const events = await collectEvents(wrapped);
	return { events, result: await wrapped.result() };
}

function callBlocks(result: AssistantMessage): ToolCall[] {
	const calls: ToolCall[] = [];
	for (const block of result.content) {
		if (block.type === "toolCall") calls.push(block);
	}
	return calls;
}

function textContent(result: AssistantMessage): string {
	let text = "";
	for (const block of result.content) {
		if (block.type === "text") text += block.text;
	}
	return text;
}

describe("invoke recovery with upstream wire-aliased tool names", () => {
	it("recovers the exact ccapi-clb leak: mcp_49f0-Todo -> todo", async () => {
		const { events, result } = await runLeak(leakedTodoInvoke, [todoTool]);
		const calls = callBlocks(result);
		expect(calls, textContent(result)).toHaveLength(1);
		expect(calls[0]?.name).toBe("todo");
		expect(calls[0]?.arguments).toEqual({ op: "done", task: "Review loop until mergeable" });
		expect(toolEvents(events)).toHaveLength(3);
		expect(textContent(result)).toBe("count\n");
		expect(terminal(events)[0]?.type).toBe("done");
	});

	it("resolves hash-variant prefixes, bare pascal aliases, and CC-SDK MCP names", async () => {
		const cases: Array<[string, string, readonly Tool[]]> = [
			['<invoke name="mcp_deadbeef-Todo"><parameter name="op">done</parameter></invoke>', "todo", [todoTool]],
			['<invoke name="Todo"><parameter name="op">done</parameter></invoke>', "todo", [todoTool]],
			['<invoke name="TaskSend"><parameter name="to">st_1</parameter></invoke>', "task_send", [taskSendTool]],
			[
				'<invoke name="mcp_49f0-TaskSend"><parameter name="to">st_1</parameter></invoke>',
				"task_send",
				[taskSendTool],
			],
			['<invoke name="mcp__custom-tools__todo"><parameter name="op">done</parameter></invoke>', "todo", [todoTool]],
		];
		for (const [input, expected, tools] of cases) {
			const { result } = await runLeak(input, tools);
			const calls = callBlocks(result);
			expect(calls, `alias case ${input}`).toHaveLength(1);
			expect(calls[0]?.name, `alias case ${input}`).toBe(expected);
		}
	});

	it("keeps hallucinated and ambiguous names as literal text", async () => {
		const unknown = await runLeak(
			'<invoke name="mcp_49f0-DoesNotExist"><parameter name="op">done</parameter></invoke>',
			[todoTool],
		);
		expect(callBlocks(unknown.result)).toHaveLength(0);
		expect(textContent(unknown.result)).toContain("mcp_49f0-DoesNotExist");

		const sendTwinTool = { ...taskSendTool, name: "tasksend" } satisfies Tool;
		const ambiguous = await runLeak('<invoke name="mcp_1-TaskSend"><parameter name="to">st_1</parameter></invoke>', [
			taskSendTool,
			sendTwinTool,
		]);
		expect(callBlocks(ambiguous.result)).toHaveLength(0);
		expect(textContent(ambiguous.result)).toContain('name="mcp_1-TaskSend"');

		const exact = await runLeak('<invoke name="todo"><parameter name="op">done</parameter></invoke>', [
			todoTool,
			todoTwinTool,
		]);
		const exactCalls = callBlocks(exact.result);
		expect(exactCalls).toHaveLength(1);
		expect(exactCalls[0]?.name).toBe("todo");
	});

	it("preserves the classic exact-name recovery path", async () => {
		const { result } = await runLeak('<invoke name="Bash"><parameter name="command">echo hi</parameter></invoke>', [
			bashTool,
		]);
		const calls = callBlocks(result);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("Bash");
	});
});
