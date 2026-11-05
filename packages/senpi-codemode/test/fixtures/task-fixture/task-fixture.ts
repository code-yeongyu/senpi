import type { AgentToolResult, ExtensionContext } from "@code-yeongyu/senpi";
import type { AgentExecuteTool } from "../../../src/bridges/agent-bridge.ts";
import type { CompletionRequest, CompletionResult } from "../../../src/completion/handler.ts";

// The G4 fixture (detached nested completion()/agent()): a host `task` tool and a completion function that record
// every nested call a cell makes. The task results carry the host task tool's typed identity: a foreground run
// returns its final text with `{task_id, run_epoch, status: "completed"}`, a background run returns the start
// record `{kind: "started", task_id, status: "running", name, run_epoch}`. Ids are deterministic (`st_0001`, ...).
// No test framework import: an equivalence scenario can drive the same fixture.

export const TASK_FIXTURE_TOOL_NAME = "task";

export interface TaskFixtureCall {
	readonly toolName: string;
	readonly params: unknown;
	readonly signal: AbortSignal | undefined;
}

export interface HeldTaskCall {
	readonly entered: Promise<TaskFixtureCall>;
	readonly settled: Promise<void>;
	release(): void;
}

export interface TaskFixture {
	readonly executeTool: AgentExecuteTool;
	readonly calls: readonly TaskFixtureCall[];
	/** The next task call waits until released, and rejects with its signal's reason when that signal aborts. */
	holdNext(): HeldTaskCall;
}

export interface CompletionFixtureCall {
	readonly request: CompletionRequest;
	readonly ctx: ExtensionContext;
}

export interface CompletionFixture {
	readonly complete: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>;
	readonly calls: readonly CompletionFixtureCall[];
}

function textResult(text: string, details: unknown): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

function promptOf(params: unknown): string {
	return typeof params === "object" && params !== null && "prompt" in params && typeof params.prompt === "string"
		? params.prompt
		: "";
}

function runsInBackground(params: unknown): boolean {
	return typeof params === "object" && params !== null && "run_in_background" in params
		? params.run_in_background === true
		: false;
}

function taskResult(taskId: string, params: unknown): AgentToolResult<unknown> {
	if (runsInBackground(params)) {
		return textResult(`Started ${taskId}`, {
			kind: "started",
			task_id: taskId,
			status: "running",
			name: taskId,
			run_epoch: 0,
		});
	}
	return textResult(`TASK_RESULT:${promptOf(params)}`, { task_id: taskId, run_epoch: 0, status: "completed" });
}

interface PendingHold {
	readonly enter: (call: TaskFixtureCall) => void;
	readonly released: Promise<void>;
	readonly settle: () => void;
}

function waitForRelease(hold: PendingHold, signal: AbortSignal | undefined): Promise<void> {
	if (signal === undefined) return hold.released;
	return new Promise<void>((resolve, reject) => {
		const onAbort = (): void => reject(signal.reason);
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		void hold.released.then(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		});
	});
}

export function createTaskFixture(): TaskFixture {
	const calls: TaskFixtureCall[] = [];
	const holds: PendingHold[] = [];
	let nextId = 0;
	const execute = async (
		toolName: string,
		params: unknown,
		options?: { readonly signal?: AbortSignal },
	): Promise<AgentToolResult<unknown>> => {
		const call = { toolName, params, signal: options?.signal };
		calls.push(call);
		nextId += 1;
		const taskId = `st_${nextId.toString(16).padStart(4, "0")}`;
		const hold = holds.shift();
		if (hold === undefined) return taskResult(taskId, params);
		hold.enter(call);
		try {
			await waitForRelease(hold, call.signal);
			return taskResult(taskId, params);
		} finally {
			hold.settle();
		}
	};
	const executeTool: AgentExecuteTool = Object.assign(execute, {
		isToolAvailable: (name: string) => name === TASK_FIXTURE_TOOL_NAME,
	});
	return {
		executeTool,
		calls,
		holdNext(): HeldTaskCall {
			const entered = Promise.withResolvers<TaskFixtureCall>();
			const released = Promise.withResolvers<void>();
			const settled = Promise.withResolvers<void>();
			holds.push({ enter: entered.resolve, released: released.promise, settle: () => settled.resolve() });
			return { entered: entered.promise, settled: settled.promise, release: () => released.resolve() };
		},
	};
}

export function createCompletionFixture(): CompletionFixture {
	const calls: CompletionFixtureCall[] = [];
	return {
		calls,
		complete: async (request, ctx) => {
			calls.push({ request, ctx });
			return { text: `COMPLETION:${request.prompt}`, details: { model: "fixture/model", structured: false } };
		},
	};
}
