import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CellRequire, CellRequireContext } from "../src/kernels/js/worker-require.d.ts";

// The cell's require and require.resolve share one lookup (senpi#2832): builtins natively, then the project, then the
// managed package environment. These pin the order and the agreement between the two directly against
// createCellRequire, with a real project root and a real managed root on disk.
const roots: string[] = [];
const moduleUrl = pathToFileURL(join(import.meta.dirname, "..", "src", "kernels", "js", "worker-require.js")).href;
let createCellRequire: (context: () => CellRequireContext) => CellRequire;

beforeAll(async () => {
	const loaded: unknown = await import(moduleUrl);
	const create: unknown =
		typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "createCellRequire") : undefined;
	if (typeof create !== "function") throw new Error("worker-require.js does not export createCellRequire");
	createCellRequire = (context) => Reflect.apply(create, undefined, [context]);
});

afterEach(async () => {
	Reflect.deleteProperty(globalThis, "__senpiCounted");
	await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function dir(prefix: string): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	roots.push(root);
	return root;
}

async function cjsPackage(root: string, name: string, source: string): Promise<string> {
	const pkg = join(root, "node_modules", name);
	await mkdir(pkg, { recursive: true });
	await writeFile(join(pkg, "package.json"), JSON.stringify({ name, main: "index.js" }));
	await writeFile(join(pkg, "index.js"), source);
	return join(pkg, "index.js");
}

async function cellRequire(): Promise<{
	project: string;
	managed: string;
	require: CellRequire;
}> {
	const project = await dir("senpi-require-project-");
	const managed = await dir("senpi-require-managed-");
	const context = { cwdUrl: pathToFileURL(`${project}/`).href, packageRootUrl: pathToFileURL(`${managed}/`).href };
	return { project, managed, require: createCellRequire(() => context) };
}

describe("the cell's require lookup order (senpi#2832)", () => {
	it("Given a package only the managed environment has when a cell requires and resolves it then both use the managed copy", async () => {
		const { managed, require } = await cellRequire();
		const file = await cjsPackage(managed, "only-managed", "module.exports = 'managed';");
		expect(require.resolve("only-managed")).toBe(file);
		expect(require("only-managed")).toBe("managed");
	});

	it("Given a package both the project and the managed environment have when a cell requires and resolves it then both use the project copy", async () => {
		const { project, managed, require } = await cellRequire();
		const file = await cjsPackage(project, "both-roots", "module.exports = 'project';");
		await cjsPackage(managed, "both-roots", "module.exports = 'managed';");
		expect(require.resolve("both-roots")).toBe(file);
		expect(require("both-roots")).toBe("project");
	});

	it("Given a project package whose own dependency is missing when a cell requires it then the dependency's error surfaces and the managed copy is never loaded", async () => {
		const { project, managed, require } = await cellRequire();
		const file = await cjsPackage(project, "broken", "module.exports = require('missing-dep');");
		await cjsPackage(managed, "broken", "module.exports = 'managed';");
		expect(require.resolve("broken")).toBe(file);
		expect(() => require("broken")).toThrow(/missing-dep/);
	});

	it("Given builtins when a cell resolves them then the runtime's own ids come back and their lookup paths are null", async () => {
		const { require } = await cellRequire();
		expect([require.resolve("fs"), require.resolve("node:fs")]).toEqual(["fs", "node:fs"]);
		expect(require("fs")).toBe(require("node:fs"));
		expect(require.resolve.paths("fs")).toBeNull();
	});

	it("Given a bare name when a cell reads its lookup paths then the project's come first, then the managed environment's, each once", async () => {
		const { project, managed, require } = await cellRequire();
		const paths = require.resolve.paths("anything") ?? [];
		const projectAt = paths.indexOf(join(project, "node_modules"));
		const managedAt = paths.indexOf(join(managed, "node_modules"));
		expect(projectAt).toBeGreaterThanOrEqual(0);
		expect(managedAt).toBeGreaterThan(projectAt);
		expect(new Set(paths).size).toBe(paths.length);
	});

	it("Given a module a cell required when its cache entry is deleted then the next require loads it again", async () => {
		const { project, require } = await cellRequire();
		const file = await cjsPackage(
			project,
			"counted",
			"globalThis.__senpiCounted = (globalThis.__senpiCounted ?? 0) + 1; module.exports = globalThis.__senpiCounted;",
		);
		const first = Number(require("counted"));
		expect(require("counted")).toBe(first);
		delete require.cache[file];
		expect(require("counted")).toBe(first + 1);
	});
});
