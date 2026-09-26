import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionContext, KernelPreludeContribution } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it } from "vitest";
import senpiCodemode, { type CodemodeExtensionAPI } from "../src/index.ts";
import { fakeExtensionContext } from "./eval/fakes.ts";

type EvalTool = Parameters<CodemodeExtensionAPI["registerTool"]>[0];
type EvalLanguageUnderTest = "js" | "py";

const FIXTURE_WINDOWS = [{ id: 7, title: "Fixture window" }];
const ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const FIXTURE_DOC = "fx.windows() -> { windows, images } from the fixture tool";
const FIXTURE_PRELUDE: KernelPreludeContribution = {
	javascript: [
		"globalThis.fx = {",
		"  windows: async () => {",
		"    const result = await tool.fx({ op: 'windows' });",
		"    return { windows: JSON.parse(result.text), images: result.images ?? [] };",
		"  },",
		"};",
	].join("\n"),
	python: [
		"import json as _fx_json",
		"class _Fx:",
		"    def windows(self):",
		"        result = tool.fx({'op': 'windows'})",
		"        return {'windows': _fx_json.loads(result['text']), 'images': result.get('images') or []}",
		"fx = _Fx()",
	].join("\n"),
	documentation: FIXTURE_DOC,
	exports: ["fx"],
};
const PROBE: Readonly<Record<EvalLanguageUnderTest, string>> = {
	js: "const r = await fx.windows(); print('FX:' + JSON.stringify({ windows: r.windows, images: r.images.length }))",
	py: "import json\nr = fx.windows()\nprint('FX:' + json.dumps({'windows': r['windows'], 'images': len(r['images'])}, separators=(',', ':')))",
};
// Prints the class of the error a bare `fx` lookup raises, or FX:present when the global exists.
const LOOKUP: Readonly<Record<EvalLanguageUnderTest, string>> = {
	js: "try { fx; print('FX:present') } catch (error) { print('ERR:' + error.constructor.name) }",
	py: "try:\n    fx\n    print('FX:present')\nexcept Exception as error:\n    print('ERR:' + type(error).__name__)",
};
const MISSING_NAME_ERROR: Readonly<Record<EvalLanguageUnderTest, string>> = {
	js: "ERR:ReferenceError",
	py: "ERR:NameError",
};

/** A host whose tool registry and active set the test drives, holding one fixture tool with a kernel prelude. */
class PreludeHostPi implements CodemodeExtensionAPI {
	readonly #handlers: Array<{
		readonly event: string;
		readonly handler: (event: unknown, ctx: ExtensionContext) => unknown;
	}> = [];
	readonly active = new Set<string>(["eval"]);
	evalTool: EvalTool | undefined;

	registerTool(tool: EvalTool): void {
		this.evalTool = tool;
	}
	registerRemovedToolHint(): void {}
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void {
		this.#handlers.push({ event, handler });
	}
	getActiveTools(): string[] {
		return [...this.active];
	}
	getAllTools() {
		return [{ name: "eval" }, { name: "fx", description: "fixture", kernelPrelude: FIXTURE_PRELUDE }];
	}
	executeTool = Object.assign(
		async (toolName: string): Promise<AgentToolResult<unknown>> => {
			if (toolName !== "fx") throw new Error(`unexpected nested tool ${toolName}`);
			return {
				content: [
					{ type: "text", text: JSON.stringify(FIXTURE_WINDOWS) },
					{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" },
				],
				details: {},
			};
		},
		{ isToolAvailable: () => true },
	);
	sendMessage(): void {}
	async emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<void> {
		for (const entry of this.#handlers.filter((handler) => handler.event === event))
			await entry.handler(payload, ctx);
	}
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startSession(): Promise<{ readonly pi: PreludeHostPi; readonly ctx: ExtensionContext }> {
	const cwd = await mkdtemp(join(tmpdir(), "senpi-codemode-prelude-"));
	await mkdir(join(cwd, ".senpi"), { recursive: true });
	const pi = new PreludeHostPi();
	senpiCodemode(pi);
	const base = fakeExtensionContext();
	const ctx: ExtensionContext = {
		...base,
		cwd,
		sessionManager: { ...base.sessionManager, getSessionId: () => "prelude", getSessionFile: () => undefined },
	};
	cleanups.push(async () => {
		await pi.emit("session_shutdown", {}, ctx);
		await rm(cwd, { recursive: true, force: true });
	});
	await pi.emit("session_start", { reason: "startup", sessionId: "prelude" }, ctx);
	return { pi, ctx };
}

async function runCell(
	session: { readonly pi: PreludeHostPi; readonly ctx: ExtensionContext },
	language: EvalLanguageUnderTest,
	code: string,
): Promise<string> {
	const tool = session.pi.evalTool;
	if (tool === undefined) throw new Error("codemode registered no eval tool");
	const result = await tool.execute(
		`cell-${Math.random().toString(36).slice(2)}`,
		{ language, code, summary: "probe the fixture kernel prelude" },
		undefined,
		undefined,
		session.ctx,
	);
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function probeValue(output: string): unknown {
	const line = output.split("\n").find((candidate) => candidate.startsWith("FX:"));
	if (line === undefined) throw new Error(`cell printed no FX line:\n${output}`);
	return JSON.parse(line.slice("FX:".length));
}

describe.each(["js", "py"] as const)("kernel prelude contribution in the %s kernel", (language) => {
	it("leaves a registered but inactive tool's global undefined", async () => {
		// Given
		const session = await startSession();

		// When
		const output = await runCell(session, language, LOOKUP[language]);

		// Then
		expect(output.split("\n")).toContain(MISSING_NAME_ERROR[language]);
	});

	it("runs the active tool's global against the ordinary tool helper", async () => {
		// Given
		const session = await startSession();
		session.pi.active.add("fx");

		// When
		const output = await runCell(session, language, PROBE[language]);

		// Then
		expect(probeValue(output)).toEqual({ windows: FIXTURE_WINDOWS, images: 1 });
	});

	it("removes the global in the next cell once the tool is deactivated", async () => {
		// Given
		const session = await startSession();
		session.pi.active.add("fx");
		expect(probeValue(await runCell(session, language, PROBE[language]))).toEqual({
			windows: FIXTURE_WINDOWS,
			images: 1,
		});
		session.pi.active.delete("fx");

		// When
		const output = await runCell(session, language, LOOKUP[language]);

		// Then
		expect(output.split("\n")).toContain(MISSING_NAME_ERROR[language]);
	});
});

describe("kernel prelude contribution in the eval prompt", () => {
	it("documents the contribution only while its tool is active", async () => {
		// Given
		const session = await startSession();
		const inactiveDescription = session.pi.evalTool?.description;
		session.pi.active.add("fx");
		await session.pi.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 0 }, session.ctx);
		const activeDescription = session.pi.evalTool?.description;
		session.pi.active.delete("fx");

		// When
		await session.pi.emit("turn_start", { type: "turn_start", turnIndex: 2, timestamp: 0 }, session.ctx);

		// Then
		expect(inactiveDescription).not.toContain(FIXTURE_DOC);
		expect(activeDescription).toContain(FIXTURE_DOC);
		expect(session.pi.evalTool?.description).not.toContain(FIXTURE_DOC);
	});
});
