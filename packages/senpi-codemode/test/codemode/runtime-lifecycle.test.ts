import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import type { AgentExecuteTool } from "../../src/bridges/agent-bridge.ts";
import { CodeModeSessionRuntime } from "../../src/codemode/runtime.ts";

function createRuntime(executeTool: AgentExecuteTool): CodeModeSessionRuntime {
	return new CodeModeSessionRuntime({
		sessionId: "runtime-lifecycle-test",
		cwd: process.cwd(),
		parallelPoolWidth: 1,
		executeTool,
	});
}

function textResult(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined };
}

describe("Code Mode runtime lifecycle", () => {
	it("does not start a cell for an already-aborted exec signal", async () => {
		const calls: string[] = [];
		const executeTool: AgentExecuteTool = async (name) => {
			calls.push(name);
			return textResult("unexpected");
		};
		const runtime = createRuntime(executeTool);
		const controller = new AbortController();
		controller.abort(new Error("cancel before exec"));

		try {
			const result = await runtime.execute("await tools.echo({})", 1_000, controller.signal);

			expect(result).toMatchObject({ state: "terminated" });
			expect(calls).toEqual([]);
		} finally {
			await runtime.dispose();
		}
	});

	it("keeps partial output and the terminal error together", async () => {
		const runtime = createRuntime(async () => textResult("unused"));

		try {
			const result = await runtime.execute(
				'print("partial-output"); throw new Error("terminal-error");',
				1_000,
				undefined,
			);

			expect(result).toMatchObject({ state: "error", output: expect.stringContaining("partial-output") });
			expect(result.output).toContain("terminal-error");
		} finally {
			await runtime.dispose();
		}
	});

	it("bounds accumulated output from a noisy cell", async () => {
		const runtime = createRuntime(async () => textResult("unused"));

		try {
			const result = await runtime.execute('print("x".repeat(200_000))', 1_000, undefined);

			expect(result.output).toContain("[output truncated]");
			expect(result.output.length).toBeLessThanOrEqual(100_256);
		} finally {
			await runtime.dispose();
		}
	});

	it("bounds terminal errors without retaining their full message", async () => {
		const runtime = createRuntime(async () => textResult("unused"));

		try {
			const result = await runtime.execute('throw new Error("terminal".repeat(50_000))', 1_000, undefined);

			expect(result).toMatchObject({ state: "error", output: expect.stringContaining("[error truncated]") });
			expect(result.output.length).toBeLessThanOrEqual(104_512);
			expect(result.error?.length).toBeLessThanOrEqual(4_128);
		} finally {
			await runtime.dispose();
		}
	});

	it("rejects recursive and inactive nested tool calls", async () => {
		const calls: string[] = [];
		const executeTool: AgentExecuteTool = Object.assign(
			async (name: string) => {
				calls.push(name);
				return textResult("unexpected");
			},
			{ isToolAvailable: () => false },
		);
		const runtime = createRuntime(executeTool);

		try {
			const result = await runtime.execute(
				`for (const name of ["eval", "exec", "wait", "inactive"]) {
					try {
						await tools[name]({});
					} catch (error) {
						print(error.message);
					}
				}`,
				1_000,
				undefined,
			);

			expect(result).toMatchObject({ state: "result" });
			expect(result.output).toContain('recursive Code Mode tool "eval" is not allowed');
			expect(result.output).toContain('recursive Code Mode tool "exec" is not allowed');
			expect(result.output).toContain('recursive Code Mode tool "wait" is not allowed');
			expect(result.output).toContain('nested tool "inactive" is not active');
			expect(calls).toEqual([]);
		} finally {
			await runtime.dispose();
		}
	});

	it("aborts nested tool work when the session runtime is disposed", async () => {
		const aborted = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const executeTool: AgentExecuteTool = async (_name, _params, options) => {
			started.resolve();
			await new Promise<void>((_resolve, reject) => {
				options?.signal?.addEventListener(
					"abort",
					() => {
						aborted.resolve();
						reject(options.signal?.reason);
					},
					{ once: true },
				);
			});
			return textResult("unreachable");
		};
		const runtime = createRuntime(executeTool);

		const execution = runtime.execute("await tools.hold({})", 1_000, undefined);
		await expect(started.promise).resolves.toBeUndefined();
		await runtime.dispose();

		await expect(aborted.promise).resolves.toBeUndefined();
		await expect(execution).resolves.toMatchObject({ state: "terminated" });
	});
});
