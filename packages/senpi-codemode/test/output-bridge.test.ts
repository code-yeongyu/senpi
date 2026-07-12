import type { AgentToolResult } from "@code-yeongyu/senpi";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { RESERVED_OUTPUT_TOOL } from "../src/bridge/reserved.ts";
import {
	type MarshalledToolResult,
	type OutputExecuteTool,
	type RunEvalOutputOptions,
	runEvalOutput,
} from "../src/bridges/output-bridge.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { ExecuteTool } from "../src/tool/types.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

const taskOutputParamsSchema = Type.Object(
	{
		task_id: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
		mode: Type.Optional(Type.Union([Type.Literal("status"), Type.Literal("tail"), Type.Literal("full")])),
		tail_lines: Type.Optional(Type.Integer({ minimum: 1 })),
		block: Type.Optional(Type.Boolean()),
		timeout_ms: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	{ additionalProperties: false },
);

type TaskOutputParams = Static<typeof taskOutputParamsSchema>;

type CapturedCall = {
	readonly toolName: string;
	readonly params: TaskOutputParams;
};

class TaskOutputFixtureError extends Error {
	readonly name = "TaskOutputFixtureError";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTaskOutputParams(value: unknown): TaskOutputParams {
	if (!Check(taskOutputParamsSchema, value)) throw new TaskOutputFixtureError("task_output received invalid params");
	if (!isRecord(value)) throw new TaskOutputFixtureError("task_output params must be an object");
	const taskId = typeof value.task_id === "string" ? value.task_id : undefined;
	const name = typeof value.name === "string" ? value.name : undefined;
	if ((taskId === undefined) === (name === undefined)) {
		throw new TaskOutputFixtureError("task_output requires exactly one task_id or name");
	}
	if (value.mode !== "full" && value.mode !== "tail") {
		throw new TaskOutputFixtureError("task_output requires an explicit transcript mode");
	}
	if (value.block !== true) throw new TaskOutputFixtureError("task_output requires block: true");
	return {
		...(taskId === undefined ? {} : { task_id: taskId }),
		...(name === undefined ? {} : { name }),
		mode: value.mode,
		block: value.block,
	};
}

function withAvailability(executeTool: ExecuteTool, isToolAvailable: (name: string) => boolean): OutputExecuteTool {
	return Object.assign(executeTool, { isToolAvailable });
}

function fixtureExecuteTool(calls: CapturedCall[]): OutputExecuteTool {
	return withAvailability(
		async (toolName, params) => {
			const parsed = parseTaskOutputParams(params);
			calls.push({ toolName, params: parsed });
			const target = parsed.task_id ?? parsed.name;
			if (target === undefined) throw new TaskOutputFixtureError("task_output target missing");
			if (target.includes("missing")) throw new TaskOutputFixtureError(`unknown task ${target}`);
			return {
				content: [{ type: "text", text: `TRANSCRIPT:${target}:${parsed.mode}\nsecond\nthird` }],
				details: {},
			};
		},
		(name) => name === "task_output" || name === "named_output",
	);
}

function marshalToolResult(result: AgentToolResult<unknown>): MarshalledToolResult {
	const text = result.content
		.filter((part): part is Extract<(typeof result.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return { text };
}

function invokeOutput(
	args: unknown,
	executeTool: OutputExecuteTool,
	overrides: Partial<Omit<RunEvalOutputOptions, "executeTool" | "marshalToolResult">> = {},
): Promise<string | readonly string[]> {
	return runEvalOutput(args, {
		taskOutputToolName: overrides.taskOutputToolName ?? "task_output",
		executeTool,
		marshalToolResult,
		...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
	});
}

describe("output bridge", () => {
	it("returns a scalar transcript through the configured task output tool", async () => {
		// Given
		const calls: CapturedCall[] = [];
		const executeTool = fixtureExecuteTool(calls);

		// When
		const output = await invokeOutput({ ids: ["st_123"] }, executeTool, { taskOutputToolName: "named_output" });

		// Then
		expect(output).toBe("TRANSCRIPT:st_123:full\nsecond\nthird");
		expect(calls).toEqual([{ toolName: "named_output", params: { task_id: "st_123", mode: "full", block: true } }]);
	});

	it("returns transcripts in input order for multiple ids", async () => {
		// Given
		const calls: CapturedCall[] = [];
		const executeTool = fixtureExecuteTool(calls);

		// When
		const output = await invokeOutput({ ids: ["st_123", "reviewer"], format: "tail" }, executeTool);

		// Then
		expect(output).toEqual(["TRANSCRIPT:st_123:tail\nsecond\nthird", "TRANSCRIPT:reviewer:tail\nsecond\nthird"]);
		expect(calls).toEqual([
			{ toolName: "task_output", params: { task_id: "st_123", mode: "tail", block: true } },
			{ toolName: "task_output", params: { name: "reviewer", mode: "tail", block: true } },
		]);
	});

	it("slices returned transcript lines with one-indexed offset and limit", async () => {
		// Given
		const calls: CapturedCall[] = [];
		const executeTool = fixtureExecuteTool(calls);

		// When
		const output = await invokeOutput({ ids: ["st_123"], offset: 2, limit: 2 }, executeTool);

		// Then
		expect(output).toBe("second\nthird");
	});

	it("rejects invalid output arguments", async () => {
		// Given
		const executeTool = fixtureExecuteTool([]);

		// When / Then
		await expect(invokeOutput({ ids: [], format: "json" }, executeTool)).rejects.toThrow(
			"output() received invalid arguments",
		);
	});

	it("reports an absent task output tool without invoking it", async () => {
		// Given
		let executed = false;
		const executeTool = withAvailability(
			async () => {
				executed = true;
				return { content: [{ type: "text", text: "unused" }], details: {} };
			},
			() => false,
		);

		// When / Then
		await expect(invokeOutput({ ids: ["st_123"] }, executeTool)).rejects.toThrow(
			'output() unavailable: no "task_output" tool is registered in this session',
		);
		expect(executed).toBe(false);
	});

	it("propagates task output errors", async () => {
		// Given
		const executeTool = fixtureExecuteTool([]);

		// When / Then
		await expect(invokeOutput({ ids: ["st_999_missing"] }, executeTool)).rejects.toThrow(
			"unknown task st_999_missing",
		);
	});

	it("propagates the cell abort signal to task output", async () => {
		// Given
		const controller = new AbortController();
		const executeTool = withAvailability(
			async (_toolName, _params, options) => {
				const signal = options?.signal;
				if (!signal) throw new TaskOutputFixtureError("missing signal");
				return await new Promise<AgentToolResult<unknown>>((_resolve, reject) => {
					const rejectAbort = (): void => reject(signal.reason);
					if (signal.aborted) rejectAbort();
					else signal.addEventListener("abort", rejectAbort, { once: true });
				});
			},
			(name) => name === "task_output",
		);

		// When
		const pending = invokeOutput({ ids: ["st_123"] }, executeTool, { signal: controller.signal });
		controller.abort(new DOMException("cancelled by caller", "AbortError"));

		// Then
		await expect(pending).rejects.toThrow("cancelled by caller");
	});

	it("routes reserved output tool calls through the cell handler", async () => {
		// Given
		const kernel = new FakeKernel([
			{ type: "tool-call", callId: "output-call-1", toolName: RESERVED_OUTPUT_TOOL, args: { ids: ["st_123"] } },
			result("cell-1", "done"),
		]);
		const calls: CapturedCall[] = [];
		const tool = createEvalTool({
			enabledLanguages: { py: false, js: true, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool: fixtureExecuteTool(calls),
		});

		// When
		await tool.execute(
			"cell-1",
			{ language: "js", code: 'await output("st_123")' },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		// Then
		expect(kernel.replies).toContainEqual({
			type: "tool-reply",
			callId: "output-call-1",
			ok: true,
			value: "TRANSCRIPT:st_123:full\nsecond\nthird",
		});
	});

	it("returns task output from a real JavaScript cell", async () => {
		// Given
		let kernel: JavaScriptKernel | undefined;
		const calls: CapturedCall[] = [];
		const tool = createEvalTool({
			enabledLanguages: { py: false, js: true, rb: false, jl: false },
			kernelManager: {
				async getKernel(_language, onMessage) {
					kernel = new JavaScriptKernel({
						sessionId: `output-bridge-e2e-${crypto.randomUUID()}`,
						cwd: process.cwd(),
						parallelPoolWidth: 1,
						onMessage,
					});
					return kernel;
				},
			},
			cellTimeoutSeconds: 30,
			executeTool: fixtureExecuteTool(calls),
		});

		try {
			// When
			const evalResult = await tool.execute(
				"real-output-cell",
				{ language: "js", code: 'const transcript = await output("st_123"); return transcript;' },
				undefined,
				undefined,
				fakeExtensionContext(),
			);

			// Then
			expect(evalResult.content).toContainEqual({
				type: "text",
				text: expect.stringContaining("TRANSCRIPT:st_123:full"),
			});
			expect(calls).toEqual([{ toolName: "task_output", params: { task_id: "st_123", mode: "full", block: true } }]);
		} finally {
			await kernel?.close();
		}
	});
});
