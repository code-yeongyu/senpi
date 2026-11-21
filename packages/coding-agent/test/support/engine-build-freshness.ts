/**
 * Which loader the omo#12965 `pi.engine` probe runs on node: the built engine when it is provably fresh, else the
 * sources. Shared by the probe (test/extensions/pi-engine.test.ts) and its table tests
 * (test/extensions/engine-build-freshness.test.ts).
 */
import { lstatSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const BUILT_LOADER = fileURLToPath(new URL("../../dist/core/extensions/loader.js", import.meta.url));
const BUILT_OUTPUT = fileURLToPath(new URL("../../dist", import.meta.url));
export const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const PACKAGES = fileURLToPath(new URL("../../..", import.meta.url));
// Workspace packages the built engine imports at runtime, directly or through each other.
export const ENGINE_DEPENDENCIES = [
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

export interface Build {
	/** The built file the probe needs from this package: the loader for coding-agent, `main` for a dependency. */
	entry: string;
	/** The directory the compiler mirrors `sources` into. */
	output: string;
	sources: string;
}

export type ProbeLoader = ({ loader: "built" } | { loader: "source"; reason: string }) & {
	/** The symbolic links the walk skipped, present only when it skipped at least one. */
	skippedLinks?: readonly string[];
};

/** The filesystem calls the selector makes: production passes nothing and gets node's, tests inject failing ones. */
export interface ProbeFs {
	lstatSync(path: string): Stats;
	readdirSync(path: string): string[];
	statSync(path: string): Stats;
}

export const NODE_FS: ProbeFs = { lstatSync, readdirSync, statSync };

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
export function selectProbeLoader(builds: readonly Build[], fs: ProbeFs = NODE_FS): ProbeLoader {
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

export type ReadText = (path: string) => string;

const readUtf8: ReadText = (path) => readFileSync(path, "utf8");

/**
 * The selector's input: `loaderBuild`, then one build per package in `names` under `packagesDir`, whose entry is the
 * `main` of its `package.json`, whose output is that entry's directory and whose sources are its `src`. Never throws:
 * a manifest that cannot be read answers "source" with the error code and its path (`ENOENT: <path>`), invalid JSON
 * answers `invalid JSON: <path>`, and a `main` that is missing or not a non-empty string answers `no main in <path>`.
 * `readText` defaults to reading the file; tests inject a read that fails.
 */
export function resolveEngineBuilds(
	packagesDir: string,
	names: readonly string[],
	loaderBuild: Build,
	readText: ReadText = readUtf8,
): Build[] | { loader: "source"; reason: string } {
	const builds = [loaderBuild];
	for (const name of names) {
		const root = join(packagesDir, name);
		const path = join(root, "package.json");
		const text = readFs(path, () => readText(path));
		if (!text.ok) return { loader: "source", reason: text.reason };
		let manifest: unknown;
		try {
			manifest = JSON.parse(text.value);
		} catch {
			return { loader: "source", reason: `invalid JSON: ${path}` };
		}
		const main = typeof manifest === "object" && manifest !== null && "main" in manifest ? manifest.main : undefined;
		if (typeof main !== "string" || main === "") return { loader: "source", reason: `no main in ${path}` };
		const entry = join(root, main);
		builds.push({ entry, output: dirname(entry), sources: join(root, "src") });
	}
	return builds;
}

export const ENGINE_LOADER_BUILD: Build = {
	entry: BUILT_LOADER,
	output: BUILT_OUTPUT,
	sources: join(PACKAGE_ROOT, "src"),
};
