import type { AgentToolResult, ExtensionContext } from "@code-yeongyu/senpi";
import { startBridgeServer } from "../src/bridge/http-server.ts";
import { RESERVED_AGENT_TOOL, RESERVED_OUTPUT_TOOL } from "../src/bridge/reserved.ts";
import { createCompletionHandler } from "../src/completion/handler.ts";
import {
	type AgentExecuteTool,
	type EvalAgentResult,
	runEvalAgent,
} from "../src/bridges/agent-bridge.ts";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import { PythonKernel } from "../src/kernels/py/kernel.ts";
import type { ExecuteTool } from "../src/tool/types.ts";

class QaUsageError extends Error {
	readonly name = "QaUsageError";
}

type QaOptions = {
	readonly codes: readonly string[];
	readonly cwd: string;
	readonly withFakeCompletion: string | undefined;
	readonly withFakeTask: boolean;
};

function parseOptions(argv: readonly string[]): QaOptions {
	const codes: string[] = [];
	let cwd = process.cwd();
	let withFakeCompletion: string | undefined;
	let withFakeTask = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--code") {
			const code = argv[index + 1];
			if (code === undefined) throw new QaUsageError("--code requires a value");
			codes.push(code);
			index += 1;
			continue;
		}
		if (argument === "--cwd") {
			const value = argv[index + 1];
			if (value === undefined) throw new QaUsageError("--cwd requires a value");
			cwd = value;
			index += 1;
			continue;
		}
		if (argument === "--with-fake-completion") {
			const value = argv[index + 1];
			if (value === undefined) throw new QaUsageError("--with-fake-completion requires a value");
			withFakeCompletion = value;
			index += 1;
			continue;
		}
		if (argument === "--with-fake-task") {
			withFakeTask = true;
			continue;
		}
		throw new QaUsageError("unknown argument: " + argument);
	}
	if (codes.length === 0) throw new QaUsageError("provide at least one --code cell");
	return { codes, cwd, withFakeCompletion, withFakeTask };
}

function taskResult(text: string, status: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text }],
		details: { task_id: "st_qa_agent", status, subagent_type: "task" },
	};
}

function createQaTaskTool(enabled: boolean): AgentExecuteTool {
	const executeTool: ExecuteTool = async (toolName, _params, executeOptions) => {
		if (toolName !== "task") throw new QaUsageError("unexpected fake task tool: " + toolName);
		executeOptions?.onUpdate?.(taskResult("starting", "running"));
		executeOptions?.onUpdate?.(taskResult("finished", "completed"));
		return taskResult("FAKE_RESULT", "completed");
	};
	return Object.assign(executeTool, { isToolAvailable: (name: string) => enabled && name === "task" });
}

type QaAssistantMessage = {
	readonly role: "assistant";
	readonly content: readonly { readonly type: "text"; readonly text: string }[];
	readonly api: string;
	readonly provider: string;
	readonly model: string;
	readonly stopReason: "stop";
	readonly usage: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly totalTokens: number;
		readonly cost: {
			readonly input: number;
			readonly output: number;
			readonly cacheRead: number;
			readonly cacheWrite: number;
			readonly total: number;
		};
	};
	readonly timestamp: number;
};

const qaCompletionModel = {
	id: "qa-completion-model",
	name: "QA Completion Model",
	provider: "qa",
	api: "qa-api",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000,
	maxTokens: 100,
};

function qaCompletionContext(signal: AbortSignal): ExtensionContext {
	return Object.assign(Object.create(null), {
		model: qaCompletionModel,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "qa-key" }),
			getAvailable: () => [qaCompletionModel],
		},
		signal,
	});
}

function qaCompletionMessage(text: string): QaAssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "qa-api",
		provider: "qa",
		model: "qa-completion-model",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

async function runFakeCompletion(text: string, prompt: string, opts: unknown, signal: AbortSignal): Promise<unknown> {
	const complete = createCompletionHandler(async () => qaCompletionMessage(text));
	return await complete(qaCompletionContext(signal))({ prompt, opts });
}

function adaptPlainForegroundForQa(value: EvalAgentResult): unknown {
	if ("id" in value || "data" in value || "parseError" in value) return value;
	return { text: { text: value.text } };
}

async function runQa(options: QaOptions): Promise<void> {
	const detected = await createInterpreterDetector().detect("py");
	if (!detected.ok) throw new QaUsageError("No py interpreter is available");
	const taskTool = createQaTaskTool(options.withFakeTask);
	const server = await startBridgeServer({
		onCall: async (request) => {
			if (request.toolName === RESERVED_AGENT_TOOL) {
				const value = await runEvalAgent(request.args, {
					callId: request.callId,
					taskToolName: "task",
					executeTool: taskTool,
					signal: request.signal,
					emitStatus: (event) => console.log(JSON.stringify({ type: "status", event })),
				});
				return options.withFakeTask ? adaptPlainForegroundForQa(value) : value;
			}
			if (request.toolName === RESERVED_OUTPUT_TOOL) {
				throw new QaUsageError("output() unavailable: no host handler is registered");
			}
			throw new QaUsageError("tool unavailable in qa driver: " + request.toolName);
		},
		onEmit: async (event) => {
			console.log(JSON.stringify({ type: "emit", event }));
		},
		onCompletion: async (request) => {
			if (options.withFakeCompletion === undefined) {
				throw new QaUsageError("completion unavailable in qa driver");
			}
			return await runFakeCompletion(options.withFakeCompletion, request.prompt, request.opts, request.signal);
		},
	});
	try {
		const kernel = await PythonKernel.start({
			interpreterPath: detected.path,
			sessionId: "qa-py-" + crypto.randomUUID(),
			cwd: options.cwd,
			connection: { port: server.port, token: server.token },
			onMessage: (message) => console.log(JSON.stringify(message)),
		});
		try {
			for (const [index, code] of options.codes.entries()) {
				await kernel.run({ cellId: "qa-cell-" + String(index + 1), code, timeoutMs: 30_000 });
			}
		} finally {
			await kernel.close();
		}
	} finally {
		await server.close();
	}
}

runQa(parseOptions(process.argv.slice(2))).catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
