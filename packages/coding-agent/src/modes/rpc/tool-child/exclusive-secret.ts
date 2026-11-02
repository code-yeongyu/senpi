import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { SOCKET_SECRET_BYTES } from "../socket-transport.ts";

/** The file a create made: a withdrawal removes only the entry that is still this file. */
export interface FileIdentity {
	readonly dev: number;
	readonly ino: number;
}

/**
 * Writes a fresh 0600 secret as a NEW file at `path`. `O_EXCL` with `O_NOFOLLOW` means nothing that already sits at that
 * name - a file, or a symlink to one - is ever followed, truncated or reused: the open fails with EEXIST (or ELOOP)
 * instead. Nothing is removed here: `onCreated` names the created file as soon as it exists, so the caller can withdraw
 * it (through a root it has proven again) whatever fails afterwards. The one gap is an `fstat` that fails right after the
 * create: that file is still empty, and it is left where it is.
 */
export async function writeExclusiveSecret(path: string, onCreated: (identity: FileIdentity) => void): Promise<Buffer> {
	const secret = randomBytes(SOCKET_SECRET_BYTES);
	const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
	const handle = await open(path, flags, 0o600);
	try {
		const stat = await handle.stat();
		onCreated({ dev: stat.dev, ino: stat.ino });
		await handle.writeFile(secret);
		await handle.chmod(0o600);
		return secret;
	} finally {
		await handle.close();
	}
}
