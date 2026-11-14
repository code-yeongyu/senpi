import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, mkdir, open, readFile, realpath, rename, statfs, unlink, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { basename, dirname, join, win32 } from "node:path";
import { acquireOwnershipSafeLock } from "./ownership-safe-lock.ts";

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\senpi-rpc-";
export const SOCKET_SECRET_BYTES = 32;
export const SOCKET_SECRET_SUFFIX = ".secret";
export const SOCKET_SECRET_FILE_ENV = "SENPI_RPC_SOCKET_SECRET_FILE";
export const SOCKET_HANDSHAKE_TIMEOUT_MS = 2_000;

export function socketSecretPath(logicalPath: string): string {
	if (logicalPath.toLowerCase().startsWith("\\\\.\\pipe\\")) {
		throw new Error(
			`Windows RPC named-pipe addresses need a logical filesystem path for their secret: ${logicalPath}`,
		);
	}
	return `${logicalPath}${SOCKET_SECRET_SUFFIX}`;
}

export async function ensureSocketSecret(path: string): Promise<Buffer> {
	const existing = await readSecretEntry(path);
	if (existing?.length === SOCKET_SECRET_BYTES) return existing;
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const release = await acquireOwnershipSafeLock(await socketSecretLockPath(path));
	try {
		// The first read is only a hint (design 4.4): a contender may have published or repaired since.
		const current = await readSecretEntry(path);
		if (current?.length === SOCKET_SECRET_BYTES) return current;
		// Windows keeps the in-place writer until the native no-replace bridge (senpi#4310, #4312) is wired.
		if (process.platform === "win32") return await writeSocketSecretInPlace(path);
		const candidate = randomBytes(SOCKET_SECRET_BYTES);
		if (current === undefined) {
			if ((await publishSocketSecretIfAbsent(path, candidate, emitSocketSecretWarning)) === "published") {
				return candidate;
			}
			const winner = await readSecretEntry(path);
			if (winner?.length === SOCKET_SECRET_BYTES) return winner;
			throw new Error(`RPC socket secret is invalid and was not replaced: ${path}`);
		}
		await replaceSocketSecret(path, candidate);
		return candidate;
	} finally {
		await release();
	}
}

/**
 * The bytes of the regular file at `path`, read up to one byte past the valid length, or `undefined` when
 * nothing is there. A terminal symlink or another entry type throws instead of being followed or written
 * through: only a regular file is a credential this process may reuse or repair
 * (sisyphuslabs/omo-desktop-app#4199).
 */
async function readSecretEntry(path: string): Promise<Buffer | undefined> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT")) return undefined;
		if (isNodeErrorCode(error, "ELOOP")) throw new Error(`RPC socket secret is not a regular file: ${path}`);
		throw error;
	}
	try {
		if (!(await handle.stat()).isFile()) throw new Error(`RPC socket secret is not a regular file: ${path}`);
		const buffer = Buffer.alloc(SOCKET_SECRET_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		return buffer.subarray(0, length);
	} finally {
		await handle.close();
	}
}

/**
 * Publishes a fresh secret at `path` unless one is already there (design 4.3). A valid regular file already at the
 * path, or published by a concurrent creator, is returned unchanged; an invalid one is refused, never replaced.
 * Windows keeps the in-place writer until the native no-replace bridge (senpi#4310, loaded by #4312) is wired.
 * `warn` receives the warnings of a publication that succeeded; the interactive TUI shows them in its notice line.
 */
export async function createSocketSecret(
	path: string,
	warn: SocketSecretWarn = emitSocketSecretWarning,
): Promise<Buffer> {
	if (process.platform === "win32") return writeSocketSecretInPlace(path);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const candidate = randomBytes(SOCKET_SECRET_BYTES);
	if (
		(await readSecretEntry(path)) === undefined &&
		(await publishSocketSecretIfAbsent(path, candidate, warn)) === "published"
	) {
		return candidate;
	}
	const winner = await readSecretEntry(path);
	if (winner?.length !== SOCKET_SECRET_BYTES) {
		throw new Error(`RPC socket secret is invalid and was not replaced: ${path}`);
	}
	return winner;
}

/**
 * First publication (sisyphuslabs/omo-desktop-app#4199, design 4.3 and 4.5): the candidate goes to a private
 * same-directory staging file and is published with `link()`, which never replaces an existing entry. The final path
 * is never opened for writing, and cleanup only ever removes this attempt's own staging file. Kept in this module so
 * the supervisor's startup import graph does not grow (test/supervisor-import-graph.test.ts).
 */
type SocketSecretPublication = "published" | "collision";

/** What `link()` fails with only on a filesystem without hard links (some network and FUSE mounts, FAT on macOS). */
const NO_HARD_LINK_CODES = ["ENOTSUP", "EOPNOTSUPP", "ENOSYS"] as const;

/** Linux statfs magic numbers of filesystems without hard links, whose `link()` fails EPERM: msdos/vfat, exfat. */
const NO_HARD_LINK_FILESYSTEMS = new Set([0x4d44, 0x2011bab0]);

/** A warning about a secret that was published anyway; never carries the secret. */
interface SocketSecretWarning {
	readonly code: string;
	readonly message: string;
	readonly path: string;
	readonly cause: string;
}
type SocketSecretWarn = (warning: SocketSecretWarning) => void;

function emitSocketSecretWarning({ code, message, path, cause }: SocketSecretWarning): void {
	process.emitWarning(message, { code, detail: JSON.stringify({ path, cause }) });
}

/**
 * First publication without hard links: the only other way to publish is to write the final path itself, which this
 * design never does (a reader could see a partial secret, and a racing creator's secret could be overwritten). So the
 * publication is refused, naming the `link()` error as its `cause`.
 */
class SocketSecretHardLinksUnsupportedError extends Error {
	readonly reason = "hard_links_unsupported";
	readonly path: string;

	constructor(path: string, cause: unknown) {
		const code = String(Reflect.get(Object(cause), "code"));
		super(`RPC socket secret cannot be published at ${path}: its filesystem refused a hard link (${code})`, {
			cause,
		});
		this.name = "SocketSecretHardLinksUnsupportedError";
		this.path = path;
	}
}

/**
 * `link()` failed EPERM on a filesystem not known to lack hard links: a sandbox or MAC policy, or an immutable or
 * append-only directory, refused it. Refused like the case above, naming the `link()` error as its `cause`.
 */
class SocketSecretLinkRefusedError extends Error {
	readonly reason = "link_refused";
	readonly path: string;

	constructor(path: string, cause: unknown) {
		super(
			`RPC socket secret cannot be published at ${path}: its hard link was refused by a permission or policy check (sandbox, MAC policy, or an immutable or append-only directory) (EPERM)`,
			{ cause },
		);
		this.name = "SocketSecretLinkRefusedError";
		this.path = path;
	}
}

/** EPERM is also a policy refusal, so it means "no hard links" only on a filesystem known to have none. */
async function lacksHardLinks(dir: string, error: unknown): Promise<boolean> {
	if (NO_HARD_LINK_CODES.some((code) => isNodeErrorCode(error, code))) return true;
	if (!isNodeErrorCode(error, "EPERM")) return false;
	// A failed statfs is no evidence of a filesystem without hard links; the refusal keeps the link() error as cause.
	const stats = await statfs(dir).catch(() => undefined);
	return stats !== undefined && NO_HARD_LINK_FILESYSTEMS.has(stats.type);
}

/**
 * Publishes `candidate` at `path` unless an entry already exists there. POSIX only. Once `link()` succeeded the
 * secret at `path` is this candidate and cannot be taken back, so a later directory fsync or staging cleanup failure
 * is a warning, never the outcome; a failed `link()` is reported over a failed cleanup after it.
 */
async function publishSocketSecretIfAbsent(
	path: string,
	candidate: Buffer,
	warn: SocketSecretWarn,
): Promise<SocketSecretPublication> {
	const staging = stagingPath(path);
	await writeStaging(staging, candidate);
	try {
		await link(staging, path);
	} catch (error: unknown) {
		await removeStaging(staging, warn);
		if (isNodeErrorCode(error, "EEXIST")) return "collision";
		if (await lacksHardLinks(dirname(path), error)) throw new SocketSecretHardLinksUnsupportedError(path, error);
		if (isNodeErrorCode(error, "EPERM")) throw new SocketSecretLinkRefusedError(path, error);
		throw error;
	}
	await syncInstalledDirectory(path, "publishing", warn);
	await removeStaging(staging, warn);
	return "published";
}

/** The fsync after `link()` or `rename()` installed the secret; the secret stays, so a failure only warns. */
async function syncInstalledDirectory(path: string, after: string, warn: SocketSecretWarn): Promise<void> {
	await syncDirectory(dirname(path)).catch((error: unknown) => {
		warnPublication(
			warn,
			"SENPI_RPC_SOCKET_SECRET_DIRECTORY_SYNC_FAILED",
			`directory fsync failed after ${after}`,
			path,
			error,
		);
	});
}

async function removeStaging(staging: string, warn: SocketSecretWarn): Promise<void> {
	await unlink(staging).catch((error: unknown) => {
		if (isNodeErrorCode(error, "ENOENT")) return;
		warnPublication(
			warn,
			"SENPI_RPC_SOCKET_SECRET_STAGING_LEFT_BEHIND",
			"staging file was not removed",
			staging,
			error,
		);
	});
}

function warnPublication(warn: SocketSecretWarn, code: string, what: string, path: string, error: unknown): void {
	warn({ code, message: `RPC socket secret ${what}`, path, cause: String(error) });
}

async function writeStaging(staging: string, candidate: Buffer): Promise<void> {
	const handle = await open(
		staging,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
		0o600,
	);
	let failure: unknown;
	try {
		// The creation mode is filtered by the umask; set it on the descriptor before any byte is written.
		await handle.chmod(0o600);
		let offset = 0;
		while (offset < candidate.length) {
			const { bytesWritten } = await handle.write(candidate, offset, candidate.length - offset, null);
			if (bytesWritten === 0) throw new Error(`short write to the RPC socket secret staging file: ${staging}`);
			offset += bytesWritten;
		}
		await handle.sync();
	} catch (error: unknown) {
		failure = error;
	}
	// Close always runs, and a failed close fails the attempt: the first failure is the one reported, and this
	// attempt's staging file never outlives it.
	await handle.close().catch((error: unknown) => {
		failure ??= error;
	});
	if (failure !== undefined) {
		await unlink(staging).catch(() => undefined);
		throw failure;
	}
}

async function syncDirectory(dir: string): Promise<void> {
	const handle = await open(dir, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * The per-secret mutation lock (design 4.2): `<canonical parent>/<name>.publish.lock`, so every spelling of one
 * physical secret takes the same lock. It holds only the SQLite lock database, is created owner-only, must be a regular
 * file, and is never removed.
 */
async function socketSecretLockPath(path: string): Promise<string> {
	const lockPath = join(await realpath(dirname(path)), `${basename(path)}.publish.lock`);
	const handle = await open(lockPath, constants.O_RDONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
	try {
		if (!(await handle.stat()).isFile()) throw new Error(`RPC socket secret lock is not a regular file: ${lockPath}`);
	} finally {
		await handle.close();
	}
	return lockPath;
}

/**
 * Replaces an invalid secret with `candidate` in one rename; the old entry stays until that rename (design 4.4). Once
 * the rename landed the candidate is the secret, so a failed directory fsync after it only warns.
 */
async function replaceSocketSecret(path: string, candidate: Buffer): Promise<void> {
	const staging = stagingPath(path);
	await writeStaging(staging, candidate);
	try {
		await rename(staging, path);
	} catch (error: unknown) {
		await unlink(staging).catch(() => undefined);
		throw error;
	}
	await syncInstalledDirectory(path, "repairing", emitSocketSecretWarning);
}

function stagingPath(path: string): string {
	return join(dirname(path), `.${basename(path)}.stage-${process.pid}-${randomBytes(8).toString("hex")}`);
}

async function writeSocketSecretInPlace(path: string): Promise<Buffer> {
	await mkdir(dirname(path), { recursive: true });
	const secret = randomBytes(SOCKET_SECRET_BYTES);
	await writeFile(path, secret, { mode: 0o600 });
	await chmod(path, 0o600);
	return secret;
}

export async function readSocketSecret(path: string): Promise<Buffer> {
	const secret = await readFile(path);
	if (secret.length !== SOCKET_SECRET_BYTES) throw new Error(`invalid RPC socket secret: ${path}`);
	return secret;
}

export function resolveSocketTransportAddress(
	socketPath: string,
	platform: NodeJS.Platform,
	secret?: Uint8Array,
): string {
	if (platform !== "win32") return socketPath;
	if (socketPath.toLowerCase().startsWith("\\\\.\\pipe\\")) return socketPath;
	if (!/^[a-zA-Z]:[\\/]/.test(socketPath) && !/^\\\\[^/]/.test(socketPath)) {
		throw new Error(`Windows RPC socket path must be drive-qualified or UNC: ${socketPath}`);
	}
	const canonical = win32.normalize(socketPath).toLowerCase();
	const identity = Buffer.concat([Buffer.from(canonical, "utf8"), Buffer.from(secret ?? [])]);
	const name = createHash("sha256").update(identity).digest("hex").slice(0, 32);
	return `${WINDOWS_PIPE_PREFIX}${name}`;
}

export function authenticateSocket(socket: Socket, secret: Uint8Array, onAuthenticated: () => void): void {
	let received = Buffer.alloc(0);
	const finish = (): void => {
		clearTimeout(timer);
		socket.off("data", onData);
		socket.off("error", onError);
	};
	const onError = (): void => {
		finish();
		socket.destroy();
	};
	const timer = setTimeout(() => {
		finish();
		socket.destroy();
	}, SOCKET_HANDSHAKE_TIMEOUT_MS);
	const onData = (chunk: Buffer): void => {
		received = Buffer.concat([received, chunk]);
		if (received.length < secret.length) return;
		finish();
		if (!timingSafeEqual(received.subarray(0, secret.length), Buffer.from(secret))) {
			socket.destroy();
			return;
		}
		const remainder = received.subarray(secret.length);
		if (remainder.length > 0) socket.unshift(remainder);
		onAuthenticated();
	};
	socket.on("data", onData);
	socket.once("error", onError);
	socket.once("close", finish);
}

export function sendSocketHandshake(socket: Socket, secret: Uint8Array): void {
	socket.write(Buffer.from(secret));
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
