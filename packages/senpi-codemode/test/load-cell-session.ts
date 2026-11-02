import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach } from "vitest";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import { createInterpreterDetector, getInterpreterAvailability } from "../src/interpreters/detect.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalLanguage } from "../src/tool/types.ts";
import { fakeExtensionContext } from "./eval/fakes.ts";

export const settings = { ...defaultCodemodeSettings, languages: { js: true, py: true, rb: false, jl: false } };
export const availability = await getInterpreterAvailability(settings, createInterpreterDetector());
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export function textOf(result: AgentToolResult<unknown>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** A real session in a temp dir; a cell calling `tool.gate()` parks until \`openGate\` runs. */
export async function session(files: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), "senpi-load-cell-"));
	for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
	const gate = Promise.withResolvers<void>();
	const gateReached = Promise.withResolvers<void>();
	const fail = async () => {
		throw new Error("no host tools or provider calls in this test");
	};
	const executeTool = async (toolName: string): Promise<AgentToolResult<unknown>> => {
		if (toolName !== "gate") return await fail();
		gateReached.resolve();
		await gate.promise;
		return { content: [{ type: "text", text: "gate opened" }], details: undefined };
	};
	const artifactsDir = join(root, ".artifacts");
	const manager = await createCodemodeSessionManager({
		artifactsDir,
		sessionId: `load-cell-${crypto.randomUUID()}`,
		cwd: root,
		settings,
		availability,
		executeTool,
		complete: fail,
	});
	const tool = createEvalTool({
		enabledLanguages: { js: true, py: availability.py.detected.ok, rb: false, jl: false },
		kernelManager: manager,
		executeTool,
		artifactsDir,
		cellTimeoutSeconds: 60,
	});
	cleanups.push(async () => {
		await manager.dispose();
		await rm(root, { recursive: true, force: true });
	});
	const stackOf = async (code: string): Promise<string> => {
		const kernel = await manager.getKernel("py", () => {});
		const result = await kernel.run({ cellId: `stack-${crypto.randomUUID()}`, code, timeoutMs: 30_000 });
		return result.ok ? "" : (result.error.stack ?? "");
	};
	const context = { ...fakeExtensionContext(), cwd: root };
	const run = async (language: EvalLanguage, code: string, cellId = `load-${crypto.randomUUID()}`) =>
		await tool.execute(cellId, { language, code, summary: "Run a cell" }, undefined, undefined, context);
	const list = async () => {
		const listed = await tool.execute(
			`list-${crypto.randomUUID()}`,
			{ action: "list" },
			undefined,
			undefined,
			context,
		);
		return "cells" in listed.details ? listed.details.cells : [];
	};
	return { root, artifactsDir, run, list, stackOf, gateReached: gateReached.promise, openGate: () => gate.resolve() };
}
