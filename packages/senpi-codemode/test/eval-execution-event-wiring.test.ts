import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionContext } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import type { CodemodeSessionManager } from "../src/extension/session-manager.ts";
import senpiCodemode, { type CodemodeExtensionAPI } from "../src/index.ts";
import { EVAL_EXECUTION_EVENT } from "../src/tool/eval-execution-event.ts";
import { FakeKernel, fakeExtensionContext, result } from "./eval/fakes.ts";

const directories: string[] = [];
const artifactsRoot = join(tmpdir(), `senpi-codemode-eval-execution-${process.pid}`);

afterEach(async () => {
	await Promise.all(directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
	await rm(artifactsRoot, { recursive: true, force: true });
});

interface BusEmission {
	readonly name: string;
	readonly data: unknown;
}

class WiringPi {
	readonly handlers: Array<{
		readonly event: string;
		readonly handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
	}> = [];
	registeredTool: Parameters<CodemodeExtensionAPI["registerTool"]>[0] | undefined;
	events?: { emit(name: string, data: unknown): void };
	rpc?: { emit(name: string, data: unknown): void };

	registerTool(tool: Parameters<CodemodeExtensionAPI["registerTool"]>[0]): void {
		if (tool.name === "eval") this.registeredTool = tool;
	}
	registerRemovedToolHint(): void {}
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void {
		this.handlers.push({ event, handler });
	}
	getActiveTools(): string[] {
		return ["eval"];
	}
	getAllTools(): readonly { readonly name: string }[] {
		return [{ name: "eval" }];
	}
	async executeTool(): Promise<AgentToolResult<unknown>> {
		return {
			content: [{ type: "text", text: "PRIVATE RESULT" }],
			details: {},
		};
	}
	sendMessage(): void {}
	async emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<void> {
		for (const entry of this.handlers.filter((handler) => handler.event === event)) await entry.handler(payload, ctx);
	}
}

class WiringSessionManager implements CodemodeSessionManager {
	readonly kernel: FakeKernel;
	constructor(kernel: FakeKernel) {
		this.kernel = kernel;
	}
	async getKernel(_language: string, onMessage: (message: KernelToHostMessage) => void): Promise<FakeKernel> {
		this.kernel.onMessage = onMessage;
		return this.kernel;
	}
	async dispose(): Promise<void> {}
	async complete(): Promise<{
		readonly text: string;
		readonly details: { readonly model: string; readonly structured: false };
	}> {
		return { text: "ok", details: { model: "fake/fake-model", structured: false } };
	}
}

async function sessionCwd(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "senpi-codemode-eval-execution-"));
	directories.push(cwd);
	await mkdir(join(cwd, ".senpi"), { recursive: true });
	await writeFile(
		join(cwd, ".senpi", "codemode.json"),
		JSON.stringify({ languages: { py: false, js: true, rb: false, jl: false }, cellTimeoutSeconds: 1 }),
	);
	return cwd;
}

function wiringContext(cwd: string): ExtensionContext {
	const base = fakeExtensionContext();
	const sessionManager = Object.create(null);
	sessionManager.getSessionFile = (): string => join(artifactsRoot, `${crypto.randomUUID()}.jsonl`);
	return { ...base, cwd, sessionManager };
}

describe("eval execution host wiring", () => {
	it("publishes each session-scoped settle payload to both rpc and the extension event bus", async () => {
		const cwd = await sessionCwd();
		const pi = new WiringPi();
		const rpcEmissions: BusEmission[] = [];
		const busEmissions: BusEmission[] = [];
		pi.rpc = { emit: (name, data) => rpcEmissions.push({ name, data }) };
		pi.events = { emit: (name, data) => busEmissions.push({ name, data }) };
		const kernel = new FakeKernel([
			{
				type: "tool-call",
				callId: "sensitive-read",
				toolName: "read",
				args: { path: "secret.txt", prompt: "PRIVATE PROMPT" },
			},
			result("wired-cell", "42", 17),
		]);
		senpiCodemode(pi, { createSessionManager: () => new WiringSessionManager(kernel) });
		const ctx = wiringContext(cwd);
		await pi.emit("session_start", { reason: "startup" }, ctx);
		const tool = pi.registeredTool;
		if (tool === undefined) throw new Error("eval tool was not registered");

		await tool.execute("wired-cell", { language: "js", code: "42", summary: "wired" }, undefined, undefined, ctx);

		expect(rpcEmissions).toEqual([
			{
				name: EVAL_EXECUTION_EVENT,
				data: expect.objectContaining({
					cellId: "wired-cell",
					detailLevel: "metadata",
					toolCalls: [{ name: "read", ok: true, durationMs: expect.any(Number) }],
				}),
			},
		]);
		expect(rpcEmissions[0]?.data).not.toEqual(
			expect.objectContaining({
				error: expect.anything(),
				toolCalls: [expect.objectContaining({ args: expect.anything() })],
			}),
		);
		expect(busEmissions).toContainEqual({
			name: EVAL_EXECUTION_EVENT,
			data: expect.objectContaining({
				cellId: "wired-cell",
				detailLevel: "full",
				toolCalls: [
					expect.objectContaining({
						callId: "sensitive-read",
						args: { path: "secret.txt", prompt: "PRIVATE PROMPT" },
						resultPreview: "PRIVATE RESULT",
					}),
				],
			}),
		});
		await pi.emit("session_shutdown", {}, ctx);
	});
});
