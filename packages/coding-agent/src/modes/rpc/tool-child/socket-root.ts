/**
 * Where a tool child's channel socket and its secret live (senpi#3566, #3576, #3694).
 *
 * A socket root is used only once it is proven to be a real private directory of this user: nothing is removed from it
 * before that proof, and the only write before it is an exclusive, no-follow create of a new secret file, which can never
 * follow, truncate or reuse anything already at that name. The proof holds afterwards: the root is ours and 0700, so no other user can
 * rename, remove or replace it (and `/tmp` is sticky), and our own secret keeps it non-empty, so a sibling's close-time
 * sweep cannot remove it either.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_SOCKET_PATH_BYTES } from "../socket-ownership.ts";
import { socketSecretPath } from "../socket-transport.ts";
import { type FileIdentity, writeExclusiveSecret } from "./exclusive-secret.ts";

/**
 * `<dir>/c-<generation>.sock` when it fits `sun_path`; otherwise the same name under a short private directory,
 * `/tmp/senpi-tc-<sha256(dir)[:12]>/` - never `TMPDIR`, whose macOS default is itself too long. The fallback is
 * predictable, so it is used only when it is a real directory of this user with no group or other access; when
 * anything else holds that name (another user's directory, a symlink), the socket goes under a fresh `mkdtemp`
 * directory instead, so a squatter on the predictable name can neither take the channel over nor block the start.
 */
export async function channelSocketPath(dir: string, generation: number): Promise<string> {
	const name = `c-${generation}.sock`;
	const primary = join(dir, name);
	if (process.platform === "win32" || Buffer.byteLength(primary) <= MAX_SOCKET_PATH_BYTES) {
		await makePrivateDirectory(dir);
		return primary;
	}
	const root = fallbackSocketRoot(dir);
	const claimed = await claimPrivateDirectory(root).then(
		() => true,
		(error: unknown) => {
			if (error instanceof SocketDirUnsafeError) return false;
			throw error;
		},
	);
	// `mkdtemp` creates a new 0700 directory with an unpredictable name atomically, so nothing can be planted there.
	return join(claimed ? root : await mkdtemp(`${root}-`), name);
}

/** The short private directory a socket falls back to when `<dir>/c-<generation>.sock` does not fit `sun_path`. */
export function fallbackSocketRoot(dir: string): string {
	return join("/tmp", `senpi-tc-${createHash("sha256").update(dir).digest("hex").slice(0, 12)}`);
}

class SocketDirUnsafeError extends Error {
	constructor(root: string) {
		super(`socket_dir_unsafe: ${root} is not a private directory of this user`);
	}
}

/**
 * A predictable directory under the shared `/tmp` is used only if it is a real directory of this user. It is opened
 * without following a symlink and checked through that handle before its mode is tightened, so nothing planted at the
 * path - a symlink or another user's directory - is ever changed or used.
 */
async function claimPrivateDirectory(root: string, create = true): Promise<void> {
	if (create) {
		await mkdir(root, { mode: 0o700 }).catch((error: unknown) => {
			if (Reflect.get(Object(error), "code") !== "EEXIST") throw error;
		});
	}
	const unsafe = () => new SocketDirUnsafeError(root);
	const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(() => {
		throw unsafe();
	});
	try {
		const stat = await handle.stat();
		if (!stat.isDirectory() || (process.getuid !== undefined && stat.uid !== process.getuid())) throw unsafe();
		if ((stat.mode & 0o077) !== 0) await handle.chmod(0o700);
	} finally {
		await handle.close();
	}
}

async function makePrivateDirectory(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
}

export interface ListenerFiles {
	readonly logicalPath: string;
	readonly secretPath: string;
	readonly secret: Buffer;
}

/**
 * Claims the socket root, writes this generation's secret into it as a new file, and proves both before anything else
 * touches the root. A sibling's close-time sweep can remove the still-empty root between the claim and the secret write,
 * and another user can take the name in that window. The exclusive, no-follow write then either fails (ENOENT, EACCES,
 * EEXIST on a planted entry) or creates a new file in the taken directory; it never follows or truncates what is there.
 * So after the write the root is claimed again and the secret checked to be our own regular file in it, and only then is
 * a stale socket of this generation removed. Any failure withdraws a secret this attempt created without ever acting on
 * another file: its bytes are destroyed through its own handle once that handle is proven to be the file the create made,
 * and its name is unlinked only through a root proven ours again. A root swapped before the withdrawal therefore never
 * leads it to another directory's file; the exact limit is that an unprovable root may keep our now-empty file. A
 * first-attempt failure a taken fallback root explains retries, and the retry's claim refuses that root and moves to a
 * fresh `mkdtemp` directory.
 */
export async function claimListenerFiles(dir: string, generation: number): Promise<ListenerFiles> {
	for (let attempt = 1; ; attempt++) {
		const logicalPath = await channelSocketPath(dir, generation);
		const root = dirname(logicalPath);
		const secretPath = socketSecretPath(logicalPath);
		let created: FileIdentity | undefined;
		try {
			const secret = await writeSecret(secretPath, root, dir, (identity) => {
				created = identity;
			});
			await proveRoot(root, dir);
			await proveOwnFile(secretPath, root);
			await rm(logicalPath, { force: true });
			return { logicalPath, secretPath, secret };
		} catch (error) {
			if (created !== undefined) await withdraw({ secretPath, root, dir, created });
			if (attempt >= 2 || !(root !== dir && foreignRootError(error))) throw error;
		}
	}
}

/**
 * The exclusive write fails with EEXIST when a secret of this generation is left from an earlier run. Such a leftover is
 * removed only once the root is proven ours and the entry proven our own regular file: a root holding it is non-empty,
 * so no sibling sweep can remove it and no other user can replace it before the write is repeated.
 */
async function writeSecret(
	secretPath: string,
	root: string,
	dir: string,
	onCreated: (identity: FileIdentity) => void,
): Promise<Buffer> {
	try {
		return await writeExclusiveSecret(secretPath, onCreated);
	} catch (error) {
		if (Reflect.get(Object(error), "code") !== "EEXIST") throw error;
		await proveRoot(root, dir);
		await proveOwnFile(secretPath, root);
		await rm(secretPath, { force: true });
		return writeExclusiveSecret(secretPath, onCreated);
	}
}

function proveRoot(root: string, dir: string, create = true): Promise<void> {
	return root === dir ? makePrivateDirectory(root) : claimPrivateDirectory(root, create);
}

interface WithdrawTarget {
	readonly secretPath: string;
	readonly root: string;
	readonly dir: string;
	readonly created: FileIdentity;
}

/**
 * Withdraws the secret this attempt created. Its bytes go first, through a handle checked to be that very file, so no
 * swap of the root can turn the truncation onto another file. Its name goes only through a root proven ours again (then
 * this user's 0700 directory, where nothing else can swap the entry) and only while the entry is still that file. Every
 * step is bounded: the open never blocks (a FIFO planted at the name fails at once with ENXIO), and re-proving a fallback
 * root never recreates it. A withdrawal that stops short emits a structured warning naming the path and its state; the
 * claim's own error is never replaced by it.
 */
async function withdraw(target: WithdrawTarget): Promise<void> {
	try {
		if (!(await emptyCreatedFile(target))) {
			return warnWithdrawal(
				target,
				"foreign",
				"the entry is not the file this claim created; it was left untouched",
			);
		}
		await proveRoot(target.root, target.dir, false);
		if (!sameFile(await lstat(target.secretPath), target.created)) {
			return warnWithdrawal(
				target,
				"foreign",
				"our file was emptied, then replaced by another entry, left untouched",
			);
		}
		await rm(target.secretPath, { force: true });
	} catch (cleanup) {
		warnWithdrawal(target, "unknown", String(Reflect.get(Object(cleanup), "code") ?? cleanup));
	}
}

/** `state`: what is left at the path - `foreign` (another entry, untouched) or `unknown` (the step that failed is named). */
function warnWithdrawal(target: WithdrawTarget, state: "foreign" | "unknown", reason: string): void {
	process.emitWarning("tool-child socket secret withdrawal stopped short", {
		code: "SENPI_TOOL_CHILD_SECRET_WITHDRAWAL",
		detail: JSON.stringify({ path: target.secretPath, state, reason }),
	});
}

async function emptyCreatedFile(target: WithdrawTarget): Promise<boolean> {
	const flags = constants.O_WRONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);
	const handle = await open(target.secretPath, flags);
	try {
		if (!sameFile(await handle.stat(), target.created)) return false;
		await handle.truncate(0);
		return true;
	} finally {
		await handle.close();
	}
}

function sameFile(entry: { readonly dev: number; readonly ino: number }, created: FileIdentity): boolean {
	return entry.dev === created.dev && entry.ino === created.ino;
}

const FOREIGN_ROOT_CODES = new Set(["EACCES", "EPERM", "ENOENT", "ENOTDIR", "ELOOP"]);

/** A failure a swept-and-replaced fallback root explains: a refused claim, or a secret write the taken name refused. */
function foreignRootError(error: unknown): boolean {
	return error instanceof SocketDirUnsafeError || FOREIGN_ROOT_CODES.has(String(Reflect.get(Object(error), "code")));
}

async function proveOwnFile(path: string, root: string): Promise<void> {
	const stat = await lstat(path);
	if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== process.getuid())) {
		throw new SocketDirUnsafeError(root);
	}
}
