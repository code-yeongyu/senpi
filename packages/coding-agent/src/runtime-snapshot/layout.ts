import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { copyFiles, createSnapshotFileCopier, type SnapshotFileCopier } from "./file-copier.ts";
import { RUNTIME_SNAPSHOT_MARKER, type RuntimeSnapshotMarker } from "./marker.ts";

export interface RuntimeManifest {
	readonly buildId: string;
	readonly externals: readonly string[];
}

export class RuntimeSnapshotLayoutError extends Error {
	readonly packageName: string;

	constructor(packageName: string) {
		super(`runtime snapshot resolves ${packageName} differently from the install`);
		this.packageName = packageName;
	}
}

export const STAGING_PREFIX = ".tmp-";

/** Type declarations and source maps: no runtime ever loads them, and they are half the files. */
const UNLOADED_FILE = /\.(?:d\.[cm]?ts|map)$/;

type FilePairs = [string, string][];

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/**
 * Creates the directories of a tree copy and lists the files to copy into them, following
 * symlinks so nothing in the result points back at the source. `skipModules` leaves nested
 * `node_modules` out: dependencies are placed on their own.
 */
function planTree(
	source: string,
	target: string,
	files: FilePairs,
	skipModules: boolean,
	seen = new Set<string>(),
): void {
	const real = realpathSync(source);
	if (seen.has(real)) return;
	seen.add(real);
	mkdirSync(target, { recursive: true });
	for (const entry of readdirSync(real, { withFileTypes: true })) {
		if (skipModules && entry.name === "node_modules") continue;
		const from = join(real, entry.name);
		const to = join(target, entry.name);
		if (entry.isDirectory()) {
			planTree(from, to, files, skipModules, seen);
		} else if (entry.isFile()) {
			if (!UNLOADED_FILE.test(entry.name)) files.push([from, to]);
		} else if (entry.isSymbolicLink()) {
			let isDirectory: boolean;
			try {
				isDirectory = statSync(from).isDirectory();
			} catch (error) {
				// A dangling link in the install stays unresolvable in the snapshot too.
				if (isMissing(error)) continue;
				throw error;
			}
			if (isDirectory) planTree(from, to, files, skipModules, seen);
			else if (!UNLOADED_FILE.test(entry.name)) files.push([realpathSync(from), to]);
		}
	}
	seen.delete(real);
}

/** The node_modules directories Node's resolver walks from `dir`, nearest first. */
function moduleDirectoriesFrom(dir: string): string[] {
	const directories: string[] = [];
	for (let current = dir; ; current = dirname(current)) {
		if (basename(current) !== "node_modules") {
			const candidate = join(current, "node_modules");
			if (existsSync(candidate)) directories.push(candidate);
		}
		if (dirname(current) === current) return directories;
	}
}

function packageRootFrom(dir: string, packageName: string): string | undefined {
	for (const modules of moduleDirectoriesFrom(dir)) {
		const root = join(modules, packageName);
		if (existsSync(join(root, "package.json"))) return realpathSync(root);
	}
	return undefined;
}

function dependencyNames(packageDir: string): string[] {
	const manifest: unknown = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	if (typeof manifest !== "object" || manifest === null) return [];
	const names = new Set<string>();
	for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
		const block = (manifest as Record<string, unknown>)[field];
		if (typeof block === "object" && block !== null) for (const name of Object.keys(block)) names.add(name);
	}
	return [...names];
}

function closureNames(packageDir: string, extra: readonly string[]): Set<string> {
	const names = new Set(extra);
	const visited = new Set<string>();
	const pending = [realpathSync(packageDir)];
	for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
		if (visited.has(dir)) continue;
		visited.add(dir);
		for (const name of dependencyNames(dir)) {
			names.add(name);
			const root = packageRootFrom(dir, name);
			if (root !== undefined && !visited.has(root)) pending.push(root);
		}
	}
	return names;
}

/**
 * The snapshot's own `node_modules`: a copy of every package the install's dependency graph
 * reaches, placed so each one resolves its dependencies to copies of exactly the packages the
 * install resolves them to. Each name first goes where the package itself would find it (the
 * nearest copy, nested or hoisted); a package that needs another copy of a name gets it nested
 * under itself. Returns the snapshot path of each placed package and the install copy it holds.
 */
function planModules(
	packageDir: string,
	snapshotRoot: string,
	externals: readonly string[],
	files: FilePairs,
): Map<string, string> {
	const self = realpathSync(packageDir);
	const placed = new Map<string, string>();
	const pending: { readonly installDir: string; readonly snapshotDir: string }[] = [];
	const place = (installDir: string, snapshotDir: string): void => {
		planTree(installDir, snapshotDir, files, true);
		placed.set(snapshotDir, installDir);
		pending.push({ installDir, snapshotDir });
	};
	const resolvePlaced = (from: string, name: string): string | undefined => {
		for (let dir = from; ; dir = dirname(dir)) {
			if (basename(dir) !== "node_modules") {
				const found = placed.get(join(dir, "node_modules", name));
				if (found !== undefined) return found;
			}
			if (dir === snapshotRoot || dirname(dir) === dir) return undefined;
		}
	};
	for (const name of closureNames(packageDir, externals)) {
		const source = packageRootFrom(packageDir, name);
		if (source !== undefined && source !== self) place(source, join(snapshotRoot, "node_modules", name));
	}
	for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
		for (const name of dependencyNames(next.installDir)) {
			const expected = packageRootFrom(next.installDir, name);
			if (expected === undefined || expected === self) continue;
			if (resolvePlaced(next.snapshotDir, name) !== expected) {
				place(expected, join(next.snapshotDir, "node_modules", name));
			}
		}
	}
	return placed;
}

/** Each external the bundle imports must resolve, from the snapshot's bundle, to the snapshot's copy of the install's package. */
function verifyExternals(
	packageDir: string,
	snapshotBundleDir: string,
	externals: readonly string[],
	placed: ReadonlyMap<string, string>,
): void {
	for (const name of externals) {
		const expected = packageRootFrom(packageDir, name);
		if (expected === undefined) continue;
		const found = moduleDirectoriesFrom(snapshotBundleDir)
			.map((modules) => join(modules, name))
			.find((root) => existsSync(join(root, "package.json")));
		if (found === undefined || placed.get(found) !== expected) throw new RuntimeSnapshotLayoutError(name);
	}
}

/**
 * Builds `target` as a copy of the package that no reinstall can touch: the package itself and
 * every package its dependency graph reaches, with nothing linked back to the install, so an
 * upgrade that deletes, rewrites or re-lays-out the install (bundledDependencies on or off) never
 * changes what a running session loads (#2408). Built beside the target and renamed into place,
 * so a crash never leaves a half-built snapshot under its name.
 */
export async function materializeRuntimeSnapshot(
	packageDir: string,
	target: string,
	manifest: RuntimeManifest,
	copier: SnapshotFileCopier = createSnapshotFileCopier(),
): Promise<void> {
	const staging = join(dirname(target), `${STAGING_PREFIX}${basename(target)}-${process.pid}`);
	rmSync(staging, { recursive: true, force: true });
	try {
		const files: FilePairs = [];
		planTree(packageDir, staging, files, true);
		const placed = planModules(packageDir, staging, manifest.externals, files);
		await copyFiles(files, copier);
		verifyExternals(packageDir, join(staging, "dist", "bundle", "chunks"), manifest.externals, placed);
		const marker: RuntimeSnapshotMarker = { buildId: manifest.buildId, installPackageDir: realpathSync(packageDir) };
		writeFileSync(join(staging, RUNTIME_SNAPSHOT_MARKER), `${JSON.stringify(marker)}\n`);
		rmSync(target, { recursive: true, force: true });
		renameSync(staging, target);
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		throw error;
	}
}
