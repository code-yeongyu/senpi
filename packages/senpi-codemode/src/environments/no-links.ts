import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EnvironmentError } from "./py-installer.ts";

/**
 * Every managed-root write goes through here: each component of `path` strictly below `root` that exists must be a
 * real file or directory, never a link, so a write can never land in what a planted link points at. `root` itself
 * may be a link (a user may relocate their whole artifacts directory); nothing below it may.
 */
export async function assertNoLinksBelow(root: string, path: string): Promise<void> {
	const below = relative(root, path);
	if (below.startsWith("..") || isAbsolute(below)) {
		throw new EnvironmentError("environment_install_failed", "refusing to write outside the managed environment");
	}
	let current = root;
	for (const part of below.split(sep).filter((segment) => segment !== "")) {
		current = join(current, part);
		const stats = await lstat(current).catch(missing);
		if (stats === undefined) return;
		if (stats.isSymbolicLink()) {
			throw new EnvironmentError(
				"environment_install_failed",
				`${relative(root, current)} is a link; refusing to write through it`,
			);
		}
	}
}

/**
 * The local directories a revision's `package.json` records as install sources, by package name, as realpaths: npm
 * writes `file:<path relative to the revision>`, bun the absolute path. Only these may be link targets out of the
 * revision, because installing from a directory links the package to it.
 */
export async function recordedInstallSources(revision: string): Promise<ReadonlyMap<string, string>> {
	const sources = new Map<string, string>();
	let manifest: unknown;
	try {
		manifest = JSON.parse(await readFile(join(revision, "package.json"), "utf8"));
	} catch {
		return sources;
	}
	if (typeof manifest !== "object" || manifest === null || !("dependencies" in manifest)) return sources;
	const dependencies = manifest.dependencies;
	if (typeof dependencies !== "object" || dependencies === null) return sources;
	for (const [name, spec] of Object.entries(dependencies)) {
		if (typeof spec !== "string") continue;
		const path = spec.startsWith("file:") ? spec.slice("file:".length) : spec;
		if (!isAbsolute(path) && !path.startsWith("./") && !path.startsWith("../")) continue;
		const source = await realpath(resolve(revision, path)).catch(() => undefined);
		if (source !== undefined && (await stat(source)).isDirectory()) sources.set(name, source);
	}
	return sources;
}

/**
 * A copy filter. A link inside `tree` may point inside it (relatively: an absolute link would keep pointing at the
 * previous revision from the copy), or out of it only to exactly the matching file of a recorded install source:
 * the link at `node_modules/<name>/<rest>` may resolve to `<source of name>/<rest>` and to nothing else. Whether a
 * target is inside is judged from the link's own text, without following further links.
 */
export async function assertLinkStaysInside(
	path: string,
	tree: string,
	sources: ReadonlyMap<string, string>,
): Promise<boolean> {
	if (!(await lstat(path)).isSymbolicLink()) return true;
	const target = await readlink(path);
	const resolved = resolve(dirname(path), target);
	const inside = relative(tree, resolved);
	const where = relative(tree, path);
	if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
		if (!isAbsolute(target)) return true;
		throw new EnvironmentError(
			"environment_install_failed",
			`${where} is an absolute link into its revision; refusing to build on it`,
		);
	}
	if (await isRecordedSourceLink(where, resolved, sources)) return true;
	throw new EnvironmentError(
		"environment_install_failed",
		`${where} links outside its revision; refusing to build on it`,
	);
}

async function isRecordedSourceLink(
	where: string,
	resolved: string,
	sources: ReadonlyMap<string, string>,
): Promise<boolean> {
	const parts = where.split(sep);
	if (parts[0] !== "node_modules" || parts[1] === undefined) return false;
	const scoped = parts[1].startsWith("@");
	const name = scoped ? `${parts[1]}/${parts[2] ?? ""}` : parts[1];
	const source = sources.get(name);
	if (source === undefined) return false;
	// `source` is a realpath; the expected target is that path plus the link's own path below the package, taken
	// literally, so a file of the source that is itself a link out of it does not count as the source.
	const expected = join(source, ...parts.slice(scoped ? 3 : 2));
	const actual = await realpath(resolved).catch(() => undefined);
	return actual !== undefined && actual === expected;
}

function missing(error: unknown): undefined {
	if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
	throw error;
}

/**
 * Checks every link in a built revision as the next copy will, so an install that leaves a link the next install
 * would refuse (an installer keeping links into a directory the manifest no longer records) is refused now, while
 * the previous revision is still active.
 */
export async function assertBuiltRevisionLinks(revision: string): Promise<void> {
	const sources = await recordedInstallSources(revision);
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isSymbolicLink()) {
				await assertLinkStaysInside(path, revision, sources).catch((error: unknown) => {
					const where = relative(revision, path);
					throw error instanceof EnvironmentError
						? new EnvironmentError(
								"environment_install_failed",
								`the install left ${where} linked outside the revision, so nothing was published`,
							)
						: error;
				});
			} else if (entry.isDirectory()) await walk(path);
		}
	};
	await walk(revision);
}
