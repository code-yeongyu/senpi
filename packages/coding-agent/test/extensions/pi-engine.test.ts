/**
 * omo#12965, T-F: `pi.engine` is the engine an extension runs in. A plugin that needs the running engine's exports
 * reads them there instead of importing `@code-yeongyu/senpi`, whose import can evaluate a second engine copy.
 * Public extension API contract: on Node and on Bun every export of `pi.engine` is the same value as the export the
 * loader serves the extension for that specifier, and the property cannot be reassigned. The namespace object itself
 * is not compared: Bun's object loader hands each importer a fresh namespace object over the same exports.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const LOADER = fileURLToPath(new URL("../../src/core/extensions/loader.ts", import.meta.url));
const BUILT_LOADER = fileURLToPath(new URL("../../dist/core/extensions/loader.js", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PACKAGES = fileURLToPath(new URL("../../..", import.meta.url));
// Workspace packages the built engine imports at runtime, directly or through each other.
const ENGINE_DEPENDENCIES = [
	"agent",
	"ai",
	"chord",
	"client",
	"machine-ops",
	"protocol",
	"pty",
	"realm-registry",
	"telemetry",
	"tui",
];

const EXTENSION = `import * as served from "@code-yeongyu/senpi";

export default function (pi: { engine: Record<string, unknown> }) {
	const engine = pi.engine;
	const names = Object.keys(served);
	let assignment = "assigned";
	try {
		(pi as { engine: unknown }).engine = {};
	} catch (error) {
		assignment = error instanceof TypeError ? "TypeError" : "other error";
	}
	(globalThis as Record<string, unknown>).__piEngineProbe = {
		exports: names.length,
		missingFromEngine: names.filter((name) => !(name in engine)),
		differing: names.filter((name) => (served as Record<string, unknown>)[name] !== engine[name]),
		hasCreateAgentSession: typeof engine.createAgentSession === "function",
		assignment,
		unchangedAfterAssignment: pi.engine === engine,
	};
}
`;

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Build {
	output: string;
	sources: string;
}

function newestMtime(path: string): number {
	const stat = statSync(path);
	if (!stat.isDirectory()) return stat.mtimeMs;
	return Math.max(stat.mtimeMs, ...readdirSync(path).map((entry) => newestMtime(join(path, entry))));
}

/**
 * "built" only when every build output is strictly newer than every file and directory of its sources; a missing
 * output or an equal mtime counts as stale. A stale build would let the probe pass on old engine code and hide a
 * regression in the sources, so anything short of provably fresh runs the sources.
 */
function selectProbeLoader(builds: readonly Build[]): "built" | "source" {
	for (const build of builds) {
		if (!existsSync(build.output) || statSync(build.output).mtimeMs <= newestMtime(build.sources)) return "source";
	}
	return "built";
}

function engineBuilds(): Build[] {
	return [
		{ output: BUILT_LOADER, sources: join(PACKAGE_ROOT, "src") },
		...ENGINE_DEPENDENCIES.map((name) => {
			const root = join(PACKAGES, name);
			const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { main: string };
			return { output: join(root, manifest.main), sources: join(root, "src") };
		}),
	];
}

function probe(runtime: "node" | "bun"): Record<string, unknown> {
	const root = mkdtempSync(join(tmpdir(), "senpi-pi-engine-"));
	roots.push(root);
	writeFileSync(join(root, "extension.ts"), EXTENSION);
	// Under load, tsx compiling the whole engine graph from source outran the 170 s limit on node, so node runs the
	// built engine when it is fresh and falls back to the sources (tsx) when dist is missing or older than them.
	const loader = runtime === "node" ? selectProbeLoader(engineBuilds()) : "source";
	console.log(`pi.engine probe on ${runtime}: ${loader} loader`);
	const main = join(root, loader === "built" ? "main.mjs" : "main.mts");
	writeFileSync(
		main,
		[
			`import { loadExtensions } from ${JSON.stringify(loader === "built" ? BUILT_LOADER : LOADER)};`,
			`const result = await loadExtensions([${JSON.stringify(join(root, "extension.ts"))}], ${JSON.stringify(root)});`,
			"process.stdout.write(JSON.stringify({ errors: result.errors, probe: globalThis.__piEngineProbe }));",
			"process.exit(0);",
		].join("\n"),
	);
	const [command, args] =
		runtime === "bun"
			? ["bun", [main]]
			: loader === "built"
				? [process.execPath, [main]]
				: [process.execPath, ["--import", "tsx", main]];
	const output = execFileSync(command, args, { cwd: PACKAGE_ROOT, encoding: "utf8", timeout: 170_000 });
	return JSON.parse(output) as Record<string, unknown>;
}

describe("selectProbeLoader", () => {
	const T = 1_000_000_000;

	function tree(): { root: string; build: Build; paths: string[] } {
		const root = mkdtempSync(join(tmpdir(), "senpi-probe-loader-"));
		roots.push(root);
		const sources = join(root, "src");
		mkdirSync(join(sources, "nested"), { recursive: true });
		writeFileSync(join(sources, "a.ts"), "");
		writeFileSync(join(sources, "nested", "b.ts"), "");
		const paths = [join(sources, "a.ts"), join(sources, "nested", "b.ts"), join(sources, "nested"), sources];
		for (const path of paths) utimesSync(path, T, T);
		return { root, build: { output: join(root, "dist", "loader.js"), sources }, paths };
	}

	function writeOutput(build: Build, seconds: number): void {
		mkdirSync(join(build.output, ".."), { recursive: true });
		writeFileSync(build.output, "");
		utimesSync(build.output, seconds, seconds);
	}

	it("takes the source when the build output is missing", () => {
		expect(selectProbeLoader([tree().build])).toBe("source");
	});

	it("takes the build when its output is newer than every source", () => {
		const { build } = tree();
		writeOutput(build, T + 10);
		expect(selectProbeLoader([build])).toBe("built");
	});

	it("takes the source when one source file is newer than the build output", () => {
		const { build, paths } = tree();
		writeOutput(build, T + 10);
		utimesSync(paths[1], T + 20, T + 20);
		expect(selectProbeLoader([build])).toBe("source");
	});

	it("takes the source when the build output and the sources have the same mtime", () => {
		const { build } = tree();
		writeOutput(build, T);
		expect(selectProbeLoader([build])).toBe("source");
	});
});

describe("pi.engine (omo#12965, T-F)", () => {
	it.each(["node", "bun"] as const)(
		"on %s gives an extension the exports the loader serves for the engine specifier, read-only",
		(runtime) => {
			const result = probe(runtime);

			expect(result.errors).toEqual([]);
			expect(result.probe).toMatchObject({
				missingFromEngine: [],
				differing: [],
				hasCreateAgentSession: true,
				assignment: "TypeError",
				unchangedAfterAssignment: true,
			});
			expect((result.probe as { exports: number }).exports).toBeGreaterThan(0);
		},
		180_000,
	);
});
