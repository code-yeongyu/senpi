/**
 * A move bundle carried inside the move's own answers instead of as a folder (senpi#6267): every file of the bundle
 * folder as its `/`-separated path, sha256 and base64 bytes, the manifest first. Only a small bundle travels this way;
 * a bigger one stays a folder the transport carries.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { leavesBundle, listedFiles, MANIFEST_FILE, MoveBundleInvalidError, parseManifest, shown } from "./bundle.ts";
import { type NameFolding, refuseNamesThatFold } from "./name-folding.ts";
import { filesUnder } from "./export.ts";

export interface InlineBundleFile {
	readonly path: string;
	readonly sha256: string;
	readonly base64: string;
}

/** The staging folders this module makes under `incoming`; nothing else there is its to remove. */
const STAGING_PREFIX = "inline-";
/** A staging folder not modified for this long belongs to an import that died; one in use is younger. */
const STALE_STAGING_MS = 60 * 60_000;
/** The longest file name the filesystems a host stages on take, and the longest path an inline file may be sent at. */
const MAX_SEGMENT_BYTES = 255;
const MAX_PATH_BYTES = 1024;

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

/** Both separators count, as in `leavesBundle`: a bundle written on one OS is read on another. */
const segmentsOf = (path: string): string[] => path.split(/[\\/]/);

/**
 * A path an inline file may be written at: relative, with no empty, `.` or `..` segment under either separator, no
 * NUL, and no segment or whole path too long to be a file where the bundle is staged. How deep a path may be is
 * the manifest's rule (`MAX_BUNDLE_PATH_SEGMENTS`): every sent path is either listed there or refused as unlisted.
 */
function staysInBundle(path: string): boolean {
	if (leavesBundle(path) || path.includes("\0") || Buffer.byteLength(path) > MAX_PATH_BYTES) return false;
	return segmentsOf(path).every(
		(segment) => segment !== "" && segment !== "." && Buffer.byteLength(segment) <= MAX_SEGMENT_BYTES,
	);
}

/** Refuses a sent path that is also the folder of another sent path: only one of the two can be written. */
function refuseFileAsFolder(sent: ReadonlyMap<string, string>): void {
	const files = new Set([...sent.keys()].map((path) => segmentsOf(path).join("/")));
	for (const path of files) {
		let folder = "";
		for (const segment of path.split("/").slice(0, -1)) {
			folder = folder === "" ? segment : `${folder}/${segment}`;
			if (files.has(folder)) throw new MoveBundleInvalidError(`${shown(folder)} was sent as a file and as a folder`);
		}
	}
}

/**
 * The sha256 each file was sent with, by path, once the whole list is known to be writable: nothing here touches the
 * disk. Refuses a path that cannot be a file inside the bundle, a path sent twice, a manifest whose bytes do not match
 * the sha256 they came with, and a file the manifest does not list (an unlisted file is never verified, and every sent
 * file costs folders). The manifest names the move, so a list refused here settles no move's record. What the
 * manifest lists is checked by the folder verification, against the manifest and against this map.
 */
function sentChecksums(files: readonly InlineBundleFile[]): ReadonlyMap<string, string> {
	const sent = new Map<string, string>();
	for (const file of files) {
		if (!staysInBundle(file.path))
			throw new MoveBundleInvalidError(`a sent path cannot be a file inside the bundle: ${shown(file.path)}`);
		if (sent.has(file.path)) throw new MoveBundleInvalidError(`${shown(file.path)} was sent twice`);
		sent.set(file.path, file.sha256);
	}
	const manifest = files.find((file) => file.path === MANIFEST_FILE);
	if (manifest === undefined) throw new MoveBundleInvalidError("no manifest was sent");
	const text = Buffer.from(manifest.base64, "base64");
	if (sha256(text) !== manifest.sha256) throw new MoveBundleInvalidError("the manifest changed in transit");
	const listed = new Set([
		MANIFEST_FILE,
		...listedFiles(parseManifest(text.toString("utf8"))).map((file) => file.path),
	]);
	const unlisted = [...sent.keys()].find((path) => !listed.has(path));
	if (unlisted !== undefined)
		throw new MoveBundleInvalidError(`${shown(unlisted)} was sent but the manifest does not list it`);
	refuseFileAsFolder(sent);
	return sent;
}

async function removeStaleStaging(incoming: string): Promise<void> {
	for (const name of await readdir(incoming)) {
		if (!name.startsWith(STAGING_PREFIX)) continue;
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
 * on it with the sha256 each file was sent with, and removes the folder whatever happens. A refused list makes no
 * folder and writes nothing. Before it writes, it removes the `inline-` folders under `incoming` that were not
 * modified for an hour (`STALE_STAGING_MS`); a younger one, or a folder of another name, is kept.
 *
 * A list with two paths that are one name where names fold (letter case, Unicode form) is refused too, but only
 * where `incoming`'s file system really folds them (senpi#6472): `probeFolding` asks it, and only for such a list.
 */
export async function withStagedInlineBundle<T>(
	files: readonly InlineBundleFile[],
	incoming: string,
	use: (bundleDir: string, sent: ReadonlyMap<string, string>) => Promise<T>,
	probeFolding?: (folder: string) => Promise<NameFolding>,
): Promise<T> {
	const sent = sentChecksums(files);
	await mkdir(incoming, { recursive: true });
	await refuseNamesThatFold([...sent.keys()], incoming, probeFolding);
	await removeStaleStaging(incoming);
	const dir = await mkdtemp(join(incoming, STAGING_PREFIX));
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
