import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeModeTool } from "../../src/codemode/tools.ts";
import type { CodemodeSessionManager } from "../../src/extension/session-manager.ts";
import senpiCodemode, { type CodemodeExtensionAPI } from "../../src/index.ts";
import type { EvalKernelResult, EvalKernelRunInput } from "../../src/tool/types.ts";
import { fakeExtensionContext } from "../eval/fakes.ts";

type RegisteredHandler = {
	readonly event: string;
	readonly handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
};

type PublicCodeModeTool = {
	readonly name: "exec" | "wait";
	readonly execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<unknown>;
};

type RegisteredTool = Parameters<CodemodeExtensionAPI["registerTool"]>[0] | CodeModeTool;

class FakePi {
	readonly tools: RegisteredTool[] = [];
	readonly handlers: RegisteredHandler[] = [];
	readonly nestedCalls: { readonly name: string; readonly args: unknown }[] = [];
	#activeTools = new Set<string>(["eval", "echo", "hold"]);

	registerTool(tool: RegisteredTool): void {
		this.tools.push(tool);
	}

	on(event: string, handler: RegisteredHandler["handler"]): void {
		this.handlers.push({ event, handler });
	}

	getActiveTools(): string[] {
		return [...this.#activeTools];
	}

	getAllTools(): readonly { readonly name: string }[] {
		return this.tools.map((tool) => ({ name: tool.name }));
	}

	setActiveTools(toolNames: string[]): void {
		this.#activeTools = new Set(toolNames);
	}

	async executeTool(
		toolName: string,
		params: unknown,
	): Promise<{
		content: { type: "text"; text: string }[];
		readonly details: undefined;
	}> {
		this.nestedCalls.push({ name: toolName, args: params });
		if (toolName === "echo") return { content: [{ type: "text", text: "nested result" }], details: undefined };
		return await new Promise(() => undefined);
	}
}

class FakeSessionManager implements CodemodeSessionManager {
	async getKernel(): Promise<{
		run(input: EvalKernelRunInput): Promise<EvalKernelResult>;
		interrupt(): Promise<void>;
		deliverToolReply(): void;
		reset(): Promise<void>;
		close(): Promise<void>;
	}> {
		throw new Error("eval kernel was not expected");
	}

	async complete(): Promise<never> {
		throw new Error("completion was not expected");
	}

	async dispose(): Promise<void> {}
}

function fakeModel(id: string): Model<Api> {
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

function context(cwd: string, modelId: string): ExtensionContext {
	const base = fakeExtensionContext();
	return {
		...base,
		cwd,
		model: fakeModel(modelId),
		sessionManager: {
			...base.sessionManager,
			getSessionFile: () => join(cwd, `${crypto.randomUUID()}.jsonl`),
		},
	};
}

async function emit(pi: FakePi, event: string, payload: unknown, ctx: ExtensionContext): Promise<void> {
	for (const entry of pi.handlers.filter((handler) => handler.event === event)) {
		await entry.handler(payload, ctx);
	}
}

function findPublicTool(pi: FakePi, name: PublicCodeModeTool["name"]): PublicCodeModeTool {
	const candidate = pi.tools.find((tool) => tool.name === name);
	if (!isPublicCodeModeTool(candidate, name)) throw new Error(`${name} tool was not registered`);
	return candidate;
}

function isPublicCodeModeTool(value: unknown, name: PublicCodeModeTool["name"]): value is PublicCodeModeTool {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		value.name === name &&
		"execute" in value &&
		typeof value.execute === "function"
	);
}

function cellIdFrom(result: unknown): string {
	if (
		typeof result !== "object" ||
		result === null ||
		!("details" in result) ||
		typeof result.details !== "object" ||
		result.details === null ||
		!("cellId" in result.details) ||
		typeof result.details.cellId !== "string"
	) {
		throw new Error("Code Mode result did not include a cellId");
	}
	return result.details.cellId;
}

describe("GPT Code Mode public tools", () => {
	afterEach(() => vi.clearAllMocks());

	it("exposes exec and wait for GPT while preserving eval", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "senpi-gpt-code-mode-"));
		const pi = new FakePi();
		const ctx = context(cwd, "gpt-5.6");
		senpiCodemode(pi, { createSessionManager: () => new FakeSessionManager() });

		try {
			await emit(pi, "session_start", { sessionId: "gpt-code-mode-session" }, ctx);

			expect(pi.tools.map((tool) => tool.name)).toContain("eval");
			expect(pi.tools.map((tool) => tool.name)).toContain("exec");
			expect(pi.tools.map((tool) => tool.name)).toContain("wait");
			expect(pi.getActiveTools()).toEqual(expect.arrayContaining(["eval", "exec", "wait"]));
		} finally {
			await emit(pi, "session_shutdown", {}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("keeps GPT Code Mode unavailable to non-GPT models", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "senpi-gpt-code-mode-"));
		const pi = new FakePi();
		const ctx = context(cwd, "claude-sonnet-4-6");
		senpiCodemode(pi, { createSessionManager: () => new FakeSessionManager() });

		try {
			await emit(pi, "session_start", { sessionId: "non-gpt-session" }, ctx);

			expect(pi.tools.map((tool) => tool.name)).toContain("eval");
			expect(pi.getActiveTools()).toContain("eval");
			expect(pi.getActiveTools()).not.toContain("exec");
			expect(pi.getActiveTools()).not.toContain("wait");
		} finally {
			await emit(pi, "session_shutdown", {}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("runs a nested tool through exec and terminates its yielded cell through wait", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "senpi-gpt-code-mode-"));
		const pi = new FakePi();
		const ctx = context(cwd, "gpt-5.6");
		senpiCodemode(pi, { createSessionManager: () => new FakeSessionManager() });

		try {
			await emit(pi, "session_start", { sessionId: "nested-tool-session" }, ctx);
			const exec = findPublicTool(pi, "exec");
			const wait = findPublicTool(pi, "wait");

			const completed = await exec.execute(
				"nested-tool-call",
				{ code: 'print(await tools.echo({ value: "nested" }))', yield_time_ms: 100 },
				undefined,
				undefined,
				ctx,
			);

			expect(pi.nestedCalls).toEqual([{ name: "echo", args: { value: "nested" } }]);
			expect(completed).toMatchObject({
				content: [{ type: "text", text: expect.stringContaining("nested result") }],
				details: { state: "result" },
			});

			const yielded = await exec.execute(
				"yielded-cell",
				{ code: "await tools.hold({});", yield_time_ms: 1 },
				undefined,
				undefined,
				ctx,
			);
			const terminated = await wait.execute(
				"terminate-cell",
				{ cell_id: cellIdFrom(yielded), terminate: true },
				undefined,
				undefined,
				ctx,
			);

			expect(terminated).toMatchObject({ details: { state: "terminated" } });
		} finally {
			await emit(pi, "session_shutdown", {}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
