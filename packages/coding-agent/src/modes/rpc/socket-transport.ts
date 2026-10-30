import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { dirname, win32 } from "node:path";

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

export async function createSocketSecret(path: string): Promise<Buffer> {
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
