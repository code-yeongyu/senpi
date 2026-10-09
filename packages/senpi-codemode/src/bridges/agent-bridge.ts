import type { AgentToolResult } from "@code-yeongyu/senpi";
import { type Static, Type } from "typebox";
import { Check, Errors } from "typebox/value";
import type { EvalStatusEvent, ExecuteTool } from "../tool/types.ts";
import type { EvalSchemaToolInfo } from "./schema-bridge.ts";

const agentArgsSchema = Type.Object(
	{
		prompt: Type.String({ minLength: 1 }),
		agent: Type.Optional(Type.String({ minLength: 1 })),
		model: Type.Optional(Type.String({ minLength: 1 })),
		label: Type.Optional(Type.String()),
		schema: Type.Optional(Type.Unknown()),
		handle: Type.Optional(Type.Boolean()),
		tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		isolated: Type.Optional(Type.Boolean()),
		apply: Type.Optional(Type.Boolean()),
		merge: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("patch"), Type.Literal("branch")])),
	},
	{ additionalProperties: false },
);

const unsupportedIsolationWarning = "isolated/apply/merge unsupported (no isolation in task engine)";
const taskHandleSchema = Type.Object(
	{
		task_id: Type.String({ pattern: "^st_[0-9a-f]+$" }),
		run_epoch: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: true },
);

/** Structural host contract; no orchestration package dependency. */
export type TaskHandleDetails = {
	readonly task_id: string;
	readonly run_epoch: number;
};
const droppedOptionNames = ["isolated", "apply", "merge"] as const;

type AgentArgs = Static<typeof agentArgsSchema>;
type TaskParams = {
	readonly prompt: string;
	readonly subagent_type?: string;
	readonly model?: string;
	readonly name?: string;
	readonly run_in_background: boolean;
	readonly tools?: readonly string[];
	readonly isolated?: boolean;
	readonly apply?: boolean;
	readonly merge?: "patch" | "branch";
};
type ProgressContext = { readonly fallbackId: string; readonly warning?: string };

export type AgentExecuteTool = ExecuteTool & {
	readonly isToolAvailable?: (name: string) => boolean;
};

export interface RunEvalAgentOptions {
	readonly callId: string;
	readonly taskToolName: string;
	readonly executeTool: AgentExecuteTool;
	readonly listTools?: () => readonly EvalSchemaToolInfo[];
	readonly signal?: AbortSignal;
	readonly emitStatus?: (event: EvalStatusEvent) => void;
}

export type EvalAgentResult = (
	| { readonly text: string }
	| { readonly text: string; readonly data: unknown }
	| { readonly text: string; readonly parseError: string }
	| { readonly text: string; readonly id: string; readonly handle: string; readonly run_epoch: number }
) & { readonly details?: { readonly isolation: Readonly<Record<string, unknown>> } };

// The session-owned executor identifies a bridge across JS and HTTP calls; do not retain retired sessions.
const isolationCapabilities = new WeakMap<AgentExecuteTool, Map<string, boolean>>();

export class AgentIsolationNotAppliedError extends Error {
	readonly name = "AgentIsolationNotAppliedError";
	readonly code = "isolation_not_applied";

	constructor(isolation: Readonly<Record<string, unknown>>) {
		const recovery = ["patch_path", "branch_name", "manual_command"]
			.flatMap((key) => (typeof isolation[key] === "string" ? [`${key}: ${isolation[key]}`] : []))
			.join("; ");
		super(`agent() isolated changes were not applied${recovery ? `; ${recovery}` : ""}`);
	}
}

class AgentArgumentsError extends Error {
	readonly name = "AgentArgumentsError";

	constructor(summary: string) {
		super(`agent() received invalid arguments: ${summary}`);
	}
}

class AgentUnavailableError extends Error {
	readonly name = "AgentUnavailableError";

	constructor(toolName: string) {
		super(`agent() unavailable: no "${toolName}" tool is registered in this session`);
	}
}

class AgentHandleError extends Error {
	readonly name = "AgentHandleError";
	readonly code = "invalid_task_handle";

	constructor() {
		super("agent() requires successful task details with a valid task_id and nonnegative integer run_epoch");
	}
}

export async function runEvalAgent(args: unknown, options: RunEvalAgentOptions): Promise<EvalAgentResult> {
	const parsed = parseAgentArgs(args);
	const structured = Object.hasOwn(parsed, "schema");
	const supportsIsolation = taskSupportsIsolation(options);
	const warning = supportsIsolation ? undefined : droppedOptionsWarning(parsed);
	const fallbackId = parsed.label ?? options.callId;
	if (warning) options.emitStatus?.({ op: "agent", id: fallbackId, status: "running", warning });

	// omp assertNotPlanMode intentionally dropped: senpi has no plan mode
	// senpi-task children lose task tools, so recursion self-gates without a depth counter.
	if (options.executeTool.isToolAvailable?.(options.taskToolName) === false) {
		throw new AgentUnavailableError(options.taskToolName);
	}

	let result: AgentToolResult<unknown>;
	try {
		result = await options.executeTool(options.taskToolName, toTaskParams(parsed, structured, supportsIsolation), {
			...(options.signal ? { signal: options.signal } : {}),
			...(options.emitStatus
				? {
						onUpdate: (update: AgentToolResult<unknown>) =>
							options.emitStatus?.(toProgressEvent(update, { fallbackId, ...(warning ? { warning } : {}) })),
					}
				: {}),
		});
	} catch (error) {
		if (isUnavailableToolError(error)) throw new AgentUnavailableError(options.taskToolName);
		throw error;
	}

	const text = resultText(result);
	const isolation =
		isRecord(result.details) && isRecord(result.details.isolation) ? result.details.isolation : undefined;
	const metadata = isolation === undefined ? {} : { details: { isolation } };
	if (parsed.handle === true) {
		const { task_id: id, run_epoch } = resultTaskHandle(result);
		return { text, id, handle: `agent://${id}`, run_epoch, ...metadata };
	}
	if (isolation?.changes_applied === false) throw new AgentIsolationNotAppliedError(isolation);
	return { ...(structured ? parseStructuredText(text) : { text }), ...metadata };
}

function parseAgentArgs(value: unknown): AgentArgs {
	if (Check(agentArgsSchema, value)) return value;
	const summary = Errors(agentArgsSchema, value)
		.map((error) => `${error.instancePath || "/"} ${error.message}`)
		.join("; ");
	throw new AgentArgumentsError(summary || "invalid value");
}

function taskSupportsIsolation(options: RunEvalAgentOptions): boolean {
	let capabilities = isolationCapabilities.get(options.executeTool);
	if (!capabilities) {
		capabilities = new Map();
		isolationCapabilities.set(options.executeTool, capabilities);
	}
	const cached = capabilities.get(options.taskToolName);
	if (cached !== undefined) return cached;
	const schema = options.listTools?.().find((tool) => tool.name === options.taskToolName)?.parameters;
	const supported = isRecord(schema) && isRecord(schema.properties) && schema.properties.isolated !== undefined;
	capabilities.set(options.taskToolName, supported);
	return supported;
}

function toTaskParams(args: AgentArgs, structured: boolean, supportsIsolation: boolean): TaskParams {
	return {
		prompt: structured
			? `${args.prompt}\n\nRespond ONLY with JSON matching this JSON-Schema:\n${JSON.stringify(args.schema)}`
			: args.prompt,
		...(args.agent === undefined ? {} : { subagent_type: args.agent }),
		...(args.model === undefined ? {} : { model: args.model }),
		...(args.label === undefined ? {} : { name: args.label }),
		run_in_background: args.handle === true,
		...(args.tools === undefined ? {} : { tools: args.tools }),
		...(supportsIsolation && args.isolated !== undefined ? { isolated: args.isolated } : {}),
		...(supportsIsolation && args.apply !== undefined ? { apply: args.apply } : {}),
		...(supportsIsolation && args.merge !== undefined
			? { merge: args.merge === true ? "branch" : args.merge === false ? "patch" : args.merge }
			: {}),
	};
}

function parseStructuredText(text: string): EvalAgentResult {
	try {
		const data: unknown = JSON.parse(text);
		return { text, data };
	} catch (error) {
		if (error instanceof SyntaxError) return { text, parseError: error.message };
		throw error;
	}
}

function droppedOptionsWarning(args: AgentArgs): string | undefined {
	return droppedOptionNames.some((name) => Object.hasOwn(args, name)) ? unsupportedIsolationWarning : undefined;
}

function toProgressEvent(update: AgentToolResult<unknown>, context: ProgressContext): EvalStatusEvent {
	const details = isRecord(update.details) ? update.details : undefined;
	const id = firstString(details, ["task_id", "taskId", "id"]) ?? context.fallbackId;
	const status = firstString(details, ["status"]) ?? "running";
	const agent = firstString(details, ["subagent_type", "agent"]);
	return {
		op: "agent",
		id,
		status,
		...(agent === undefined ? {} : { agent }),
		...(context.warning === undefined ? {} : { warning: context.warning }),
	};
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part): part is Extract<(typeof result.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function resultTaskHandle(result: AgentToolResult<unknown>): TaskHandleDetails {
	const details = result.details;
	if (
		("isError" in result && result.isError === true) ||
		(isRecord(details) && (details.isError === true || details.error !== undefined)) ||
		!Check(taskHandleSchema, details)
	)
		throw new AgentHandleError();
	return details;
}

function firstString(
	record: Readonly<Record<string, unknown>> | undefined,
	keys: readonly string[],
): string | undefined {
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function isUnavailableToolError(error: unknown): boolean {
	if (!isRecord(error)) return false;
	return error.code === "unknown_tool" || error.code === "inactive_tool";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
