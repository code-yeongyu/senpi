import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readSync,
	rmSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../../../config.ts";

const KEY_FILE = "config-identity.key";
const KEY_BYTES = 32;
const EPHEMERAL_PREFIX = "ephemeral:";
const processKey = randomBytes(KEY_BYTES);
const installationKeys = new Map<string, Buffer | undefined>();
const warnedPaths = new Set<string>();

type KeyRead = { readonly kind: "valid"; readonly key: Buffer } | { readonly kind: "missing" | "invalid" };

/** HMAC-SHA-256 under the installation key; without a valid key, an `ephemeral:` identity nothing may persist. */
export function keyedIdentity(agentDir: string | undefined, payload: string): string {
	const key = installationKey(agentDir ?? getAgentDir());
	return key === undefined ? `${EPHEMERAL_PREFIX}${hmac(processKey, payload)}` : hmac(key, payload);
}

export function isEphemeralIdentity(identity: string | undefined): boolean {
	return identity?.startsWith(EPHEMERAL_PREFIX) === true;
}

/** A short keyed fingerprint for warnings and log redactions; never an offline-guessable plain hash. */
export function keyedFingerprint(value: string): string {
	return hmac(installationKey(getAgentDir()) ?? processKey, value).slice(0, 8);
}

function hmac(key: Buffer, payload: string): string {
	return createHmac("sha256", key).update(payload).digest("hex");
}

function installationKey(agentDir: string): Buffer | undefined {
	if (!installationKeys.has(agentDir)) installationKeys.set(agentDir, loadOrPublishKey(agentDir));
	return installationKeys.get(agentDir);
}

function loadOrPublishKey(agentDir: string): Buffer | undefined {
	const path = join(agentDir, KEY_FILE);
	const existing = readKey(path);
	if (existing.kind === "valid") return existing.key;
	return existing.kind === "missing" ? publishKey(agentDir, path) : undefined;
}

/** Only a regular file we own, mode 0600, of exactly 32 bytes is ever used; anything else is left untouched. */
function readKey(path: string): KeyRead {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (error) {
		return isErrno(error, "ENOENT")
			? { kind: "missing" }
			: invalidKey(path, "cannot open safely", "repair access and ensure it is a regular file, not a symlink");
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) return invalidKey(path, "not a regular file", "restore the original private key file");
		if (stat.size !== KEY_BYTES)
			return invalidKey(path, `wrong size (${stat.size} bytes)`, "restore the original 32-byte key from backup");
		if (process.platform !== "win32") {
			if (stat.uid !== process.getuid?.())
				return invalidKey(path, "wrong owner", "chown the key file to your current user");
			if ((stat.mode & 0o777) !== 0o600) return invalidKey(path, "wrong mode", "chmod 600 the key file");
		}
		const key = Buffer.alloc(KEY_BYTES);
		return readSync(fd, key, 0, KEY_BYTES, 0) === KEY_BYTES
			? { kind: "valid", key }
			: invalidKey(path, "incomplete read", "restore the original 32-byte key from backup");
	} finally {
		closeSync(fd);
	}
}

function invalidKey(path: string, problem: string, repair: string): KeyRead {
	if (!warnedPaths.has(path)) {
		warnedPaths.add(path);
		console.warn(
			`MCP identity key ${path}: ${problem}; persistent catalog cache is disabled. To fix: ${repair}, then restart senpi. The file was left unchanged.`,
		);
	}
	return { kind: "invalid" };
}

/** A private temporary file published with link(): the key is complete or absent, and never replaced. */
function publishKey(agentDir: string, path: string): Buffer | undefined {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		mkdirSync(agentDir, { recursive: true, mode: 0o700 });
		const key = randomBytes(KEY_BYTES);
		const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		try {
			writeSync(fd, key);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		linkSync(temporary, path);
		syncDirectory(agentDir);
		return key;
	} catch (error) {
		if (!isErrno(error, "EEXIST")) return undefined;
		const published = readKey(path);
		return published.kind === "valid" ? published.key : undefined;
	} finally {
		rmSync(temporary, { force: true });
	}
}

function syncDirectory(directory: string): void {
	if (process.platform === "win32") return;
	const fd = openSync(directory, constants.O_RDONLY);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function isErrno(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
