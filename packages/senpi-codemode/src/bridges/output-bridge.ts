import type { AgentToolResult } from "@code-yeongyu/senpi";
import { type Static, Type } from "typebox";
import { Check, Errors } from "typebox/value";
import type { ExecuteTool } from "../tool/types.ts";

const outputArgsSchema = Type.Object(
	{
		ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		format: Type.Optional(Type.Union([Type.Literal("raw"), Type.Literal("tail")])),
		offset: Type.Optional(Type.Integer({ minimum: 1 })),
		limit: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

type OutputArgs = Static<typeof outputArgsSchema>;

export type OutputExecuteTool = ExecuteTool & {
	readonly isToolAvailable?: (name: string) => boolean;
};

export type MarshalledToolResult = {
	readonly text: string;
};

export interface RunEvalOutputOptions {
	readonly taskOutputToolName: string;
	readonly executeTool: OutputExecuteTool;
	readonly signal?: AbortSignal;
	readonly marshalToolResult: (result: AgentToolResult<unknown>) => MarshalledToolResult;
}

class OutputArgumentsError extends Error {
	readonly name = "OutputArgumentsError";

	constructor(summary: string) {
		super(`output() received invalid arguments: ${summary}`);
	}
}

class OutputUnavailableError extends Error {
	readonly name = "OutputUnavailableError";

	constructor(toolName: string) {
		super(`output() unavailable: no "${toolName}" tool is registered in this session`);
	}
}

export async function runEvalOutput(args: unknown, options: RunEvalOutputOptions): Promise<string | readonly string[]> {
	const parsed = parseOutputArgs(args);
	if (options.executeTool.isToolAvailable?.(options.taskOutputToolName) === false) {
		throw new OutputUnavailableError(options.taskOutputToolName);
	}

	const mode = parsed.format === "tail" ? "tail" : "full";
	const transcripts = await Promise.all(
		parsed.ids.map(async (id) => {
			let result: AgentToolResult<unknown>;
			try {
				result = await options.executeTool(
					options.taskOutputToolName,
					{
						...(id.startsWith("st_") ? { task_id: id } : { name: id }),
						mode,
						block: true,
					},
					options.signal === undefined ? undefined : { signal: options.signal },
				);
			} catch (error) {
				if (isUnavailableToolError(error)) throw new OutputUnavailableError(options.taskOutputToolName);
				throw error;
			}

			// ADAPTATION: task_output owns transcripts, so no AgentOutputManager cache or
			// oh-my-pi query/json/stripped formats exist on this bridge.
			const transcript = options.marshalToolResult(result).text;
			const lines = transcript.split(/\r?\n/u);
			const start = (parsed.offset ?? 1) - 1;
			return lines.slice(start, parsed.limit === undefined ? undefined : start + parsed.limit).join("\n");
		}),
	);
	return transcripts.length === 1 ? transcripts[0] : transcripts;
}

function parseOutputArgs(value: unknown): OutputArgs {
	if (Check(outputArgsSchema, value)) return value;
	const summary = Errors(outputArgsSchema, value)
		.map((error) => `${error.instancePath || "/"} ${error.message}`)
		.join("; ");
	throw new OutputArgumentsError(summary || "invalid value");
}

function isUnavailableToolError(error: unknown): boolean {
	if (typeof error !== "object" || error === null || Array.isArray(error)) return false;
	return "code" in error && (error.code === "unknown_tool" || error.code === "inactive_tool");
}
