import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";

const loaderPath = fileURLToPath(new URL("../../src/core/extensions/loader.ts", import.meta.url));
const roots: string[] = [];

const PROBE_INIT = "{ entryEvaluations: 0, dependencyEvaluations: 0, factoryRuns: 0 }";

function dependencySource(padding: string): string {
	return `const probe = (globalThis.__extensionGraphReuseProbe ??= ${PROBE_INIT});
probe.dependencyEvaluations++;
export const padding = ${JSON.stringify(padding)};
export function bump() {
	probe.factoryRuns++;
}
`;
}

function entrySource(padding: string): string {
	return `import { bump } from "./dependency.ts";
const probe = (globalThis.__extensionGraphReuseProbe ??= ${PROBE_INIT});
probe.entryEvaluations++;
export const padding = ${JSON.stringify(padding)};
export default function () {
	bump();
}
`;
}

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-graph-reuse-"));
	roots.push(root);
	writeFileSync(join(root, "dependency.ts"), dependencySource("a"));
	writeFileSync(join(root, "extension.ts"), entrySource("a"));
	mkdirSync(join(root, "session-a"), { recursive: true });
	mkdirSync(join(root, "session-b"), { recursive: true });
	return root;
}

/** The daemon path is Bun-only, so the scenario runs in a real Bun process. */
function runInBun(root: string, scenario: string): void {
	execFileSync(
		"bun",
		[
			"--eval",
			`
import assert from "node:assert/strict";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadExtensions } from ${JSON.stringify(loaderPath)};
const root = ${JSON.stringify(root)};
const entry = join(root, "extension.ts");
const dependency = join(root, "dependency.ts");
const probe = () => (globalThis.__extensionGraphReuseProbe ??= ${PROBE_INIT});
const load = async (cwd = root) => {
	const result = await loadExtensions([entry], cwd);
	assert.deepEqual(result.errors, [], "extension load reported errors");
};
const rewrite = (path, source) => {
	writeFileSync(path, source, "utf-8");
	const future = new Date(Date.now() + 2000);
	utimesSync(path, future, future);
};
const dependencySource = ${JSON.stringify(dependencySource("bbb"))};
const entrySource = ${JSON.stringify(entrySource("bb"))};
${scenario}
`,
		],
		{ cwd: root, encoding: "utf8", timeout: 60_000, stdio: "pipe" },
	);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("extension module graph reuse across session-scoped loads", () => {
	it("evaluates the module graph once when several sessions load the same extension", () => {
		// Given / When: three session-scoped loads of one extension, as a shared host does.
		// Then: one evaluation of the graph, one instance per session.
		runInBun(
			fixture(),
			`
await load();
await load();
await load();
assert.equal(probe().entryEvaluations, 1, "entry evaluated more than once");
assert.equal(probe().dependencyEvaluations, 1, "dependency evaluated more than once");
assert.equal(probe().factoryRuns, 3, "every session must still run the factory");
`,
		);
	});

	it("shares one module graph across session cwds", () => {
		// Given / When: two sessions whose cwd differs but whose extension file is the same.
		// Then: the compiled graph is shared; each session still gets its own instance.
		runInBun(
			fixture(),
			`
await load(join(root, "session-a"));
await load(join(root, "session-b"));
assert.equal(probe().entryEvaluations, 1, "cwd must not fork the module graph");
assert.equal(probe().factoryRuns, 2, "every session must still run the factory");
`,
		);
	});

	it("re-evaluates after the extension source changes", () => {
		// Given / When: a loaded extension whose entry file is then edited.
		// Then: the edit takes effect through a fresh evaluation.
		runInBun(
			fixture(),
			`
await load();
rewrite(entry, entrySource);
await load();
assert.equal(probe().entryEvaluations, 2, "edited source must be re-evaluated");
assert.equal(probe().factoryRuns, 2);
`,
		);
	});

	it("re-evaluates after an imported dependency changes", () => {
		// Given / When: a loaded extension whose dependency alone is edited.
		// Then: the graph is rebuilt so the edit takes effect.
		runInBun(
			fixture(),
			`
await load();
rewrite(dependency, dependencySource);
await load();
assert.equal(probe().dependencyEvaluations, 2, "edited dependency must be re-evaluated");
`,
		);
	});
});
