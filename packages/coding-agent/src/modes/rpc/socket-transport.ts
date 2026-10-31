import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { basename, dirname, join, win32 } from "node:path";

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
	// A wrong-sized file is repaired in place until the serialized repair of design 4.4 lands (#4199 S6).
	if (existing) return writeSocketSecretInPlace(path);
	return createSocketSecret(path);
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
 */
export async function createSocketSecret(path: string): Promise<Buffer> {
	if (process.platform === "win32") return writeSocketSecretInPlace(path);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const candidate = randomBytes(SOCKET_SECRET_BYTES);
	if (
		(await readSecretEntry(path)) === undefined &&
		(await publishSocketSecretIfAbsent(path, candidate)) === "published"
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

/** Publishes `candidate` at `path` unless an entry already exists there. POSIX only. */
async function publishSocketSecretIfAbsent(path: string, candidate: Buffer): Promise<SocketSecretPublication> {
	const staging = join(dirname(path), `.${basename(path)}.stage-${process.pid}-${randomBytes(8).toString("hex")}`);
	await writeStaging(staging, candidate);
	try {
		await link(staging, path);
		await syncDirectory(dirname(path));
		return "published";
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "EEXIST")) return "collision";
		throw error;
	} finally {
		await unlink(staging).catch((error: unknown) => {
			if (!isNodeErrorCode(error, "ENOENT")) throw error;
		});
	}
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
