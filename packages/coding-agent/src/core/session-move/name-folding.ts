/**
 * Names that are one name on some file systems (senpi#6472): two paths that differ only in letter case, or only in
 * Unicode form (a composed and a decomposed spelling of one character). A bundle that holds both moves between hosts
 * whose file systems keep them apart, and cannot be written on one that folds them: the second write replaces the
 * first, or a file stands where a folder is needed. So an import asks the file system it is about to write on, never
 * the platform's name: a macOS volume can keep such names apart and a Linux mount can fold them.
 */
import { randomBytes } from "node:crypto";
import { access, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MoveBundleInvalidError, shown } from "./bundle.ts";

export interface NameFolding {
	/** `Notes` and `notes` are one name. */
	readonly letterCase: boolean;
	/** A composed and a decomposed spelling of one character are one name. */
	readonly unicodeForm: boolean;
}

/** Every folding a file system can have: a list with no pair under this has none anywhere, and needs no probe. */
const EVERY_FOLDING: NameFolding = { letterCase: true, unicodeForm: true };

const exists = (path: string): Promise<boolean> =>
	access(path).then(
		() => true,
		() => false,
	);

/** `path` if it is a folder, else the nearest folder above it that exists: the file system `path` is, or will be, on. */
async function nearestFolder(path: string): Promise<string> {
	const isFolder = await stat(path).then(
		(entry) => entry.isDirectory(),
		() => false,
	);
	const above = dirname(path);
	return isFolder || above === path ? path : nearestFolder(above);
}

/**
 * Asks the file system holding `path` (or the nearest folder above it that exists) how it folds names: writes one
 * empty file whose name has an upper-case letter and a composed character, looks for it under the other letter case
 * and under the other Unicode form, and removes it.
 */
export async function probeNameFolding(path: string): Promise<NameFolding> {
	const folder = await nearestFolder(path);
	const tag = `.name-probe-${randomBytes(6).toString("hex")}-`;
	const written = join(folder, `${tag}A\u00e9`);
	try {
		await writeFile(written, "", { flag: "wx" });
		return {
			letterCase: await exists(join(folder, `${tag}a\u00e9`)),
			unicodeForm: await exists(join(folder, `${tag}Ae\u0301`)),
		};
	} finally {
		await rm(written, { force: true });
	}
}

const segments = (path: string): string[] => path.split(/[\\/]/);

/**
 * Why these paths cannot all be files on a file system that folds names so, or `undefined` when they can: two of them
 * are one name there, or one is a file where another needs a folder. Paths that are equal as written are not this
 * function's to refuse.
 */
export function oneNameUnder(paths: readonly string[], folding: NameFolding): string | undefined {
	// Lower case first, then one Unicode form: a capital with a combining mark can have no composed form while its
	// lower case has one, so composing first would leave two spellings of what such a file system holds as one name.
	const spelled = (path: string): string => {
		const cased = folding.letterCase ? path.toLowerCase() : path;
		return folding.unicodeForm ? cased.normalize("NFC") : cased;
	};
	const byName = new Map<string, string>();
	for (const path of paths) {
		const name = spelled(segments(path).join("/"));
		const other = byName.get(name);
		if (other !== undefined && other !== path) return `${shown(path)} and ${shown(other)} are one name`;
		byName.set(name, path);
	}
	for (const [name, path] of byName) {
		let folder = "";
		for (const segment of name.split("/").slice(0, -1)) {
			folder = folder === "" ? segment : `${folder}/${segment}`;
			const file = byName.get(folder);
			if (
				file !== undefined &&
				!segments(path)
					.join("/")
					.startsWith(`${segments(file).join("/")}/`)
			)
				return `${shown(file)} is a file where ${shown(path)} needs a folder`;
		}
	}
	return undefined;
}

/**
 * Refuses a bundle whose paths cannot all be written on the file system of `folder`. A list with no such pair under
 * any folding is not probed at all, so it costs nothing and touches no folder.
 */
export async function refuseNamesThatFold(
	paths: readonly string[],
	folder: string,
	probe: (folder: string) => Promise<NameFolding> = probeNameFolding,
): Promise<void> {
	if (oneNameUnder(paths, EVERY_FOLDING) === undefined) return;
	const clash = oneNameUnder(paths, await probe(folder));
	if (clash !== undefined)
		throw new MoveBundleInvalidError(`${clash} on the file system this host would write the bundle to`);
}
