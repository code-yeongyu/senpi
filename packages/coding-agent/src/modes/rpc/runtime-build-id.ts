/**
 * `runtimeBuildId`: which runtime a process actually loaded, as one content digest.
 *
 * A version string cannot answer that. A development checkout and a packaged install can carry the
 * same version, and a reinstall replaces a bundle at the same path. The id is therefore
 * `sha256:<64 hex>` over a canonical manifest built from contents only:
 *
 *   - the runtime flavour (`compiled`, `packaged` or `dev`), platform and architecture;
 *   - the engine build text (`engineBuildIdentity().text`);
 *   - the digests of the runtime files, sorted by their path relative to the runtime root;
 *   - one digest per launch-profile extension (a plugin directory or file), sorted by value;
 *   - the launch-profile flags that change what a host loads (`multi_session`, `session_runtime`).
 *
 * No absolute path enters the manifest, so the same build installed in two places has one id.
 * Mutable state never enters it either: dot-entries, nested `node_modules`, type declarations,
 * source maps and the build/snapshot manifests (`runtime-manifest.json`, `runtime-snapshot.json`)
 * are left out.
 *
 * A host computes its id ONCE, at startup, from the files it is about to serve with. A bundle
 * replaced later at the same path therefore leaves the running host's id unchanged, while a client
 * started from the new bundle computes a different one. That is the difference the desktop needs
 * to see to replace the host.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isBunBinary } from "../../config.ts";
import { engineBuildIdentity } from "../../core/engine-build-identity.ts";
import { BUILTIN_PATH_PREFIX } from "../../core/source-info.ts";
import type { RpcLaunchProfileCore } from "./rpc-types.ts";

/** Host capability: reports `runtimeBuildId` and runs the conditional idle handover. */
export const RUNTIME_IDENTITY_HANDOVER_CAPABILITY = "runtime_identity_handover";

const RUNTIME_BUILD_ID = /^sha256:[0-9a-f]{64}$/;

/** Files no runtime loads, or that describe a copy rather than the build. */
const EXCLUDED_FILE = /\.(?:d\.[cm]?ts|map)$/;
const EXCLUDED_NAMES = new Set(["node_modules", "runtime-manifest.json", "runtime-snapshot.json"]);

/** How many files are read at once; keeps a large tree from exhausting file descriptors. */
const READ_CONCURRENCY = 32;

export type RuntimeFlavour = "compiled" | "packaged" | "dev";

export interface RuntimeSource {
	readonly flavour: RuntimeFlavour;
	readonly root: string;
}

export interface RuntimeBuildIdInput {
	readonly profile: Pick<RpcLaunchProfileCore, "extensions" | "multi_session" | "session_runtime">;
	/** Defaults to the runtime this module was loaded from. */
	readonly source?: RuntimeSource;
	readonly platform?: string;
	readonly arch?: string;
	readonly engine?: string;
}

/** A well-formed id, or undefined: anything else proves nothing. */
export function parseRuntimeBuildId(value: unknown): string | undefined {
	return typeof value === "string" && RUNTIME_BUILD_ID.test(value) ? value : undefined;
}

export async function computeRuntimeBuildId(input: RuntimeBuildIdInput): Promise<string> {
	const source = input.source ?? loadedRuntimeSource();
	const plugins = await Promise.all(input.profile.extensions.map((path) => extensionDigest(path)));
	const manifest = {
		schema: 1,
		flavour: source.flavour,
		platform: input.platform ?? process.platform,
		arch: input.arch ?? process.arch,
		engine: input.engine ?? engineBuildIdentity().text,
		runtime: await treeDigest(source.root),
		plugins: plugins.sort(),
		profile: { multi_session: input.profile.multi_session, session_runtime: input.profile.session_runtime },
	};
	return `sha256:${sha256(JSON.stringify(manifest))}`;
}

/**
 * Where the code of THIS process lives. A compiled binary is its own executable. Otherwise the
 * package root is the nearest ancestor holding a `package.json`, and the tree this module sits in
 * names the flavour: `dist/bundle` (the bundle), `dist` (the unbundled tree) or `src` (a checkout).
 */
export function loadedRuntimeSource(): RuntimeSource {
	if (isBunBinary) return { flavour: "compiled", root: process.execPath };
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const packageRoot = nearestPackageRoot(moduleDir);
	const [top, next] = relative(packageRoot, moduleDir).split(sep);
	if (top === "dist") {
		return { flavour: "packaged", root: join(packageRoot, next === "bundle" ? join("dist", "bundle") : "dist") };
	}
	return { flavour: "dev", root: join(packageRoot, top ?? "") };
}

function nearestPackageRoot(start: string): string {
	for (let dir = start; ; dir = dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) return dir;
		if (dirname(dir) === dir) return start;
	}
}

/**
 * A `builtin:<name>` extension is code inside the runtime, already in its digest; the launch profile
 * resolves it against the cwd like a path, so only its name counts here.
 */
function extensionDigest(path: string): Promise<string> {
	const name = basename(path);
	return name.startsWith(BUILTIN_PATH_PREFIX) ? Promise.resolve(sha256(name)) : treeDigest(path);
}

async function treeDigest(root: string): Promise<string> {
	const files: [string, string][] = [];
	const top = await stat(root);
	if (top.isFile()) files.push(["", root]);
	else await collect(await realpath(root), "", files, new Set());
	const digests = await mapLimited(files, READ_CONCURRENCY, async ([path, file]) => [
		path,
		sha256(await readFile(file)),
	]);
	digests.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return sha256(JSON.stringify(digests));
}

async function collect(dir: string, prefix: string, files: [string, string][], seen: Set<string>): Promise<void> {
	// A real directory is digested once, under the first (sorted) name that reaches it, so a symlinked
	// alias never adds a second copy of the same files.
	if (seen.has(dir)) return;
	seen.add(dir);
	const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
	);
	for (const entry of entries) {
		if (entry.name.startsWith(".") || EXCLUDED_NAMES.has(entry.name)) continue;
		const path = join(dir, entry.name);
		const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		const kind = entry.isSymbolicLink() ? await stat(path).catch(() => undefined) : entry;
		if (kind === undefined) continue;
		if (kind.isDirectory()) await collect(await realpath(path), name, files, seen);
		else if (kind.isFile() && !EXCLUDED_FILE.test(entry.name)) files.push([name, path]);
	}
}

async function mapLimited<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (let index = next++; index < items.length; index = next++) results[index] = await map(items[index]);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}
