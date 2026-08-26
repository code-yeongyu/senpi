import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createCursorExecBridge } from "../src/core/cursor-exec-bridge.ts";

function stubTool(
	name: string,
	parameters: ReturnType<typeof Type.Object>,
	execute: (toolCallId: string, params: unknown) => void,
): AgentTool {
	return {
		name,
		label: name,
		description: `stub ${name}`,
		parameters,
		execute: async (toolCallId, params, _signal, _onUpdate) => {
			execute(toolCallId, params);
			return { content: [{ type: "text", text: `${name} ok` }], details: { ran: name } };
		},
	} as AgentTool;
}

function makeBridge(tools: AgentTool[], events: AgentEvent[] = []) {
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const runSignal = new AbortController().signal;
	return createCursorExecBridge({
		getTool: (name) => byName.get(name),
		getAbortSignal: () => runSignal,
		emitEvent: async (event) => {
			events.push(event);
		},
	});
}

function asToolResult(value: unknown): ToolResultMessage {
	expect(value).toMatchObject({ role: "toolResult" });
	return value as ToolResultMessage;
}

describe("cursor exec bridge", () => {
	it("maps legacy read frames onto the read tool", async () => {
		const execute = vi.fn();
		const bridge = makeBridge([
			stubTool(
				"read",
				Type.Object({
					path: Type.String(),
					offset: Type.Optional(Type.Number()),
					limit: Type.Optional(Type.Number()),
				}),
				execute,
			),
		]);

		const result = asToolResult(
			await bridge.read?.({ path: "src/a.ts", toolCallId: "call-1", offset: 2, limit: 5 } as never),
		);
		expect(execute).toHaveBeenCalledWith("call-1", { path: "src/a.ts", offset: 2, limit: 5 });
		expect(result.isError).toBe(false);
		expect(result.toolName).toBe("read");
	});

	it("composes the working directory onto shell commands", async () => {
		const execute = vi.fn();
		const bridge = makeBridge([
			stubTool("bash", Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }), execute),
		]);

		await bridge.shell?.({
			command: "npm test",
			workingDirectory: "/repo/sub dir",
			timeout: 30,
			toolCallId: "call-2",
		} as never);
		expect(execute).toHaveBeenCalledWith("call-2", {
			command: "cd '/repo/sub dir' && { npm test\n}",
			timeout: 30,
		});
	});

	it("maps pi edit frames onto the edit tool's edits array", async () => {
		const execute = vi.fn();
		const bridge = makeBridge([
			stubTool(
				"edit",
				Type.Object({
					path: Type.String(),
					edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
				}),
				execute,
			),
		]);

		await bridge.piEdit?.({
			toolCallId: "call-3",
			args: {
				path: "src/b.ts",
				edits: [
					{ oldText: "foo", newText: "bar" },
					{ oldText: "baz", newText: "qux" },
				],
			},
		} as never);
		expect(execute).toHaveBeenCalledWith("call-3", {
			path: "src/b.ts",
			edits: [
				{ oldText: "foo", newText: "bar" },
				{ oldText: "baz", newText: "qux" },
			],
		});
	});

	it("maps pi grep flags onto the grep tool", async () => {
		const execute = vi.fn();
		const bridge = makeBridge([
			stubTool(
				"grep",
				Type.Object({
					pattern: Type.String(),
					path: Type.Optional(Type.String()),
					glob: Type.Optional(Type.String()),
					ignoreCase: Type.Optional(Type.Boolean()),
					literal: Type.Optional(Type.Boolean()),
					context: Type.Optional(Type.Number()),
					limit: Type.Optional(Type.Number()),
				}),
				execute,
			),
		]);

		await bridge.piGrep?.({
			toolCallId: "call-4",
			args: { pattern: "needle", glob: "*.ts", ignoreCase: true, literal: true, limit: 3 },
		} as never);
		expect(execute).toHaveBeenCalledWith("call-4", {
			pattern: "needle",
			glob: "*.ts",
			ignoreCase: true,
			literal: true,
			limit: 3,
		});
	});

	it("answers a zero-line pi read with empty output without running the tool", async () => {
		const execute = vi.fn();
		const bridge = makeBridge([stubTool("read", Type.Object({ path: Type.String() }), execute)]);

		const result = asToolResult(
			await bridge.piRead?.({ toolCallId: "call-5", args: { path: "a.ts", limit: 0 } } as never),
		);
		expect(execute).not.toHaveBeenCalled();
		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "" }]);
	});

	it("dispatches MCP calls by tool name and reports unknown tools", async () => {
		const execute = vi.fn();
		const bridge = makeBridge([stubTool("my_mcp_tool", Type.Object({ value: Type.String() }), execute)]);

		const ok = asToolResult(
			await bridge.mcp?.({
				name: "my_mcp_tool",
				toolName: "my_mcp_tool",
				toolCallId: "call-6",
				providerIdentifier: "pi-agent",
				args: { value: "x" },
				rawArgs: {},
			}),
		);
		expect(ok.isError).toBe(false);
		expect(execute).toHaveBeenCalledWith("call-6", { value: "x" });

		const missing = asToolResult(
			await bridge.mcp?.({
				name: "nope",
				toolName: "nope",
				toolCallId: "call-7",
				providerIdentifier: "pi-agent",
				args: {},
				rawArgs: {},
			}),
		);
		expect(missing.isError).toBe(true);
		expect(missing.content[0]).toMatchObject({ text: expect.stringContaining("not registered") });
	});

	it("returns validation failures as error results without executing", async () => {
		const execute = vi.fn();
		const bridge = makeBridge([stubTool("strict_tool", Type.Object({ requiredField: Type.String() }), execute)]);

		const failure = asToolResult(
			await bridge.mcp?.({
				name: "strict_tool",
				toolName: "strict_tool",
				toolCallId: "call-9",
				providerIdentifier: "pi-agent",
				// A missing required property cannot be coerced into existence.
				args: {},
				rawArgs: {},
			}),
		);
		expect(failure.isError).toBe(true);
		expect(execute).not.toHaveBeenCalled();
	});

	it("emits tool lifecycle events for bridge-run tools", async () => {
		const events: AgentEvent[] = [];
		const execute = vi.fn();
		const bridge = makeBridge([stubTool("read", Type.Object({ path: Type.String() }), execute)], events);

		await bridge.read?.({ path: "a.ts", toolCallId: "call-10" } as never);
		expect(events.map((event) => event.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
		const end = events[1];
		expect(end.type === "tool_execution_end" && end.isError).toBe(false);
	});

	it("keeps the originating run signal on both lifecycle events", async () => {
		const runSignal = new AbortController().signal;
		const emitEvent = vi.fn();
		const tool = stubTool("read", Type.Object({ path: Type.String() }), vi.fn());
		const bridge = createCursorExecBridge({
			getTool: (name) => (name === "read" ? tool : undefined),
			getAbortSignal: () => runSignal,
			emitEvent,
		});

		await bridge.read?.({ path: "a.ts", toolCallId: "call-owned" } as never);

		expect(emitEvent).toHaveBeenCalledTimes(2);
		expect(emitEvent.mock.calls.map((call) => call[1])).toEqual([runSignal, runSignal]);
	});

	it("refuses to execute when no active run signal owns the bridge dispatch", async () => {
		const execute = vi.fn();
		const emitEvent = vi.fn();
		const tool = stubTool("read", Type.Object({ path: Type.String() }), execute);
		const bridge = createCursorExecBridge({
			getTool: (name) => (name === "read" ? tool : undefined),
			getAbortSignal: () => undefined,
			emitEvent,
		});

		const result = asToolResult(await bridge.read?.({ path: "a.ts", toolCallId: "call-unowned" } as never));

		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("active run") });
		expect(execute).not.toHaveBeenCalled();
		expect(emitEvent).not.toHaveBeenCalled();
	});

	it("rechecks run ownership after preflight before executing the tool", async () => {
		const owner = new AbortController();
		const replacement = new AbortController();
		let activeSignal: AbortSignal | undefined = owner.signal;
		let releasePreflight!: () => void;
		let markPreflightStarted!: () => void;
		const preflightStarted = new Promise<void>((resolve) => {
			markPreflightStarted = resolve;
		});
		const preflightGate = new Promise<void>((resolve) => {
			releasePreflight = resolve;
		});
		const execute = vi.fn();
		const emitEvent = vi.fn();
		const tool = stubTool("read", Type.Object({ path: Type.String() }), execute);
		const bridge = createCursorExecBridge({
			getTool: (name) => (name === "read" ? tool : undefined),
			getAbortSignal: () => activeSignal,
			preflightToolCall: async () => {
				markPreflightStarted();
				await preflightGate;
				return undefined;
			},
			emitEvent,
		});

		const resultPromise = bridge.read?.({ path: "a.ts", toolCallId: "call-owner-ended" } as never);
		await preflightStarted;
		owner.abort();
		activeSignal = replacement.signal;
		releasePreflight();
		const result = asToolResult(await resultPromise);

		expect(result.isError).toBe(true);
		expect(execute).not.toHaveBeenCalled();
	});

	it("propagates lifecycle listener failures through the bridge dispatch", async () => {
		const runSignal = new AbortController().signal;
		const execute = vi.fn();
		const tool = stubTool("read", Type.Object({ path: Type.String() }), execute);
		const bridge = createCursorExecBridge({
			getTool: (name) => (name === "read" ? tool : undefined),
			getAbortSignal: () => runSignal,
			emitEvent: async () => {
				throw new Error("listener failed");
			},
		});

		await expect(bridge.read?.({ path: "a.ts", toolCallId: "call-listener-failure" } as never)).rejects.toThrow(
			"listener failed",
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("reports missing tools without throwing", async () => {
		const bridge = makeBridge([]);
		const result = asToolResult(await bridge.read?.({ path: "a.ts", toolCallId: "call-11" } as never));
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("not available") });
	});

	it("emits tool_result after a successful write so plan-touch trackers see .omo/plans paths", async () => {
		const results: Array<{ toolName: string; toolCallId: string; args: unknown }> = [];
		const runSignal = new AbortController().signal;
		const tool = stubTool("write", Type.Object({ path: Type.String(), content: Type.String() }), () => undefined);
		const bridge = createCursorExecBridge({
			getTool: (name) => (name === "write" ? tool : undefined),
			getAbortSignal: () => runSignal,
			emitEvent: async () => undefined,
			emitToolResult: async (event) => {
				results.push(event);
			},
		});
		await bridge.write?.({
			path: ".omo/plans/mgitm-opt2-smem-fix.md",
			contents: "# plan",
			toolCallId: "call-plan",
		} as never);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			toolName: "write",
			toolCallId: "call-plan",
			args: { path: ".omo/plans/mgitm-opt2-smem-fix.md" },
		});
	});
});
