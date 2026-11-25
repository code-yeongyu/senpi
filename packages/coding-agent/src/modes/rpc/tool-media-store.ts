import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { assertValidSessionId } from "../../core/session-manager.ts";
import { type AsyncMediaPersister, base64ByteLength, type PersistedMedia } from "./media-placeholders.ts";
import { acquireOwnershipSafeLock } from "./ownership-safe-lock.ts";

/**
 * Where a session keeps the images its tools produced.
 *
 * A `media_placeholders` client never receives the bytes on the socket. The host writes them
 * here, once, BEFORE the placeholder that names the file is emitted, so a client can render the
 * picture from the path whenever it likes: after a disconnect, an idle shutdown or a generation
 * handover, because the files outlive every connection. The directory sits next to the session
 * files, never under the user's project, and is removed with the durable session.
 */
export interface ToolMediaScope {
	readonly sessionDir: string;
	readonly durableSessionId: string;
}

export const MAX_TOOL_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_SESSION_MEDIA_BYTES = 256 * 1024 * 1024;

export interface ToolMediaLimits {
	readonly perImage: number;
	readonly perSession: number;
}

const DEFAULT_LIMITS: ToolMediaLimits = { perImage: MAX_TOOL_IMAGE_BYTES, perSession: MAX_SESSION_MEDIA_BYTES };

const MEDIA_DIRECTORY = "media";
const EXTENSIONS: Readonly<Record<string, string>> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};

const SIGNATURES: Readonly<Record<string, (bytes: Buffer) => boolean>> = {
	"image/png": (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
	"image/jpeg": (bytes) => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
	"image/gif": (bytes) => bytes.subarray(0, 4).toString("latin1") === "GIF8",
	"image/webp": (bytes) =>
		bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP",
};

async function lstatIfPresent(path: string) {
	try {
		return await lstat(path);
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
		throw cause;
	}
}

async function assertRealDirectoryChain(root: string, callDirectory: string): Promise<void> {
	for (const path of [dirname(root), root, callDirectory]) {
		const stat = await lstatIfPresent(path);
		if (stat && !stat.isDirectory()) throw new Error(`not a real directory: ${path}`);
	}
}
/** Outcomes per live image block, so re-emitting a record (`get_messages`, `turn_end`) never rehashes it. */
const outcomes = new WeakMap<object, Promise<PersistedMedia>>();

export interface LiveSessionSource {
	readonly runtime?: {
		readonly session: {
			readonly sessionManager: { getSessionFile(): string | undefined; getSessionId(): string };
		};
	};
	readonly worker?: {
		readonly snapshot?: { readonly state: { readonly sessionFile?: string; readonly sessionId: string } };
	};
}

export function liveToolMediaScope(entry: LiveSessionSource): ToolMediaScope | undefined {
	const manager = entry.runtime?.session.sessionManager;
	const sessionFile = manager?.getSessionFile() ?? entry.worker?.snapshot?.state.sessionFile;
	const durableSessionId = manager?.getSessionId() ?? entry.worker?.snapshot?.state.sessionId;
	return sessionFile === undefined || durableSessionId === undefined
		? undefined
		: { sessionDir: dirname(sessionFile), durableSessionId };
}

export function toolMediaRoot(scope: ToolMediaScope): string {
	assertValidSessionId(scope.durableSessionId);
	return join(scope.sessionDir, MEDIA_DIRECTORY, scope.durableSessionId);
}

/** Stream directory entries and stat one at a time; stop once no new image can fit. */
async function directoryBytes(directory: string, budget: number): Promise<number> {
	let total = 0;
	for await (const entry of await opendir(directory)) {
		const path = join(directory, entry.name);
		total += entry.isDirectory() ? await directoryBytes(path, budget - total) : (await lstat(path)).size;
		if (total > budget) break;
	}
	return total;
}

const BASE64_CHUNK = 256 * 1024;

async function decodeAndHash(data: string, length: number): Promise<{ bytes: Buffer; digest: string }> {
	// The length estimate subtracts up to two pad bytes even for noncanonical input.
	const buffer = Buffer.allocUnsafe(length + 2);
	const hash = createHash("sha256");
	let written = 0;
	let remainder = "";
	for (let offset = 0; offset < data.length; offset += BASE64_CHUNK) {
		if (offset !== 0) await setImmediate();
		const chunk = data.slice(offset, offset + BASE64_CHUNK);
		const padding = chunk.indexOf("=");
		// Match Buffer's base64 decoder (including ignored characters and base64url).
		const symbols = remainder + (padding < 0 ? chunk : chunk.slice(0, padding)).replace(/[^a-z\d+/_-]/gi, "");
		const end = padding >= 0 || offset + BASE64_CHUNK >= data.length ? symbols.length : symbols.length & ~3;
		const decoded = Buffer.from(symbols.slice(0, end), "base64");
		decoded.copy(buffer, written);
		written += decoded.length;
		hash.update(decoded);
		if (padding >= 0) break;
		remainder = symbols.slice(end);
	}
	return { bytes: buffer.subarray(0, written), digest: hash.digest("hex") };
}

const unavailable = (reason: "image_too_large" | "session_limit" | "storage_error"): PersistedMedia => ({
	unavailableReason: reason,
});

async function writeImage(root: string, path: string, bytes: Buffer): Promise<void> {
	const callDirectory = dirname(path);
	await mkdir(callDirectory, { recursive: true, mode: 0o700 });
	await assertRealDirectoryChain(root, callDirectory);
	const staging = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await writeFile(staging, bytes, { mode: 0o600, flag: "wx" });
		await rename(staging, path);
		await chmod(path, 0o400);
	} catch (cause) {
		await rm(staging, { force: true });
		throw cause;
	}
}

/**
 * Persist one tool-result image and report where it lives, or why it does not.
 *
 * Layout: `<sessionDir>/media/<durableSessionId>/<sha256(toolCallId)>/<contentIndex>-<sha256(bytes)>.<ext>`.
 * The content hash makes a file immutable and a repeat a no-op; the per-image and per-session
 * limits reject new storage and never evict a file a transcript may still reference.
 */
export function persistToolImage(
	scope: ToolMediaScope,
	ref: { readonly toolCallId: string; readonly contentIndex: number },
	block: { readonly data: string; readonly mimeType?: string },
	limits: ToolMediaLimits = DEFAULT_LIMITS,
): Promise<PersistedMedia> {
	const known = outcomes.get(block);
	if (known !== undefined) return known;
	const pending = store(scope, ref, block, limits).then((outcome) => {
		if ("unavailableReason" in outcome && outcome.unavailableReason === "storage_error") outcomes.delete(block);
		return outcome;
	});
	outcomes.set(block, pending);
	return pending;
}

async function store(
	scope: ToolMediaScope,
	ref: { readonly toolCallId: string; readonly contentIndex: number },
	block: { readonly data: string; readonly mimeType?: string },
	limits: ToolMediaLimits,
): Promise<PersistedMedia> {
	const mimeType = (block.mimeType ?? "").toLowerCase();
	const extension = EXTENSIONS[mimeType];
	if (extension === undefined) return unavailable("storage_error");
	const length = base64ByteLength(block.data);
	if (length > limits.perImage) return unavailable("image_too_large");
	try {
		const { bytes, digest } = await decodeAndHash(block.data, length);
		if (bytes.length > limits.perImage) return unavailable("image_too_large");
		if (SIGNATURES[mimeType]?.(bytes) !== true) return unavailable("storage_error");
		const root = toolMediaRoot(scope);
		const callDirectory = createHash("sha256").update(ref.toolCallId).digest("hex");
		const path = resolve(root, callDirectory, `${ref.contentIndex}-${digest}.${extension}`);
		await assertRealDirectoryChain(root, dirname(path));
		await mkdir(dirname(root), { recursive: true, mode: 0o700 });
		await assertRealDirectoryChain(root, dirname(path));
		// The lock inode must survive deletion of the session's image tree.
		const lockPath = `${root}.lock`;
		const lock = await lstatIfPresent(lockPath);
		if (lock && !lock.isFile()) return unavailable("storage_error");
		const release = await acquireOwnershipSafeLock(lockPath, {
			retries: { retries: 10_000, minTimeout: 20, maxTimeout: 1 },
		});
		try {
			await assertRealDirectoryChain(root, dirname(path));
			const existing = await lstatIfPresent(path);
			if (existing) return existing.isFile() ? { path } : unavailable("storage_error");
			const budget = limits.perSession - bytes.length;
			if (budget < 0 || ((await lstatIfPresent(root)) && (await directoryBytes(root, budget)) > budget))
				return unavailable("session_limit");
			await writeImage(root, path, bytes);
			return { path };
		} finally {
			await release();
		}
	} catch {
		return unavailable("storage_error");
	}
}

export function toolMediaPersister(scope: () => ToolMediaScope | undefined): AsyncMediaPersister {
	return (ref, block) => {
		const current = scope();
		return current === undefined ? undefined : () => persistToolImage(current, ref, block);
	};
}

export function removeToolMedia(scope: ToolMediaScope): void {
	const root = toolMediaRoot(scope);
	makeTreeWritable(root);
	rmSync(root, { recursive: true, force: true });
}

function makeTreeWritable(path: string): void {
	let entries: import("node:fs").Dirent[];
	try {
		if (!lstatSync(path).isDirectory()) return;
		chmodSync(path, 0o700);
		entries = readdirSync(path, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) makeTreeWritable(child);
		else if (entry.isFile())
			try {
				chmodSync(child, 0o600);
			} catch {}
	}
}

/** The media scope of the session stored in `sessionFile`; a file with no readable header has none. */
export async function toolMediaScopeOfSessionFile(sessionFile: string): Promise<ToolMediaScope | undefined> {
	try {
		const handle = await open(sessionFile, "r");
		try {
			const { buffer, bytesRead } = await handle.read(Buffer.alloc(4096), 0, 4096, 0);
			const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
			const id = (JSON.parse(firstLine) as { id?: unknown }).id;
			return typeof id === "string" ? { sessionDir: dirname(sessionFile), durableSessionId: id } : undefined;
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}
