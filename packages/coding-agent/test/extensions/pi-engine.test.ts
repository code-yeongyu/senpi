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
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const LOADER = fileURLToPath(new URL("../../src/core/extensions/loader.ts", import.meta.url));
const BUILT_LOADER = fileURLToPath(new URL("../../dist/core/extensions/loader.js", import.meta.url));
const BUILT_OUTPUT = fileURLToPath(new URL("../../dist", import.meta.url));
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
	/** The built file the probe needs from this package: the loader for coding-agent, `main` for a dependency. */
	entry: string;
	/** The directory the compiler mirrors `sources` into. */
	output: string;
	sources: string;
}

type ProbeLoader = { loader: "built" } | { loader: "source"; reason: string };

/** Every file and directory under `path`, `path` included. */
function walk(path: string): string[] {
	if (!statSync(path).isDirectory()) return [path];
	return [path, ...readdirSync(path).flatMap((entry) => walk(join(path, entry)))];
}

/**
 * "built" only when every package passes both checks, with N the newest mtime of any file or directory under its
 * sources: (a) its entry file exists and is strictly newer than N; (b) for every source file `<rel>.ts` or `<rel>.tsx`
 * (not `.d.ts`) whose output `<rel>.js` exists in the output directory, that output is strictly newer than N. Output
 * files with no current source (outputs of deleted sources, the bundle, copied assets) are ignored: the build never
 * rewrites them, so they would stay old forever. A new or edited source is itself N, so (a) catches it. An equal mtime
 * counts as stale. Otherwise the answer is "source" with the file that decided it. A stale build would let the probe
 * pass on old engine code and hide a regression in the sources, so anything short of provably fresh runs the sources.
 */
function selectProbeLoader(builds: readonly Build[]): ProbeLoader {
	for (const build of builds) {
		if (!existsSync(build.entry)) return { loader: "source", reason: `missing ${build.entry}` };
		const sources = walk(build.sources).map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }));
		const newest = sources.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
		const stale = (output: string): ProbeLoader => ({
			loader: "source",
			reason: `${output} is not newer than ${newest.path}`,
		});
		if (statSync(build.entry).mtimeMs <= newest.mtimeMs) return stale(build.entry);
		for (const { path } of sources) {
			if (!/\.tsx?$/.test(path) || path.endsWith(".d.ts")) continue;
			const output = join(build.output, relative(build.sources, path)).replace(/\.tsx?$/, ".js");
			if (existsSync(output) && statSync(output).mtimeMs <= newest.mtimeMs) return stale(output);
		}
	}
	return { loader: "built" };
}

function engineBuilds(): Build[] {
	return [
		{ entry: BUILT_LOADER, output: BUILT_OUTPUT, sources: join(PACKAGE_ROOT, "src") },
		...ENGINE_DEPENDENCIES.map((name) => {
			const root = join(PACKAGES, name);
			const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { main: string };
			const main = join(root, manifest.main);
			return { entry: main, output: dirname(main), sources: join(root, "src") };
		}),
	];
}

function probe(runtime: "node" | "bun"): Record<string, unknown> {
	const root = mkdtempSync(join(tmpdir(), "senpi-pi-engine-"));
	roots.push(root);
	writeFileSync(join(root, "extension.ts"), EXTENSION);
	// Under load, tsx compiling the whole engine graph from source outran the 170 s limit on node, so node runs the
	// built engine when it is fresh and falls back to the sources (tsx) when dist is missing or older than them.
	const choice: ProbeLoader =
		runtime === "node" ? selectProbeLoader(engineBuilds()) : { loader: "source", reason: "bun runs the sources" };
	const loader = choice.loader;
	console.log(
		`pi.engine probe on ${runtime}: ${choice.loader === "built" ? "built loader" : `source loader (${choice.reason})`}`,
	);
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
		const output = join(root, "dist");
		return { root, build: { entry: join(output, "loader.js"), output, sources }, paths };
	}

	function writeOutput(build: Build, seconds: number, file = "loader.js"): void {
		const path = join(build.output, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "");
		utimesSync(path, seconds, seconds);
	}

	/** The entry and the outputs of both sources (`a.ts` and `nested/b.ts`), all at `seconds`. */
	function writeBuild(build: Build, seconds: number): void {
		for (const file of ["loader.js", "a.js", join("nested", "b.js")]) writeOutput(build, seconds, file);
	}

	it("takes the source when the build output is missing", () => {
		expect(selectProbeLoader([tree().build]).loader).toBe("source");
	});

	it("takes the source when the build output directory is empty", () => {
		const { build } = tree();
		mkdirSync(build.output);
		expect(selectProbeLoader([build]).loader).toBe("source");
	});

	it("takes the build when its output is newer than every source", () => {
		const { build } = tree();
		writeBuild(build, T + 10);
		expect(selectProbeLoader([build]).loader).toBe("built");
	});

	it("takes the source when the output is non-empty and fresh but the entry file is missing", () => {
		const { build } = tree();
		for (const file of ["a.js", join("nested", "b.js"), "cli.js"]) writeOutput(build, T + 10, file);
		expect(selectProbeLoader([build])).toEqual({ loader: "source", reason: `missing ${build.entry}` });
	});

	it("takes the build when an old leftover output has no current source", () => {
		const { build } = tree();
		writeBuild(build, T + 10);
		writeOutput(build, T - 100, "deleted-source.js");
		expect(selectProbeLoader([build]).loader).toBe("built");
	});

	it("takes the source when one source file is newer than the build output", () => {
		const { build, paths } = tree();
		writeBuild(build, T + 10);
		utimesSync(paths[1], T + 20, T + 20);
		expect(selectProbeLoader([build]).loader).toBe("source");
	});

	it("takes the source when the entry output is fresh but a sibling output is older than a source", () => {
		const { build, paths } = tree();
		writeBuild(build, T + 10);
		writeOutput(build, T + 5, join("nested", "b.js"));
		utimesSync(paths[0], T + 7, T + 7);
		expect(selectProbeLoader([build])).toEqual({
			loader: "source",
			reason: `${join(build.output, "nested", "b.js")} is not newer than ${paths[0]}`,
		});
	});

	it("takes the source when the build output and the sources have the same mtime", () => {
		const { build } = tree();
		writeBuild(build, T);
		expect(selectProbeLoader([build]).loader).toBe("source");
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
