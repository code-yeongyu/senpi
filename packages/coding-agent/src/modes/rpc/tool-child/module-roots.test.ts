// senpi#3566 todo 4 (review LOW 2): a session grants its tool child exactly the module files its tools declared, so a
// single-file extension in a broad directory never grants the modules beside it.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RegisteredTool } from "../../../core/extensions/types.ts";
import { ToolChildJobError } from "./entry.ts";
import { containedModulePath } from "./module-job.ts";
import { toolChildModuleRoots } from "./session-child.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tool(source: string, childModule?: { path: string; export: string }): RegisteredTool {
	const definition = {
		name: "t",
		label: "t",
		description: "t",
		parameters: {},
		execute: async () => ({ content: [], details: {} }),
		...(childModule ? { childModule } : {}),
	};
	return { definition, sourceInfo: { path: source } } as unknown as RegisteredTool;
}

function codeOf(run: () => unknown): string | undefined {
	try {
		run();
		return undefined;
	} catch (error) {
		return error instanceof ToolChildJobError ? error.code : String(error);
	}
}

describe("tool-child module roots", () => {
	it("grants the declared module file, and nothing else in the extension's directory", async () => {
		const broad = await mkdtemp(join(tmpdir(), "tmr-"));
		cleanups.push(() => rm(broad, { recursive: true, force: true }));
		await writeFile(join(broad, "ext.ts"), "");
		await writeFile(join(broad, "body.ts"), "export function run() {}");
		await writeFile(join(broad, "unrelated.ts"), "export function run() {}");
		const roots = toolChildModuleRoots([
			tool(join(broad, "ext.ts"), { path: "./body.ts", export: "run" }),
			tool(join(broad, "plain.ts")),
			tool("<inline>", { path: "/abs/never.ts", export: "run" }),
		]);
		expect(roots).toEqual([join(broad, "body.ts")]);
		expect(codeOf(() => containedModulePath(join(broad, "body.ts"), roots))).toBeUndefined();
		expect(codeOf(() => containedModulePath(join(broad, "unrelated.ts"), roots))).toBe("module_job_outside_roots");
	});
});
