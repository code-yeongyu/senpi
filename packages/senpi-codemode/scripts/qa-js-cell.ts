import { resolve } from "node:path";
import { DEFAULT_COMPACTION_SETTINGS, type ExtensionContext } from "@code-yeongyu/senpi";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import type { OutputExecuteTool } from "../src/bridges/output-bridge.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalKernelManager } from "../src/tool/types.ts";

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
	readonly timeoutSeconds: number;
	readonly slowToolMs: number | undefined;
	readonly withFakeTask: boolean;
};

type TaskOutputParams = Static<typeof taskOutputParamsSchema>;

class QaArgumentError extends Error {
	readonly name = "QaArgumentError";
}

class QaTaskOutputError extends Error {
	readonly name = "QaTaskOutputError";
}

function parseDuration(flag: string, value: string | undefined, minimum: number): number {
	if (value === undefined) throw new QaArgumentError(`${flag} requires a value`);
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < minimum) {
		throw new QaArgumentError(`${flag} must be a finite number >= ${minimum}`);
	}
	return parsed;
}

function parseArgs(args: readonly string[]): QaOptions {
	let cwd = process.cwd();
	let timeoutSeconds = 15;
	let slowToolMs: number | undefined;
	let withFakeTask = false;
	const codes: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const flag = args[index];
		if (flag === "--with-fake-task") {
			withFakeTask = true;
			continue;
		}
		if (flag === "--cwd") {
			cwd = resolveArg(flag, args[++index]);
			continue;
		}
		if (flag === "--code") {
			codes.push(resolveArg(flag, args[++index]));
			continue;
		}
		if (flag === "--timeout-s") {
			timeoutSeconds = parseDuration(flag, args[++index], Number.MIN_VALUE);
			continue;
		}
		if (flag === "--slow-tool-ms") {
			slowToolMs = parseDuration(flag, args[++index], 0);
			continue;
		}
		throw new QaArgumentError(`Unknown argument: ${flag}`);
	}
	if (codes.length === 0) throw new QaArgumentError("At least one --code value is required");
	return { cwd, codes, timeoutSeconds, slowToolMs, withFakeTask };
}

function resolveArg(flag: string, value: string | undefined): string {
	if (value === undefined) throw new QaArgumentError(`${flag} requires a value`);
	return flag === "--cwd" ? resolve(value) : value;
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

function createQaExecuteTool(options: QaOptions): OutputExecuteTool {
	const executeTool: OutputExecuteTool = async (toolName, params, executeOptions) => {
		if (toolName === "task_output") {
			if (!options.withFakeTask) throw new QaTaskOutputError("output() unavailable: no host handler is registered");
			const parsed = parseTaskOutputParams(params);
			const target = parsed.task_id ?? parsed.name;
			if (target === undefined) throw new QaTaskOutputError("task_output target missing");
			if (target.includes("missing")) throw new QaTaskOutputError(`unknown task ${target}`);
			return {
				content: [{ type: "text", text: `TRANSCRIPT:${target}:${parsed.mode}` }],
				details: {},
			};
		}
		if (toolName !== "slow_fake") throw new QaArgumentError(`Tool unavailable in QA driver: ${toolName}`);
		if (options.slowToolMs === undefined) throw new QaArgumentError("slow_fake requires --slow-tool-ms");
		await new Promise<void>((resolve, reject) => {
			const signal = executeOptions?.signal;
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, options.slowToolMs);
			const onAbort = (): void => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				reject(signal?.reason);
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		return { content: [{ type: "text", text: "slow fake" }], details: {} };
	};
	return Object.assign(executeTool, {
		isToolAvailable: (toolName: string): boolean =>
			(toolName === "task_output" && options.withFakeTask) ||
			(toolName === "slow_fake" && options.slowToolMs !== undefined),
	});
}

async function runQa(options: QaOptions): Promise<void> {
	let dispatch: ((message: KernelToHostMessage) => void) | undefined;
	const kernel = new JavaScriptKernel({
		sessionId: `qa-js-${crypto.randomUUID()}`,
		cwd: options.cwd,
		parallelPoolWidth: 4,
		onMessage: (message) => {
			process.stdout.write(`${JSON.stringify(message)}\n`);
			dispatch?.(message);
		},
	});
	const kernelManager: EvalKernelManager = {
		getKernel: async (language, onMessage) => {
			if (language !== "js") throw new QaArgumentError(`Unsupported QA language: ${language}`);
			dispatch = onMessage;
			return kernel;
		},
	};
	const executeTool = createQaExecuteTool(options);
	const qaContext: ExtensionContext = {
		ui: Object.create(null),
		mode: "print",
		hasUI: false,
		cwd: options.cwd,
		sessionManager: Object.create(null),
		modelRegistry: Object.create(null),
		model: undefined,
		serviceTier: undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		getCompactionSettings: () => DEFAULT_COMPACTION_SETTINGS,
		compact: () => {},
		getMessageRevision: () => 0,
		applyCompaction: async () => ({ applied: false, reason: "rejected" }),
		getSystemPrompt: () => "",
	};
	const tool = createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager,
		cellTimeoutSeconds: options.timeoutSeconds,
		executeTool,
	});
	try {
		for (const [index, code] of options.codes.entries()) {
			const startedAt = performance.now();
			try {
				const result = await tool.execute(
					`qa-cell-${index + 1}`,
					{ language: "js", code, timeout: options.timeoutSeconds },
					undefined,
					undefined,
					qaContext,
				);
				process.stdout.write(`${JSON.stringify(result)}\n`);
				if (result.details.isError) process.exitCode = 1;
			} catch (error) {
				process.stderr.write(`QA_ERROR ${error instanceof Error ? error.message : String(error)}\n`);
				process.exitCode = 1;
			} finally {
				process.stdout.write(`ELAPSED_MS ${Math.round(performance.now() - startedAt)}\n`);
			}
			if (process.exitCode) return;
		}
	} finally {
		await kernel.close();
	}
}

try {
	await runQa(parseArgs(process.argv.slice(2)));
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
