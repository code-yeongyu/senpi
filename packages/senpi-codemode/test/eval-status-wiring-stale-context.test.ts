import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ExtensionToolContext } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodemodeSessionManager } from "../src/extension/session-manager.ts";
import senpiCodemode, { type CodemodeExtensionAPI } from "../src/index.ts";
import type { EvalKernel } from "../src/tool/types.ts";
import { FakeKernel, fakeExtensionContext } from "./eval/fakes.ts";

const RELOAD_STALE_MESSAGE = "stale extension generation after reload";
const REPLACEMENT_STALE_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

class GenerationPi {
	readonly handlers: Array<{ readonly event: string; readonly handler: Handler }> = [];
	registeredTool: Parameters<CodemodeExtensionAPI["registerTool"]>[0] | undefined;

	registerTool(tool: Parameters<CodemodeExtensionAPI["registerTool"]>[0]): void {
		if (tool.name === "eval") this.registeredTool = tool;
	}
	registerRemovedToolHint(): void {}
	on(event: string, handler: Handler): void {
		this.handlers.push({ event, handler });
	}
	getActiveTools(): string[] {
		return ["eval"];
	}
	getAllTools(): readonly { readonly name: string }[] {
		return [{ name: "eval" }];
	}
	async executeTool(): Promise<never> {
		throw new Error("nested tool execution was not expected");
	}
	sendMessage(): void {}
	async emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<void> {
		for (const entry of this.handlers.filter((handler) => handler.event === event)) await entry.handler(payload, ctx);
	}
}

class KernelOwner implements CodemodeSessionManager {
	readonly kernel: FakeKernel;

	constructor(kernel: FakeKernel) {
		this.kernel = kernel;
	}
	async getKernel(): Promise<EvalKernel> {
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

const directories: string[] = [];

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

async function sessionCwd(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "senpi-codemode-2549-"));
	directories.push(cwd);
	await mkdir(join(cwd, ".senpi"), { recursive: true });
	await writeFile(
		join(cwd, ".senpi", "codemode.json"),
		JSON.stringify({ languages: { py: false, js: true, rb: false, jl: false }, cellTimeoutSeconds: 1 }),
	);
	return cwd;
}

/** A session context whose `ui` and `mode` throw once retired, like the host runner's guarded getters. */
function sessionContext(cwd: string, sessionId: string, statuses: Array<string | undefined>) {
	let staleMessage: string | undefined;
	const ui = Object.create(null);
	ui.setStatus = (_key: string, text: string | undefined): void => {
		statuses.push(text);
	};
	const sessionManager = Object.create(null);
	sessionManager.getSessionId = (): string => sessionId;
	sessionManager.getSessionFile = (): string => join(cwd, `${sessionId}.jsonl`);
	const context: ExtensionToolContext = { ...fakeExtensionContext(), cwd, hasUI: true, sessionManager };
	Object.defineProperty(context, "ui", {
		get: () => {
			if (staleMessage !== undefined) throw new Error(staleMessage);
			return ui;
		},
	});
	Object.defineProperty(context, "mode", {
		get: () => {
			if (staleMessage !== undefined) throw new Error(staleMessage);
			return "rpc";
		},
	});
	return {
		context,
		retire(message: string) {
			staleMessage = message;
		},
		/** Teardown only: lets the test shut a retired generation's kernel down; the host never revives a context. */
		revive() {
			staleMessage = undefined;
		},
	};
}

async function detach(
	pi: GenerationPi,
	kernel: FakeKernel,
	ctx: ExtensionToolContext,
	cellId: string,
	summary: string,
) {
	const tool = pi.registeredTool;
	if (!tool) throw new Error("eval tool was not registered");
	const started = kernel.deferNextRun();
	const execution = tool.execute(
		cellId,
		{ language: "js", code: "await forever", summary, on_timeout: "detach" },
		undefined,
		undefined,
		ctx,
	);
	await started;
	await vi.advanceTimersByTimeAsync(1_000);
	await execution;
}

async function startGeneration(cwd: string, sessionId: string, reason: string) {
	const pi = new GenerationPi();
	const kernel = new FakeKernel([]);
	senpiCodemode(pi, { createSessionManager: () => new KernelOwner(kernel) });
	const statuses: Array<string | undefined> = [];
	const session = sessionContext(cwd, sessionId, statuses);
	await pi.emit("session_start", { reason }, session.context);
	return { pi, kernel, statuses, ...session };
}

// The runner builds a fresh extension instance for the next session. The retired one is a
// session disposed without session_shutdown (as app-server thread unload does), so its
// ticker is still armed when its context retires.
describe("#2549 eval footer status across a retired session", () => {
	it.each([
		{ label: "reload", message: RELOAD_STALE_MESSAGE, reason: "reload", nextSession: "session-a" },
		{ label: "new session", message: REPLACEMENT_STALE_MESSAGE, reason: "new", nextSession: "session-b" },
		{ label: "session switch", message: REPLACEMENT_STALE_MESSAGE, reason: "resume", nextSession: "session-c" },
	])(
		"survives a $label while a detached cell ticks and renders the next session's cell",
		async ({ message, reason, nextSession }) => {
			vi.useFakeTimers();
			const cwd = await sessionCwd();
			const first = await startGeneration(cwd, "session-a", "startup");
			await detach(first.pi, first.kernel, first.context, "first-cell", "first probe");
			expect(first.statuses.at(-1)).toBe("↗ js · first probe (1s)");

			first.retire(message);
			const rendersBeforeRetiredTick = first.statuses.length;
			await expect(vi.advanceTimersByTimeAsync(1_000)).resolves.not.toThrow();
			await vi.advanceTimersByTimeAsync(2_000);
			expect(first.statuses).toHaveLength(rendersBeforeRetiredTick);

			const next = await startGeneration(cwd, nextSession, reason);
			await detach(next.pi, next.kernel, next.context, "next-cell", "next probe");
			expect(next.statuses.at(-1)).toBe("↗ js · next probe (1s)");

			await vi.advanceTimersByTimeAsync(1_000);
			expect(next.statuses.at(-1)).toBe("↗ js · next probe (2s)");

			await next.pi.emit("session_shutdown", { reason: "quit" }, next.context);
			first.revive();
			await first.pi.emit("session_shutdown", { reason: "quit" }, first.context);
		},
	);
});
