import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCodemodeSettings } from "../../src/config/settings.ts";
import { createCodemodeSessionManager } from "../../src/extension/session-manager.ts";
import { createInterpreterDetector, getInterpreterAvailability } from "../../src/interpreters/detect.ts";
import { createEvalTool } from "../../src/tool/eval-tool.ts";
import { fakeExtensionContext } from "../eval/fakes.ts";

const baseSettings = { ...defaultCodemodeSettings, languages: { js: true, py: false, rb: false, jl: false } };
const availability = await getInterpreterAvailability(baseSettings, createInterpreterDetector());
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function textOf(result: AgentToolResult<unknown>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

async function session(sandbox: { enabled: boolean; memoryMb?: number; timeoutSeconds?: number } = { enabled: true }) {
	const root = await mkdtemp(join(tmpdir(), "senpi-isolated-"));
	const settings = { ...baseSettings, sandbox };
	const reads: unknown[] = [];
	const executeTool = async (name: string, params: unknown): Promise<AgentToolResult<unknown>> => {
		if (name === "read") {
			reads.push(params);
			return { content: [{ type: "text", text: "file body" }], details: {} };
		}
		throw new Error(`no tool ${name}`);
	};
	const manager = await createCodemodeSessionManager({
		sessionId: `isolated-${crypto.randomUUID()}`,
		cwd: root,
		settings,
		availability,
		executeTool,
		complete: async () => {
			throw new Error("no provider calls in this test");
		},
	});
	const tool = createEvalTool({
		enabledLanguages: settings.languages,
		kernelManager: manager,
		executeTool,
		listTools: () => [{ name: "read", description: "read a file" }, { name: "eval" }],
		cellTimeoutSeconds: 120,
		settings,
	});
	cleanups.push(async () => {
		await manager.dispose();
		await rm(root, { recursive: true, force: true });
	});
	const context = { ...fakeExtensionContext(), cwd: root };
	const run = async (code: string, isolate = false) =>
		await tool.execute(
			`cell-${crypto.randomUUID()}`,
			{ language: "js", code, summary: "Run a cell", ...(isolate ? { isolate: true } : {}) },
			undefined,
			undefined,
			context,
		);
	return { run, reads, tool };
}

describe("Given sandbox cells are turned on", () => {
	it("isolated-cell-has-no-ambient-host-or-persistence: the isolated cell sees neither the persistent kernel's globals nor process, can call tool.read, and the next isolated cell is fresh", async () => {
		const { run, reads } = await session();
		await run("globalThis.sentinel = 'persistent'; 'set'");

		const probe = await run(
			"const seen = [typeof sentinel, typeof process, typeof require, typeof setTimeout]; globalThis.leak = 1; const body = await tools.read({ path: 'x' }); return [seen.join(','), body.text].join(' | ')",
			true,
		);
		const listed = await run("return ALL_TOOLS.map((tool) => tool.name).sort().join(',')", true);
		const fresh = await run("return typeof leak", true);
		const persistent = await run("sentinel");

		expect(textOf(probe)).toContain("undefined,undefined,undefined,undefined | file body");
		expect(reads).toEqual([{ path: "x" }]);
		expect(textOf(listed)).toBe("read");
		expect(textOf(fresh)).toContain("undefined");
		expect(textOf(persistent)).toContain("persistent");
	}, 120_000);

	it("isolated-result-contract: printed text, a returned value and an error use the normal result contract", async () => {
		const { run } = await session();

		const printed = await run('print("hello"); console.log({ a: 1 }); return { done: true }', true);
		const failed = await run("throw new TypeError('bad input')", true);

		expect(textOf(printed)).toContain("hello");
		expect(textOf(printed)).toContain('{"a":1}');
		expect(textOf(printed)).toContain('{"done":true}');
		expect(printed.details).toMatchObject({ cells: [{ status: "complete" }] });
		expect(textOf(failed)).toBe("bad input");
		expect(failed.details).toMatchObject({ cells: [{ status: "error" }] });
	}, 120_000);

	it("large-item-fidelity: one 20 MiB printed item reaches the result contract complete, exactly as the persistent kernel reports the same output", async () => {
		const { run } = await session();
		const size = 20 * 1024 * 1024;

		const isolated = await run(`print("x".repeat(${size})); return "ok"`, true);
		const persistent = await run(`console.log("x".repeat(${size})); "ok"`);
		const meta = (result: AgentToolResult<unknown>) =>
			(result.details as unknown as { meta: { totalBytes: number; totalLines: number; truncatedBy: string } }).meta;

		expect(meta(isolated).totalBytes).toBeGreaterThanOrEqual(size);
		expect(meta(isolated)).toMatchObject({
			totalLines: meta(persistent).totalLines,
			truncatedBy: meta(persistent).truncatedBy,
		});
		expect(Math.abs(meta(isolated).totalBytes - meta(persistent).totalBytes)).toBeLessThanOrEqual(2);
		expect((isolated.details as unknown as { cells: { status: string }[] }).cells[0]?.status).toBe("complete");
	}, 180_000);

	it("a 256 MiB allocation fails with eval_isolate_memory_limit and the persistent kernel keeps its globals", async () => {
		const { run } = await session({ enabled: true, memoryMb: 64 });
		await run("globalThis.kept = 42; 'kept'");

		const result = await run(
			'const parts = []; for (let i = 0; i < 64; i++) parts.push("y".repeat(4 * 1024 * 1024)); return parts.length',
			true,
		);
		const after = await run("kept");

		expect(textOf(result)).toContain("eval_isolate_memory_limit");
		expect(textOf(after)).toContain("42");
	}, 120_000);

	it("a promise that never settles fails with eval_isolate_unresolved_promise", async () => {
		const { run } = await session();

		const result = await run("await new Promise(() => {})", true);

		expect(textOf(result)).toContain("eval_isolate_unresolved_promise");
	}, 120_000);

	it("store() throws eval_isolate_no_state and load() finds nothing", async () => {
		const { run } = await session();

		const loaded = await run('return String(load("k"))', true);
		const stored = await run('store("k", 1)', true);

		expect(textOf(loaded)).toContain("undefined");
		expect(textOf(stored)).toContain("eval_isolate_no_state");
	}, 60_000);
});

describe("Given sandbox cells are turned off", () => {
	it("isolate: true is refused with eval_isolate_invalid and the code does not run", async () => {
		const { run } = await session({ enabled: false });

		await expect(run("globalThis.ran = true", true)).rejects.toThrow("eval_isolate_invalid");
		const check = await run("typeof ran");

		expect(textOf(check)).toContain("undefined");
	}, 60_000);
});
