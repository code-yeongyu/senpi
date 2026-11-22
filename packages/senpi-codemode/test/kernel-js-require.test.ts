import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseJavaScriptResult, runJavaScriptCell, withJavaScriptKernel } from "./eval/js-kernel-harness.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "senpi-require-"));
	roots.push(root);
	const dep = join(root, "node_modules", "cjs-dep");
	await mkdir(dep, { recursive: true });
	await writeFile(join(dep, "package.json"), JSON.stringify({ name: "cjs-dep", main: "index.js" }));
	await writeFile(join(dep, "index.js"), "module.exports = { greet: (name) => 'hi ' + name };");
	await writeFile(join(root, "data.json"), JSON.stringify({ answer: 42 }));
	await writeFile(join(root, "local.cjs"), "module.exports = 'local module';");
	return root;
}

describe("require in JavaScript cells", () => {
	it("Given a cell when it requires a builtin then it gets the runtime's module, with or without the node: prefix", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(
				kernel,
				'return [require("node:path").join("a", "b"), require("fs") === require("node:fs")]',
			);
			expect(parseJavaScriptResult(run.result)).toEqual(["a/b", true]);
		});
	});

	it("Given a project with a CommonJS package when a cell requires it then the package from the project's node_modules loads", async () => {
		const cwd = await project();
		await withJavaScriptKernel(
			async (kernel) => {
				const run = await runJavaScriptCell(kernel, 'return require("cjs-dep").greet("cell")');
				expect(parseJavaScriptResult(run.result)).toBe("hi cell");
			},
			{ cwd },
		);
	});

	it("Given a cell when it requires a relative CommonJS file and a JSON file then both resolve from the session directory", async () => {
		const cwd = await project();
		await withJavaScriptKernel(
			async (kernel) => {
				const run = await runJavaScriptCell(
					kernel,
					'return [require("./local.cjs"), require("./data.json").answer]',
				);
				expect(parseJavaScriptResult(run.result)).toEqual(["local module", 42]);
			},
			{ cwd },
		);
	});

	it("Given a cell when it builds its own require with createRequire then that require resolves from the given path", async () => {
		const cwd = await project();
		await withJavaScriptKernel(
			async (kernel) => {
				const run = await runJavaScriptCell(
					kernel,
					`return createRequire(${JSON.stringify(join(cwd, "package.json"))})("cjs-dep").greet("own")`,
				);
				expect(parseJavaScriptResult(run.result)).toBe("hi own");
			},
			{ cwd },
		);
	});

	it("Given a cell that builds its own require from createRequire, the common ESM idiom, when it runs then its require works and later cells keep it", async () => {
		const cwd = await project();
		await withJavaScriptKernel(
			async (kernel) => {
				const declared = await runJavaScriptCell(
					kernel,
					`const require = createRequire(${JSON.stringify(join(cwd, "package.json"))});\nreturn require("cjs-dep").greet("idiom")`,
				);
				expect(parseJavaScriptResult(declared.result)).toBe("hi idiom");
				const later = await runJavaScriptCell(kernel, 'return require("./data.json").answer');
				expect(parseJavaScriptResult(later.result)).toBe(42);
			},
			{ cwd },
		);
	});

	it("Given a module that does not exist when a cell requires it then the runtime's not-found error names it and the kernel keeps its state", async () => {
		const cwd = await project();
		await withJavaScriptKernel(
			async (kernel) => {
				await runJavaScriptCell(kernel, "globalThis.kept = 7;");
				const missing = await runJavaScriptCell(kernel, 'require("senpi-no-such-package")');
				expect(missing.result.ok).toBe(false);
				if (!missing.result.ok)
					expect(missing.result.error.message).toContain("Cannot find module 'senpi-no-such-package'");
				expect(parseJavaScriptResult((await runJavaScriptCell(kernel, "return kept")).result)).toBe(7);
			},
			{ cwd },
		);
	});
});
