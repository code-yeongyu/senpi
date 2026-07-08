import { writeFileSync } from "node:fs";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "../src/index.ts";
import { createHarness } from "./suite/harness.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

async function createExecuteToolHarness(factory: (pi: ExtensionAPI) => void) {
	let api: ExtensionAPI | undefined;
	const extensionFactories: ExtensionFactory[] = [
		(pi) => {
			api = pi;
			factory(pi);
		},
	];
	return createHarness({ extensionFactories }).then((harness) => ({
		...harness,
		api: api as ExtensionAPI,
	}));
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
});
