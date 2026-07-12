/// <reference types="node" />
import type { AgentToolResult } from "@code-yeongyu/senpi";
import { resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { RESERVED_OUTPUT_TOOL } from "../src/bridge/reserved.ts";
import {
	type MarshalledToolResult,
	type OutputExecuteTool,
	runEvalOutput,
} from "../src/bridges/output-bridge.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import type { ExecuteTool } from "../src/tool/types.ts";

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

type QaOptions = {
	readonly cwd: string;
	readonly codes: readonly string[];
	readonly withFakeTask: boolean;
};

type TaskOutputParams = Static<typeof taskOutputParamsSchema>;

class QaArgumentError extends Error {
	readonly name = "QaArgumentError";
}

class QaTaskOutputError extends Error {
	readonly name = "QaTaskOutputError";
}

function parseArgs(args: readonly string[]): QaOptions {
	let cwd = process.cwd();
	const codes: string[] = [];
	let withFakeTask = false;
	for (let index = 0; index < args.length; index += 1) {
		const flag = args[index];
		if (flag === "--with-fake-task") {
			withFakeTask = true;
			continue;
		}
		if (flag !== "--cwd" && flag !== "--code") throw new QaArgumentError(`Unknown argument: ${flag}`);
		const value = args[index + 1];
		if (value === undefined) throw new QaArgumentError(`${flag} requires a value`);
		if (flag === "--cwd") cwd = resolve(value);
		else codes.push(value);
		index += 1;
	}
	if (codes.length === 0) throw new QaArgumentError("At least one --code value is required");
	return { cwd, codes, withFakeTask };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTaskOutputParams(value: unknown): TaskOutputParams {
	if (!Check(taskOutputParamsSchema, value)) throw new QaTaskOutputError("task_output received invalid params");
	if (!isRecord(value)) throw new QaTaskOutputError("task_output params must be an object");
	const taskId = typeof value.task_id === "string" ? value.task_id : undefined;
	const name = typeof value.name === "string" ? value.name : undefined;
	if ((taskId === undefined) === (name === undefined)) {
		throw new QaTaskOutputError("task_output requires exactly one task_id or name");
	}
	if (value.mode !== "full" && value.mode !== "tail") {
		throw new QaTaskOutputError("task_output requires an explicit transcript mode");
	}
	if (value.block !== true) throw new QaTaskOutputError("task_output requires block: true");
	return value;
}

function createFakeTaskOutputTool(enabled: boolean): OutputExecuteTool {
	const executeTool: ExecuteTool = async (toolName, params) => {
		if (toolName !== "task_output") throw new QaTaskOutputError(`unexpected fake task output tool: ${toolName}`);
		const parsed = parseTaskOutputParams(params);
		const target = parsed.task_id ?? parsed.name;
		if (target === undefined) throw new QaTaskOutputError("task_output target missing");
		if (target.includes("missing")) throw new QaTaskOutputError(`unknown task ${target}`);
		return {
			content: [{ type: "text", text: `TRANSCRIPT:${target}:${parsed.mode}` }],
			details: {},
		};
	};
	return Object.assign(executeTool, { isToolAvailable: (name: string) => enabled && name === "task_output" });
}

function marshalToolResult(result: AgentToolResult<unknown>): MarshalledToolResult {
	const text = result.content
		.filter((part): part is Extract<(typeof result.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return { text };
}

function printFrame(message: KernelToHostMessage): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function replyToToolCall(
	message: Extract<KernelToHostMessage, { type: "tool-call" }>,
	kernel: JavaScriptKernel,
	options: QaOptions,
	executeTool: OutputExecuteTool,
): Promise<void> {
	try {
		if (message.toolName !== RESERVED_OUTPUT_TOOL) throw new QaArgumentError(`tool unavailable in qa driver: ${message.toolName}`);
		if (!options.withFakeTask) throw new QaArgumentError("output() unavailable: no host handler is registered");
		const value = await runEvalOutput(message.args, {
			taskOutputToolName: "task_output",
			executeTool,
			marshalToolResult,
		});
		kernel.deliverToolReply({ type: "tool-reply", callId: message.callId, ok: true, value });
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		kernel.deliverToolReply({ type: "tool-reply", callId: message.callId, ok: false, error: { message: text } });
	}
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const executeTool = createFakeTaskOutputTool(options.withFakeTask);
	let kernel: JavaScriptKernel | undefined;
	kernel = new JavaScriptKernel({
		sessionId: `qa-js-${crypto.randomUUID()}`,
		cwd: options.cwd,
		parallelPoolWidth: 4,
		onMessage: (message) => {
			printFrame(message);
			if (message.type !== "tool-call" || kernel === undefined) return;
			void replyToToolCall(message, kernel, options, executeTool);
		},
	});
	try {
		for (const [index, code] of options.codes.entries()) {
			const result = await kernel.run({ cellId: `qa-cell-${index + 1}`, code, timeoutMs: 15_000 });
			if (!result.ok) process.exitCode = 1;
		}
	} finally {
		await kernel.close();
	}
}

await main();
