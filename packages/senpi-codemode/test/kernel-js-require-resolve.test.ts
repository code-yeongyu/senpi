import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JavaScriptKernel, type JavaScriptKernelOptions } from "../src/kernels/js/context-manager.ts";
import { parseJavaScriptResult, runJavaScriptCell } from "./eval/js-kernel-harness.ts";

// The cell-global `require` matches Node's `require`: `resolve`, `resolve.paths` and `cache` exist, and the call and
// `resolve` share one lookup (builtins natively, then the project, then the managed package environment).
const kernels = new Set<JavaScriptKernel>();
const roots: string[] = [];

afterEach(async () => {
	await Promise.all([...kernels].map(async (kernel) => await kernel.close()));
	kernels.clear();
	await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function bunPath(): string | undefined {
	try {
		return execFileSync("bun", ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8" });
	} catch {
		return undefined;
	}
}
const bun = bunPath();

async function project(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-require-resolve-")));
	roots.push(root);
	const dep = join(root, "node_modules", "cjs-dep");
	await mkdir(dep, { recursive: true });
	await writeFile(join(dep, "package.json"), JSON.stringify({ name: "cjs-dep", main: "index.js" }));
	await writeFile(join(dep, "index.js"), "module.exports = 'dep';");
	await writeFile(join(root, "local.cjs"), "module.exports = 'local';");
	return root;
}

const modes: [string, (cwd: string) => Partial<JavaScriptKernelOptions> | undefined][] = [
	["worker", () => ({})],
	["process", () => (bun === undefined ? undefined : { isolation: "process", processExecPath: bun })],
];

describe.each(modes)("the cell-global require in %s mode (senpi#2832)", (_mode, options) => {
	// A mode whose runtime is missing (process mode without bun on PATH) is reported as skipped, never as a pass.
	const unavailable = options("") === undefined;
	async function kernelIn(cwd: string): Promise<JavaScriptKernel> {
		const extra = options(cwd);
		// Unreachable while the skip guard holds; a missing runtime must never fall back to worker defaults.
		if (extra === undefined) throw new Error("this mode's runtime is unavailable; the case should have been skipped");
		const kernel = new JavaScriptKernel({
			sessionId: `require-${crypto.randomUUID()}`,
			cwd,
			parallelPoolWidth: 2,
			...extra,
		});
		kernels.add(kernel);
		return kernel;
	}

	it.skipIf(unavailable)(
		"Given a project package and a relative file when a cell calls require.resolve then it gets the absolute paths the call itself would load",
		async () => {
			const cwd = await project();
			const kernel = await kernelIn(cwd);
			const run = await runJavaScriptCell(
				kernel,
				'return [require.resolve("cjs-dep"), require.resolve("./local.cjs"), require.resolve("node:path")]',
			);
			expect(parseJavaScriptResult(run.result)).toEqual([
				join(cwd, "node_modules", "cjs-dep", "index.js"),
				join(cwd, "local.cjs"),
				"node:path",
			]);
		},
	);

	it.skipIf(unavailable)(
		"Given a module that does not exist when a cell calls require.resolve then the runtime's not-found error names it",
		async () => {
			const cwd = await project();
			const kernel = await kernelIn(cwd);
			const run = await runJavaScriptCell(
				kernel,
				'try { require.resolve("no-such-pkg"); return "resolved" } catch (error) { return [error.code, String(error.message).includes("no-such-pkg")] }',
			);
			expect(parseJavaScriptResult(run.result)).toEqual(["MODULE_NOT_FOUND", true]);
		},
	);

	it.skipIf(unavailable)(
		"Given a cell when it reads require.resolve.paths and require.cache then both exist, and the cache holds a module the cell required",
		async () => {
			const cwd = await project();
			const kernel = await kernelIn(cwd);
			const run = await runJavaScriptCell(
				kernel,
				'require("cjs-dep"); const paths = require.resolve.paths("cjs-dep"); return [Array.isArray(paths) && paths.includes(require("node:path").join(process.cwd(), "node_modules")), typeof require.cache, Object.keys(require.cache).some((key) => key.endsWith("cjs-dep/index.js"))]',
			);
			expect(parseJavaScriptResult(run.result)).toEqual([true, "object", true]);
		},
	);
});

describe.skipIf(bun === undefined)("the cell-global require under Bun, the product's runtime (senpi#2832)", () => {
	it("Given a Bun builtin when a process-mode cell resolves and requires it then the id is Bun's own and it loads", async () => {
		const cwd = await project();
		const kernel = new JavaScriptKernel({
			sessionId: `require-${crypto.randomUUID()}`,
			cwd,
			parallelPoolWidth: 2,
			isolation: "process",
			processExecPath: bun ?? "bun",
		});
		kernels.add(kernel);
		const run = await runJavaScriptCell(
			kernel,
			'return [require.resolve("bun:sqlite"), typeof require(require.resolve("bun:sqlite")).Database]',
		);
		expect(parseJavaScriptResult(run.result)).toEqual(["bun:sqlite", "function"]);
	});
});
