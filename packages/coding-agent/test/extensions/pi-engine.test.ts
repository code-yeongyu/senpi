/**
 * omo#12965, T-F: `pi.engine` is the engine an extension runs in. A plugin that needs the running engine's exports
 * reads them there instead of importing `@code-yeongyu/senpi`, whose import can evaluate a second engine copy.
 * Public extension API contract: on Node and on Bun every export of `pi.engine` is the same value as the export the
 * loader serves the extension for that specifier, and the property cannot be reassigned. The namespace object itself
 * is not compared: Bun's object loader hands each importer a fresh namespace object over the same exports.
 */
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	type Stats,
	symlinkSync,
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

type ProbeLoader = ({ loader: "built" } | { loader: "source"; reason: string }) & {
	/** The symbolic links the walk skipped, present only when it skipped at least one. */
	skippedLinks?: readonly string[];
};

/** The filesystem calls the selector makes: production passes nothing and gets node's, tests inject failing ones. */
interface ProbeFs {
	lstatSync(path: string): Stats;
	readdirSync(path: string): string[];
	statSync(path: string): Stats;
}

const NODE_FS: ProbeFs = { lstatSync, readdirSync, statSync };

/** One filesystem call's value, or why it failed: the error code and the path, as in `ENOENT: <path>`. */
type FsRead<T> = { ok: true; value: T } | { ok: false; code: string; reason: string };

function readFs<T>(path: string, read: () => T): FsRead<T> {
	try {
		return { ok: true, value: read() };
	} catch (error) {
		const code =
			error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "EUNKNOWN";
		return { ok: false, code, reason: `${code}: ${path}` };
	}
}

type Walk = { ok: true; paths: string[] } | { ok: false; reason: string };

/**
 * Every file and directory under `path`, `path` included; a symbolic link is pushed to `links` instead. The `root`
 * must be a directory: a root that is a regular file has no source tree, so it fails with `ENOTDIR`.
 */
function walk(path: string, links: string[], fs: ProbeFs, root: boolean): Walk {
	const stats = readFs(path, () => fs.lstatSync(path));
	if (!stats.ok) return stats;
	if (stats.value.isSymbolicLink()) {
		links.push(path);
		return { ok: true, paths: [] };
	}
	if (!stats.value.isDirectory()) {
		return root
			? { ok: false, reason: `ENOTDIR: ${path} is a file, so there is no source tree` }
			: { ok: true, paths: [path] };
	}
	const entries = readFs(path, () => fs.readdirSync(path));
	if (!entries.ok) return entries;
	const paths = [path];
	for (const entry of entries.value) {
		const below = walk(join(path, entry), links, fs, false);
		if (!below.ok) return below;
		paths.push(...below.paths);
	}
	return { ok: true, paths };
}

/**
 * "built" only when every package passes both checks, with N the newest mtime of any file or directory under its
 * sources: (a) its entry file exists and is strictly newer than N; (b) for every source file `<rel>.ts` or `<rel>.tsx`
 * (not `.d.ts`) whose output `<rel>.js` exists in the output directory, that output is strictly newer than N. Output
 * files with no current source (outputs of deleted sources, the bundle, copied assets) are ignored: the build never
 * rewrites them, so they would stay old forever. A new or edited source is itself N, so (a) catches it. An equal mtime
 * counts as stale. Otherwise the answer is "source" with the file that decided it. A stale build would let the probe
 * pass on old engine code and hide a regression in the sources, so anything short of provably fresh runs the sources.
 * The walk skips symbolic links: a link is neither descended into nor counted, so neither it nor its target adds an
 * mtime. Following them let a link loop recurse without end and let a target outside the sources, which the build
 * never compiles, make a fresh build look stale. The cost: an edit behind a link under the sources is not seen as a
 * newer source, so the skipped links are returned in `skippedLinks` and the probe logs them. A package whose walk
 * finds no source file (its sources root is itself a link) has nothing to prove fresh against, so it answers "source".
 * The selector never throws: each filesystem call (the lstat and readdir of the walk, the stat of every source, of
 * the entry and of every output) is checked on its own, and any error answers "source" with the error code and the
 * path, as in `ENOENT: <path>`, since the sources are the safe path. Two codes keep their meaning in the rule: a
 * missing entry answers `missing <entry>`, and a missing output is ignored as above. A sources root that is a regular
 * file answers `ENOTDIR`: it has no source tree, so it must not pass as a one-file tree. `fs` defaults to node's;
 * production callers pass nothing, and tests inject calls that fail without depending on permissions or races.
 */
function selectProbeLoader(builds: readonly Build[], fs: ProbeFs = NODE_FS): ProbeLoader {
	const links: string[] = [];
	const answer = (choice: ProbeLoader): ProbeLoader =>
		links.length > 0 ? { ...choice, skippedLinks: links } : choice;
	const source = (reason: string): ProbeLoader => answer({ loader: "source", reason });
	for (const build of builds) {
		const entry = readFs(build.entry, () => fs.statSync(build.entry));
		if (!entry.ok) return source(entry.code === "ENOENT" ? `missing ${build.entry}` : entry.reason);
		const tree = walk(build.sources, links, fs, true);
		if (!tree.ok) return source(tree.reason);
		const sources: { path: string; mtimeMs: number }[] = [];
		for (const path of tree.paths) {
			const stats = readFs(path, () => fs.statSync(path));
			if (!stats.ok) return source(stats.reason);
			sources.push({ path, mtimeMs: stats.value.mtimeMs });
		}
		if (sources.length === 0) return source(`no source files under ${build.sources}`);
		const newest = sources.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
		const stale = (output: string): ProbeLoader => source(`${output} is not newer than ${newest.path}`);
		if (entry.value.mtimeMs <= newest.mtimeMs) return stale(build.entry);
		for (const { path } of sources) {
			if (!/\.tsx?$/.test(path) || path.endsWith(".d.ts")) continue;
			const output = join(build.output, relative(build.sources, path)).replace(/\.tsx?$/, ".js");
			const built = readFs(output, () => fs.statSync(output));
			if (!built.ok) {
				if (built.code === "ENOENT") continue;
				return source(built.reason);
			}
			if (built.value.mtimeMs <= newest.mtimeMs) return stale(output);
		}
	}
	return answer({ loader: "built" });
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
	if (choice.skippedLinks) {
		console.log(
			`pi.engine probe: skipped ${choice.skippedLinks.length} symbolic link(s) under the sources, first ${choice.skippedLinks[0]}`,
		);
	}
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

	it(
		"returns and takes the build when a symbolic link under the sources loops back to them",
		{ timeout: 5_000 },
		() => {
			const { build } = tree();
			writeBuild(build, T + 10);
			const link = join(build.sources, "loop");
			symlinkSync(build.sources, link, "dir");
			utimesSync(build.sources, T, T);
			expect(selectProbeLoader([build])).toEqual({ loader: "built", skippedLinks: [link] });
		},
	);

	it(
		"takes the build when a symbolic link under the sources points outside them at a newer file",
		{ timeout: 5_000 },
		() => {
			const { root, build } = tree();
			writeBuild(build, T + 10);
			const outside = join(root, "outside.ts");
			writeFileSync(outside, "");
			utimesSync(outside, T + 20, T + 20);
			const link = join(build.sources, "linked.ts");
			symlinkSync(outside, link);
			utimesSync(build.sources, T, T);
			expect(selectProbeLoader([build])).toEqual({ loader: "built", skippedLinks: [link] });
		},
	);

	it("takes the source, without throwing, when the sources root is itself a symbolic link", { timeout: 5_000 }, () => {
		const { root, build } = tree();
		writeBuild(build, T + 10);
		const sources = join(root, "linked-src");
		symlinkSync(build.sources, sources, "dir");
		expect(selectProbeLoader([{ ...build, sources }])).toEqual({
			loader: "source",
			reason: `no source files under ${sources}`,
			skippedLinks: [sources],
		});
	});

	function fsError(code: string, path: string): never {
		throw Object.assign(new Error(`${code}: injected failure, '${path}'`), { code });
	}

	/** A fresh build over the tree; `failing` is the path whose code the reason must name. */
	interface FsFailureCase {
		name: string;
		code: string;
		setup(): { build: Build; failing: string; fs?: ProbeFs };
	}

	it.each<FsFailureCase>([
		{
			name: "the sources root is missing",
			code: "ENOENT",
			setup: () => {
				const { root, build } = tree();
				writeBuild(build, T + 10);
				const sources = join(root, "missing-src");
				return { build: { ...build, sources }, failing: sources };
			},
		},
		{
			name: "the sources root is a regular file, so there is no source tree",
			code: "ENOTDIR",
			setup: () => {
				const { root, build } = tree();
				writeBuild(build, T + 10);
				const sources = join(root, "src-file");
				writeFileSync(sources, "");
				utimesSync(sources, T, T);
				return { build: { ...build, sources }, failing: sources };
			},
		},
		{
			name: "reading a directory under the sources fails with EACCES",
			code: "EACCES",
			setup: () => {
				const { build } = tree();
				writeBuild(build, T + 10);
				const failing = join(build.sources, "nested");
				const fs: ProbeFs = {
					...NODE_FS,
					readdirSync: (path) => (path === failing ? fsError("EACCES", path) : readdirSync(path)),
				};
				return { build, failing, fs };
			},
		},
		{
			name: "a listed file vanishes before its lstat",
			code: "ENOENT",
			setup: () => {
				const { build } = tree();
				writeBuild(build, T + 10);
				const failing = join(build.sources, "nested", "b.ts");
				const fs: ProbeFs = {
					...NODE_FS,
					lstatSync: (path) => (path === failing ? fsError("ENOENT", path) : lstatSync(path)),
				};
				return { build, failing, fs };
			},
		},
	])(
		"takes the source, without throwing, when $name",
		({ code, setup }) => {
			const { build, failing, fs } = setup();
			let choice: ProbeLoader | undefined;
			expect(() => {
				choice = selectProbeLoader([build], fs);
			}).not.toThrow();
			expect(choice).toMatchObject({ loader: "source", reason: expect.stringContaining(`${code}: ${failing}`) });
		},
		5_000,
	);
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
