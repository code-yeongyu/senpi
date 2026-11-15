import { constants, type Stats } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

/**
 * senpi#6752: a write's bytes handed over as a file (`args.bytes_path`) instead of inline base64 (the relay host sends a
 * write over 1 MiB this way). The file must be a 0600 regular file this user owns, opened without following a link, in
 * a 0700 directory (not a link) this user owns; it is read and then unlinked. One that is not is refused and left where
 * it is: the engine never removes a file it was not plainly handed. Answers the bytes, or the problem.
 */
export async function takeHandedBytes(path: string): Promise<Uint8Array | string> {
	const refusal = `bytes_path ${path} must be a 0600 regular file this user owns, in a 0700 directory this user owns`;
	if (!isAbsolute(path)) return refusal;
	const owner = process.getuid?.();
	const ownedWith = (info: Stats, mode: number): boolean =>
		(owner === undefined || info.uid === owner) && (info.mode & 0o777) === mode;
	const directory = await lstat(dirname(path)).catch(() => undefined);
	if (directory === undefined || !directory.isDirectory() || !ownedWith(directory, 0o700)) return refusal;
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		return refusal;
	}
	try {
		const info = await handle.stat();
		if (!info.isFile() || !ownedWith(info, 0o600)) return refusal;
		const bytes = new Uint8Array(await handle.readFile());
		await unlink(path);
		return bytes;
	} finally {
		await handle.close();
	}
}
