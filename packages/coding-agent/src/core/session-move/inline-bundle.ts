/**
 * A move bundle carried inside the move's own answers instead of as a folder (senpi#6267): every file of the bundle
 * folder as its `/`-separated path, sha256 and base64 bytes, the manifest first. Only a small bundle travels this way;
 * a bigger one stays a folder the transport carries.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { leavesBundle, MANIFEST_FILE, MoveBundleInvalidError } from "./bundle.ts";
import { filesUnder } from "./export.ts";

export interface InlineBundleFile {
	readonly path: string;
	readonly sha256: string;
	readonly base64: string;
}

/** A staging folder older than this was left by a host that died mid-import. */
const STALE_STAGING_MS = 60 * 60_000;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The bundle folder's files for an inline answer, or `undefined` when they do not fit the limits. */
export async function readInlineBundle(
	bundleDir: string,
	limits: { readonly maxBytes: number; readonly maxFiles: number },
): Promise<InlineBundleFile[] | undefined> {
	const found = (await filesUnder(bundleDir)).map((file) => posix.join(...relative(bundleDir, file).split(sep)));
	if (found.length > limits.maxFiles) return undefined;
	const paths = [MANIFEST_FILE, ...found.filter((path) => path !== MANIFEST_FILE).sort()];
	let bytes = 0;
	for (const path of paths) {
		bytes += (await stat(join(bundleDir, path))).size;
		if (bytes > limits.maxBytes) return undefined;
	}
	const files: InlineBundleFile[] = [];
	for (const path of paths) {
		const content = await readFile(join(bundleDir, path));
		files.push({ path, sha256: sha256(content), base64: content.toString("base64") });
	}
	return files;
}

/** A path an inline file may have: relative, `/`-separated, with no empty, `.` or `..` segment. */
const staysInBundle = (path: string): boolean =>
	!leavesBundle(path) && path.split("/").every((segment) => segment !== "" && segment !== ".");

/**
 * The sha256 each file was sent with, by path. Refuses a path that leaves the bundle and a manifest whose bytes do not
 * match the sha256 they came with: the manifest names the move, so only one that arrived intact may settle a move's
 * record. Every other file is checked by the folder verification, against the manifest and against this map.
 */
function sentChecksums(files: readonly InlineBundleFile[]): ReadonlyMap<string, string> {
	const sent = new Map<string, string>();
	for (const file of files) {
		if (!staysInBundle(file.path)) throw new MoveBundleInvalidError(`a sent path leaves the bundle: ${file.path}`);
		if (sent.has(file.path)) throw new MoveBundleInvalidError(`${file.path} was sent twice`);
		sent.set(file.path, file.sha256);
	}
	const manifest = files.find((file) => file.path === MANIFEST_FILE);
	if (manifest === undefined) throw new MoveBundleInvalidError("no manifest was sent");
	if (sha256(Buffer.from(manifest.base64, "base64")) !== manifest.sha256)
		throw new MoveBundleInvalidError("the manifest changed in transit");
	return sent;
}

async function removeStaleStaging(incoming: string): Promise<void> {
	for (const name of await readdir(incoming)) {
		const dir = join(incoming, name);
		const modified = await stat(dir).then(
			(entry) => entry.mtimeMs,
			() => undefined,
		);
		if (modified !== undefined && Date.now() - modified > STALE_STAGING_MS)
			await rm(dir, { recursive: true, force: true });
	}
}

/**
 * Writes an inline bundle into a folder of its own under `incoming`, as the bundle folder it was read from, runs `use`
 * on it with the sha256 each file was sent with, and removes the folder whatever happens. A refused bundle writes
 * nothing; folders a dead host left under `incoming` are removed first.
 */
export async function withStagedInlineBundle<T>(
	files: readonly InlineBundleFile[],
	incoming: string,
	use: (bundleDir: string, sent: ReadonlyMap<string, string>) => Promise<T>,
): Promise<T> {
	const sent = sentChecksums(files);
	await mkdir(incoming, { recursive: true });
	await removeStaleStaging(incoming);
	const dir = await mkdtemp(join(incoming, "inline-"));
	try {
		for (const file of files) {
			const to = join(dir, ...file.path.split("/"));
			await mkdir(dirname(to), { recursive: true });
			await writeFile(to, Buffer.from(file.base64, "base64"));
		}
		return await use(dir, sent);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
