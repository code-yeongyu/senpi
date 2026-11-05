import { writeFileSync } from "node:fs";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createExecuteToolHarness } from "./helpers/execute-tool-harness.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

describe("pi.executeTool hook dispatch", () => {
	it("dispatches extension tools through tool_call and tool_result hooks", async () => {
		const calls: Array<{ toolName: string; input: Record<string, unknown> }> = [];
		const harness = await createExecuteToolHarness((pi) => {
			pi.registerTool({
				name: "echo_ext",
				label: "Echo",
				description: "Echo extension input",
				parameters: Type.Object({ value: Type.String() }),
				execute: async (_toolCallId, params) => ({
					content: [{ type: "text", text: `value:${params.value}` }],
					details: { value: params.value },
				}),
			});
			pi.on("tool_call", (event) => {
				calls.push({ toolName: event.toolName, input: { ...event.input } });
				const input = event.input as Record<string, unknown>;
				input.value = `${input.value}-mutated`;
				return undefined;
			});
			pi.on("tool_result", (event) => ({
				content: [
					{ type: "text", text: `${event.content[0]?.type === "text" ? event.content[0].text : ""}:rewritten` },
				],
				details: { ...(typeof event.details === "object" && event.details ? event.details : {}), rewritten: true },
			}));
		});

		try {
			const result = await harness.api.executeTool("echo_ext", { value: "start" });

			expect(calls).toEqual([{ toolName: "echo_ext", input: { value: "start" } }]);
			expect(textOf(result)).toBe("value:start-mutated:rewritten");
			expect(result.details).toEqual({ value: "start-mutated", rewritten: true });
		} finally {
			harness.cleanup();
		}
	});

	it.each([
		["a number", 5],
		["an object", { nested: true }],
		["a Date", new Date(0)],
	])("runs the body with a tool_call mutation to %s unchanged, never re-validated", async (_name, mutated) => {
		const received: unknown[] = [];
		const harness = await createExecuteToolHarness((pi) => {
			pi.registerTool({
				name: "typed_ext",
				label: "Typed",
				description: "Takes a string",
				parameters: Type.Object({ value: Type.String() }),
				execute: async (_toolCallId, params) => {
					received.push(params.value);
					return { content: [{ type: "text", text: "ran" }], details: {} };
				},
			});
			pi.on("tool_call", (event) => {
				(event.input as Record<string, unknown>).value = mutated;
				return undefined;
			});
		});

		try {
			const result = await harness.api.executeTool("typed_ext", { value: "start" });

			expect(textOf(result)).toBe("ran");
			// senpi#5861: the body gets the hook's own value, not the host's JSON copy of it.
			expect(received).toHaveLength(1);
			expect(received[0]).toBe(mutated);
		} finally {
			harness.cleanup();
		}
	});

	it("hands tool_result the arguments the body edited in place", async () => {
		const seen: unknown[] = [];
		const harness = await createExecuteToolHarness((pi) => {
			pi.registerTool({
				name: "edit_ext",
				label: "Edit",
				description: "Normalizes its own input",
				parameters: Type.Object({ value: Type.String() }),
				execute: async (_toolCallId, params) => {
					params.value = "edited";
					return { content: [{ type: "text", text: "ran" }], details: {} };
				},
			});
			pi.on("tool_result", (event) => {
				seen.push(event.input.value);
				return undefined;
			});
		});

		try {
			await harness.api.executeTool("edit_ext", { value: "start" });

			expect(seen).toEqual(["edited"]);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects a tool_call rewrite JSON cannot carry with invalid_params before the body runs", async () => {
		const execute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "should-not-run" }],
			details: {},
		}));
		const harness = await createExecuteToolHarness((pi) => {
			pi.registerTool({
				name: "bigint_ext",
				label: "BigInt",
				description: "Takes a string",
				parameters: Type.Object({ value: Type.String() }),
				execute,
			});
			pi.on("tool_call", (event) => {
				(event.input as Record<string, unknown>).value = 1n;
				return undefined;
			});
		});

		try {
			await expect(harness.api.executeTool("bigint_ext", { value: "start" })).rejects.toMatchObject({
				code: "invalid_params",
				message: expect.stringMatching(/^Tool arguments are not JSON: /),
			});
			expect(execute).not.toHaveBeenCalled();
		} finally {
			harness.cleanup();
		}
	});

	it("dispatches built-in tools from the active set", async () => {
		const harness = await createExecuteToolHarness(() => {});
		try {
			const path = `${harness.tempDir}/present.txt`;
			writeFileSync(path, "built-in dispatch");
			const result = await harness.api.executeTool("read", { path });

			expect(textOf(result)).toContain("built-in dispatch");
		} finally {
			harness.cleanup();
		}
	});

	it("blocks before execution with the exact hook reason", async () => {
		const execute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "should-not-run" }],
			details: {},
		}));
		const harness = await createExecuteToolHarness((pi) => {
			pi.registerTool({
				name: "blocked_ext",
				label: "Blocked",
				description: "Blocked extension tool",
				parameters: Type.Object({}),
				execute,
			});
			pi.on("tool_call", () => ({ block: true, reason: "nope" }));
		});

		try {
			await expect(harness.api.executeTool("blocked_ext", {})).rejects.toMatchObject({
				code: "blocked",
				message: "nope",
			});
			expect(execute).not.toHaveBeenCalled();
		} finally {
			harness.cleanup();
		}
	});

	it("applies tool_result rewrites after execution", async () => {
		const harness = await createExecuteToolHarness((pi) => {
			pi.registerTool({
				name: "rewrite_ext",
				label: "Rewrite",
				description: "Rewrite result",
				parameters: Type.Object({}),
				execute: async () => ({
					content: [{ type: "text", text: "original" }],
					details: { original: true },
				}),
			});
			pi.on("tool_result", () => ({
				content: [{ type: "text", text: "replacement" }],
				details: { replacement: true },
				isError: true,
			}));
		});

		try {
			const result = await harness.api.executeTool("rewrite_ext", {});

			expect(textOf(result)).toBe("replacement");
			expect(result.details).toEqual({ replacement: true });
		} finally {
			harness.cleanup();
		}
	});

	it("runs tool_result hooks for thrown tools and returns the rewritten result", async () => {
		const observed: Array<{ isError: boolean; text: string }> = [];
		const harness = await createExecuteToolHarness((pi) => {
			pi.registerTool({
				name: "throw_ext",
				label: "Throw",
				description: "Throws during execution",
				parameters: Type.Object({}),
				execute: async () => {
					throw new Error("raw failure");
				},
			});
			pi.on("tool_result", (event) => {
				observed.push({
					isError: event.isError,
					text: event.content[0]?.type === "text" ? event.content[0].text : "",
				});
				return {
					content: [{ type: "text", text: "recovered by hook" }],
					details: { recovered: true },
					isError: false,
				};
			});
		});

		try {
			const result = await harness.api.executeTool("throw_ext", {});

			expect(observed).toEqual([{ isError: true, text: "raw failure" }]);
			expect(textOf(result)).toBe("recovered by hook");
			expect(result.details).toEqual({ recovered: true });
		} finally {
			harness.cleanup();
		}
	});

	it("reports a returned isError: true to tool_result hooks without discarding details", async () => {
		const observed: Array<{ isError: boolean; details: unknown }> = [];
		const harness = await createExecuteToolHarness((pi) => {
			pi.registerTool({
				name: "inline_fail_ext",
				label: "Inline fail",
				description: "Returns a structured failure without throwing",
				parameters: Type.Object({}),
				execute: async () => ({
					content: [{ type: "text", text: "member 'x' failed to start" }],
					details: { kind: "runtime_error" },
					isError: true,
				}),
			});
			pi.registerTool({
				name: "inline_ok_ext",
				label: "Inline ok",
				description: "Returns a success without an isError flag",
				parameters: Type.Object({}),
				execute: async () => ({
					content: [{ type: "text", text: "created" }],
					details: { kind: "created" },
				}),
			});
			pi.on("tool_result", (event) => {
				observed.push({ isError: event.isError, details: event.details });
				return undefined;
			});
		});

		try {
			const failed = await harness.api.executeTool("inline_fail_ext", {});
			await harness.api.executeTool("inline_ok_ext", {});

			expect(observed).toEqual([
				{ isError: true, details: { kind: "runtime_error" } },
				{ isError: false, details: { kind: "created" } },
			]);
			expect(failed.details).toEqual({ kind: "runtime_error" });
		} finally {
			harness.cleanup();
		}
	});
});
