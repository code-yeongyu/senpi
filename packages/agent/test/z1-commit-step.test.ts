import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { isStepCommitError, runAgentLoop, StepCommitError } from "../src/index.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool, StepCommit } from "../src/types.ts";

class ScriptedStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("unexpected event");
			},
		);
	}
}

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
}

const user: UserMessage = { role: "user", content: "go", timestamp: 1 };

const providerResult: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "srv-1",
	toolName: "server_exec",
	content: [{ type: "text", text: "ran on the provider" }],
	isError: false,
	timestamp: 1,
};

type Step = { readonly message: AssistantMessage; readonly emitProviderResult?: boolean };

function scripted(steps: readonly Step[]) {
	let index = 0;
	return (
		_model: Model<Api>,
		_context: unknown,
		options?: SimpleStreamOptions & { onToolResult?: (r: ToolResultMessage) => void },
	) => {
		const step = steps[index++];
		if (!step) throw new Error("no scripted step left");
		const stream = new ScriptedStream();
		queueMicrotask(() => {
			if (step.emitProviderResult) options?.onToolResult?.(providerResult);
			const reason = step.message.stopReason;
			if (reason === "error" || reason === "aborted") {
				stream.push({ type: "error", reason, error: step.message });
			} else if (reason !== "pending") {
				stream.push({ type: "done", reason, message: step.message });
			}
		});
		return stream;
	};
}

const toolSchema = Type.Object({});

function contextWith(executed: string[]): AgentContext {
	const tool: AgentTool<typeof toolSchema> = {
		name: "local",
		label: "local",
		description: "local",
		parameters: toolSchema,
		execute: async (toolCallId) => {
			executed.push(toolCallId);
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		},
	};
	return { messages: [], tools: [tool] };
}

function baseConfig(extra: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
	return {
		model,
		convertToLlm: (messages: AgentMessage[]) =>
			messages.filter((m): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
		cursorExecHandlers: {},
		...extra,
	};
}

const toolStep: Step = {
	message: assistant([{ type: "toolCall", id: "call-1", name: "local", arguments: {} }], "toolUse"),
	emitProviderResult: true,
};
const stopStep: Step = { message: assistant([{ type: "text", text: "done" }], "stop") };
const errorStep: Step = { message: { ...assistant([], "error"), errorMessage: "provider exploded" } };

function label(event: AgentEvent): string {
	if (event.type === "message_start" || event.type === "message_end") return `${event.type}:${event.message.role}`;
	if (event.type === "tool_execution_start" || event.type === "tool_execution_end")
		return `${event.type}:${event.toolCallId}`;
	return event.type;
}

async function run(steps: readonly Step[], extra: Partial<AgentLoopConfig> = {}) {
	const trace: string[] = [];
	const executed: string[] = [];
	let failure: unknown;
	const messages = await runAgentLoop(
		[user],
		contextWith(executed),
		baseConfig({
			...extra,
			...(extra.commitStep
				? {
						commitStep: async (step: StepCommit) => {
							trace.push(`commit:${step.message.stopReason}:${step.providerToolResults.length}`);
							await extra.commitStep?.(step);
						},
					}
				: {}),
		}),
		(event) => {
			trace.push(label(event));
		},
		undefined,
		scripted(steps),
	).catch((error: unknown) => {
		failure = error;
		return undefined;
	});
	return { trace, executed, messages, failure };
}

describe("loop edit 1: AgentLoopConfig.commitStep (C6 custody, CK1)", () => {
	it("leaves today's loop unchanged when commitStep is unset (events, messages, tool dispatch)", async () => {
		const { trace, executed, messages, failure } = await run([toolStep, stopStep]);
		expect(failure).toBeUndefined();
		expect(executed).toEqual(["call-1"]);
		expect(trace).toMatchInlineSnapshot(`
			[
			  "agent_start",
			  "turn_start",
			  "message_start:user",
			  "message_end:user",
			  "message_start:assistant",
			  "message_end:assistant",
			  "message_start:toolResult",
			  "message_end:toolResult",
			  "tool_execution_start:call-1",
			  "tool_execution_end:call-1",
			  "message_start:toolResult",
			  "message_end:toolResult",
			  "turn_end",
			  "turn_start",
			  "message_start:assistant",
			  "message_end:assistant",
			  "turn_end",
			  "agent_end",
			]
		`);
		expect(messages?.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "assistant"]);
	});

	it("commits each step once, after its provider tool results and before tool dispatch or the turn end", async () => {
		const committed: StepCommit[] = [];
		const { trace, executed, failure } = await run([toolStep, stopStep], {
			commitStep: async (step) => {
				committed.push(step);
			},
		});
		expect(failure).toBeUndefined();
		expect(executed).toEqual(["call-1"]);
		expect(committed.map((s) => s.message.stopReason)).toEqual(["toolUse", "stop"]);
		expect(committed[0]?.providerToolResults).toEqual([providerResult]);
		expect(committed[1]?.providerToolResults).toEqual([]);
		const first = trace.indexOf("commit:toolUse:1");
		expect(trace.lastIndexOf("message_end:toolResult", trace.indexOf("tool_execution_start:call-1"))).toBeLessThan(
			first,
		);
		expect(first).toBeLessThan(trace.indexOf("tool_execution_start:call-1"));
		expect(trace.indexOf("commit:stop:0")).toBeLessThan(trace.lastIndexOf("turn_end"));
	});

	it("commits a terminal-failure message too, before the loop ends the turn", async () => {
		const { trace, failure } = await run([errorStep], { commitStep: async () => {} });
		expect(failure).toBeUndefined();
		const commit = trace.indexOf("commit:error:0");
		expect(commit).toBeGreaterThan(trace.indexOf("message_end:assistant"));
		expect(commit).toBeLessThan(trace.indexOf("turn_end"));
	});

	it("a rejected commit leaves the loop: no tool dispatch, no further events, the same error out", async () => {
		const refusal = new StepCommitError("step-1", "fenced");
		const { trace, executed, failure } = await run([toolStep, stopStep], {
			commitStep: async () => {
				throw refusal;
			},
		});
		expect(failure).toBe(refusal);
		expect(executed).toEqual([]);
		expect(trace.at(-1)).toBe("commit:toolUse:1");
	});

	it("adds no await to the loop when commitStep is unset", async () => {
		const ticks = await microtaskTicksFromProviderResultToFinishTurn();
		expect(ticks).toBeLessThan(TICK_CAP);
		expect(ticks).toMatchInlineSnapshot(`1`);
	});
});

describe("StepCommitError brand", () => {
	it("recognises an instance and a branded value from another copy of the package, never a look-alike", () => {
		const own = new StepCommitError("s", "generation", { cause: new Error("inner") });
		const otherCopy = Object.defineProperty(
			new Error("step commit failed: fenced"),
			Symbol.for("senpi.StepCommitError"),
			{
				value: true,
			},
		);
		const lookAlike = Object.assign(new Error("step commit failed: fenced"), { name: "StepCommitError" });
		expect(own.code).toBe("generation");
		expect(own.stepId).toBe("s");
		expect(isStepCommitError(own)).toBe(true);
		expect(isStepCommitError(otherCopy)).toBe(true);
		expect(isStepCommitError(lookAlike)).toBe(false);
		expect(isStepCommitError(new Error("x"))).toBe(false);
		expect(isStepCommitError("StepCommitError")).toBe(false);
		expect(isStepCommitError(null)).toBe(false);
	});
});

const TICK_CAP = 10_000;

async function microtaskTicksFromProviderResultToFinishTurn(): Promise<number> {
	let ticks = 0;
	let running = false;
	const tick = () => {
		if (!running) return;
		ticks++;
		if (ticks >= TICK_CAP) {
			running = false;
			return;
		}
		queueMicrotask(tick);
	};
	await runAgentLoop(
		[user],
		contextWith([]),
		baseConfig({
			finishTurn: () => {
				running = false;
			},
		}),
		(event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "toolResult" &&
				event.message.toolCallId === "srv-1"
			) {
				running = true;
				queueMicrotask(tick);
			}
		},
		undefined,
		scripted([{ ...errorStep, emitProviderResult: true }]),
	);
	running = false;
	return ticks;
}
