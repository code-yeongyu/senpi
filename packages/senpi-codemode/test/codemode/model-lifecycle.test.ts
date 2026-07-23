import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { CodeModeTool } from "../../src/codemode/tools.ts";
import type { CodemodeSessionManager } from "../../src/extension/session-manager.ts";
import senpiCodemode, { type CodemodeExtensionAPI } from "../../src/index.ts";
import type { EvalKernelResult, EvalKernelRunInput } from "../../src/tool/types.ts";
import { fakeExtensionContext } from "../eval/fakes.ts";

type RegisteredTool = Parameters<CodemodeExtensionAPI["registerTool"]>[0] | CodeModeTool;
type ExecTool = {
	readonly name: "exec";
	readonly execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<unknown>;
};

class FakePi {
	readonly tools: RegisteredTool[] = [];
	readonly handlers: {
		readonly event: string;
		readonly handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
	}[] = [];
	readonly holdStarted = Promise.withResolvers<void>();
	readonly holdAborted = Promise.withResolvers<void>();
	#active = new Set<string>(["eval", "hold"]);

	registerTool(tool: RegisteredTool): void {
		const index = this.tools.findIndex((current) => current.name === tool.name);
		if (index === -1) this.tools.push(tool);
		else this.tools[index] = tool;
	}

	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void {
		this.handlers.push({ event, handler });
	}

	getActiveTools(): string[] {
		return [...this.#active];
	}

	getAllTools(): readonly { readonly name: string }[] {
		return this.tools.map((tool) => ({ name: tool.name }));
	}

	setActiveTools(names: string[]): void {
		this.#active = new Set(names);
	}

	async executeTool(_name: string, _params: unknown, options?: { readonly signal?: AbortSignal }): Promise<never> {
		this.holdStarted.resolve();
		const signal = options?.signal;
		return await new Promise((_, reject) => {
			signal?.addEventListener(
				"abort",
				() => {
					this.holdAborted.resolve();
					reject(signal.reason);
				},
				{ once: true },
			);
		});
	}
}

class FakeManager implements CodemodeSessionManager {
	async getKernel(): Promise<{
		run(input: EvalKernelRunInput): Promise<EvalKernelResult>;
		interrupt(): Promise<void>;
		deliverToolReply(): void;
		reset(): Promise<void>;
		close(): Promise<void>;
	}> {
		throw new Error("eval was not expected");
	}

	async complete(): Promise<never> {
		throw new Error("completion was not expected");
	}

	async dispose(): Promise<void> {}
}

function model(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "fake-api",
		provider: "fake",
		baseUrl: "https://fake.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000,
		maxTokens: 100,
	};
}

function context(cwd: string): ExtensionContext {
	const base = fakeExtensionContext();
	return {
		...base,
		cwd,
		model: model("gpt-5.6"),
		sessionManager: { ...base.sessionManager, getSessionFile: () => join(cwd, "session.jsonl") },
	};
}

async function emit(pi: FakePi, event: string, payload: unknown, ctx: ExtensionContext): Promise<void> {
	for (const entry of pi.handlers.filter((handler) => handler.event === event)) {
		await entry.handler(payload, ctx);
	}
}

function execTool(pi: FakePi): ExecTool {
	const tool = pi.tools.find((candidate) => candidate.name === "exec");
	if (!isExecTool(tool)) throw new Error("exec tool was not registered");
	return tool;
}

function isExecTool(tool: RegisteredTool | undefined): tool is RegisteredTool & ExecTool {
	return tool?.name === "exec";
}

describe("GPT Code Mode lifecycle", () => {
	it.each([
		{
			name: "switching to a non-GPT model",
			transition: async (pi: FakePi, ctx: ExtensionContext) =>
				await emit(pi, "model_select", { model: model("claude-sonnet-4-6") }, ctx),
		},
		{
			name: "replacing the session runtime",
			transition: async (pi: FakePi, ctx: ExtensionContext) => await emit(pi, "session_start", {}, ctx),
		},
		{
			name: "shutting down the session",
			transition: async (pi: FakePi, ctx: ExtensionContext) => await emit(pi, "session_shutdown", {}, ctx),
		},
		{
			name: "switching sessions",
			transition: async (pi: FakePi, ctx: ExtensionContext) => await emit(pi, "session_before_switch", {}, ctx),
		},
		{
			name: "forking the session",
			transition: async (pi: FakePi, ctx: ExtensionContext) => await emit(pi, "session_before_fork", {}, ctx),
		},
	])("terminates yielded cells when $name", async ({ transition }) => {
		const cwd = await mkdtemp(join(tmpdir(), "senpi-gpt-code-mode-lifecycle-"));
		const pi = new FakePi();
		const ctx = context(cwd);
		senpiCodemode(pi, { createSessionManager: () => new FakeManager() });

		try {
			await emit(pi, "session_start", {}, ctx);
			const execution = execTool(pi).execute(
				"yielded-cell",
				{ code: "await tools.hold({})", yield_time_ms: 1_000 },
				undefined,
				undefined,
				ctx,
			);
			await expect(pi.holdStarted.promise).resolves.toBeUndefined();

			await transition(pi, ctx);

			await expect(pi.holdAborted.promise).resolves.toBeUndefined();
			await expect(execution).resolves.toMatchObject({ details: { state: "terminated" } });
			if (pi.getActiveTools().includes("exec")) {
				expect(pi.getActiveTools()).toContain("wait");
			} else {
				expect(pi.getActiveTools()).not.toEqual(expect.arrayContaining(["exec", "wait"]));
			}
		} finally {
			await emit(pi, "session_shutdown", {}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("creates a fresh executable cell runtime after returning to GPT", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "senpi-gpt-code-mode-lifecycle-"));
		const pi = new FakePi();
		const ctx = context(cwd);
		senpiCodemode(pi, { createSessionManager: () => new FakeManager() });

		try {
			await emit(pi, "session_start", {}, ctx);
			const running = execTool(pi).execute(
				"yielded-cell",
				{ code: "await tools.hold({})", yield_time_ms: 1_000 },
				undefined,
				undefined,
				ctx,
			);
			await expect(pi.holdStarted.promise).resolves.toBeUndefined();
			await emit(pi, "model_select", { model: model("claude-sonnet-4-6") }, ctx);
			await expect(running).resolves.toMatchObject({ details: { state: "terminated" } });

			await emit(pi, "model_select", { model: model("gpt-5.6") }, ctx);
			const fresh = await execTool(pi).execute(
				"fresh-cell",
				{ code: 'print("fresh-runtime")', yield_time_ms: 1_000 },
				undefined,
				undefined,
				ctx,
			);

			expect(fresh).toMatchObject({
				content: [{ type: "text", text: expect.stringContaining("fresh-runtime") }],
				details: { state: "result" },
			});
		} finally {
			await emit(pi, "session_shutdown", {}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
