/**
 * Generic atomic, versioned, per-session sidecar store.
 *
 * Extracted from the loop store's persistence discipline: a module-level per-file
 * promise tail serializes read-modify-write cycles, writes go through a temp file
 * with 0600 permissions and a rename, and parsing fails closed on version or
 * session mismatches so a corrupt or foreign file never silently resets state.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export class InvalidSidecarStoreError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "InvalidSidecarStoreError";
	}
}

export class UnsupportedSidecarStoreVersionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedSidecarStoreVersionError";
	}
}

/** Location identity of one sidecar file: a directory plus the session it belongs to. */
export interface SidecarStoreRef {
	baseDir: string;
	sessionId: string;
}

/** Validates the domain fields of an already version- and session-checked payload. */
export type SidecarPayloadParser<T> = (raw: unknown, ref: SidecarStoreRef) => T;

export interface CreateSidecarStoreOptions<T> {
	baseDir: string;
	sessionId: string;
	version: number;
	tempPrefix: string;
	parse: SidecarPayloadParser<T>;
}

export interface SidecarStore<T> {
	filePath: string;
	read(): Promise<T | null>;
	write(state: T): Promise<void>;
	mutate(fn: (current: T | null) => T | Promise<T>): Promise<T>;
	snapshot(): T | undefined;
	clear(): void;
}

const mutationTails = new Map<string, Promise<void>>();
const snapshots = new Map<string, unknown>();

export function encodedSessionId(sessionId: string): string {
	return encodeURIComponent(sessionId);
}

export function sidecarFilePath(ref: SidecarStoreRef): string {
	return join(ref.baseDir, `${encodedSessionId(ref.sessionId)}.json`);
}

/**
 * Creates a per-session store bound to `baseDir/<encoded session id>.json`.
 * Two stores for the same file share the mutation tail and snapshot cache.
 */
export function createSidecarStore<T>(options: CreateSidecarStoreOptions<T>): SidecarStore<T> {
	const ref: SidecarStoreRef = { baseDir: options.baseDir, sessionId: options.sessionId };
	const filePath = sidecarFilePath(ref);

	async function read(): Promise<T | null> {
		let raw: string;
		try {
			raw = await readFile(filePath, "utf8");
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) return null;
			throw error;
		}
		const state = parsePayload(raw, options, ref);
		snapshots.set(filePath, state);
		return state;
	}

	async function write(state: T): Promise<void> {
		await mkdir(dirname(filePath), { recursive: true });
		await writeAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`, options.tempPrefix);
		snapshots.set(filePath, state);
	}

	function mutate(fn: (current: T | null) => T | Promise<T>): Promise<T> {
		return serializeByKey(filePath, async () => {
			const next = await fn(await read());
			await write(next);
			return next;
		});
	}

	return {
		filePath,
		read,
		write,
		mutate,
		snapshot: () => snapshots.get(filePath) as T | undefined,
		clear: () => {
			snapshots.delete(filePath);
		},
	};
}

/**
 * Writes `contents` to `filePath` atomically: a hidden temp file (0600) next to the
 * target, then a rename over it. On failure the temp file is removed; if that
 * cleanup also fails, both errors surface as one AggregateError.
 */
export async function writeAtomic(filePath: string, contents: string, tempPrefix: string): Promise<void> {
	const tempPath = join(dirname(filePath), `.${tempPrefix}-${randomUUID()}.tmp`);
	try {
		await writeFile(tempPath, contents, { encoding: "utf8", mode: 0o600 });
		await rename(tempPath, filePath);
	} catch (error) {
		try {
			await rm(tempPath, { force: true });
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"sidecar store write failed and its temporary file could not be removed",
			);
		}
		throw error;
	}
}

/**
 * Parses raw file contents, rejecting malformed JSON, a non-object payload, a
 * version other than `options.version`, and a sessionId other than the ref's
 * before handing the payload to the domain parser. Fail closed: never resets.
 */
function parsePayload<T>(raw: string, options: CreateSidecarStoreOptions<T>, ref: SidecarStoreRef): T {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new InvalidSidecarStoreError("sidecar store contains unparseable JSON", { cause: error });
	}
	if (!isRecord(parsed)) throw new InvalidSidecarStoreError("sidecar store must be a JSON object");
	if (parsed.version !== options.version) {
		throw new UnsupportedSidecarStoreVersionError(
			`unsupported sidecar store version: ${JSON.stringify(parsed.version)} (expected ${options.version})`,
		);
	}
	if (typeof parsed.sessionId !== "string" || parsed.sessionId.length === 0) {
		throw new InvalidSidecarStoreError("sidecar store is missing a sessionId");
	}
	if (parsed.sessionId !== ref.sessionId) {
		throw new InvalidSidecarStoreError(
			`sidecar store sessionId ${parsed.sessionId} does not match the session it was loaded for`,
		);
	}
	return options.parse(parsed, ref);
}

/**
 * Serializes read-modify-write cycles per key across every sidecar consumer.
 *
 * `key` must be the resolved absolute file path of the sidecar (the same string
 * `createSidecarStore` uses for that file). Callers that own their own writer
 * (goal) call this directly around that writer. Callers that want the whole
 * store (loop) go through `createSidecarStore`, whose `mutate` already uses
 * this tail.
 */
export function serializeByKey<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const previous = mutationTails.get(key) ?? Promise.resolve();
	const run = previous.then(operation);
	const tail = run.then(
		() => undefined,
		() => undefined,
	);
	mutationTails.set(key, tail);
	void tail.then(() => {
		if (mutationTails.get(key) === tail) mutationTails.delete(key);
	});
	return run;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileSystemError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
