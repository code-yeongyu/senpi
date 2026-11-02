import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { parseRepositoryIdentity, type RepositoryIdentity } from "../repository-identity.ts";
import type { MoveId } from "./ownership.ts";

export const MOVE_BUNDLE_FORMAT = 1;
export const MANIFEST_FILE = "manifest.json";
export const SESSION_BUNDLE_PATH = "files/session.jsonl";

export interface BundleFile {
	readonly path: string;
	readonly sha256: string;
}

/**
 * Optional extra payloads travel next to the session without changing its shape: `extension-state` carries what
 * extensions wrote at the move release (senpi#3676). An importer that does not know a kind refuses the bundle.
 */
export interface MovePayload {
	readonly kind: string;
	readonly files: readonly BundleFile[];
}

export interface MoveManifest {
	readonly format: typeof MOVE_BUNDLE_FORMAT;
	readonly moveId: MoveId;
	readonly sessionId: string;
	readonly sessionFileName: string;
	readonly sourceCwd: string;
	readonly repository: RepositoryIdentity | undefined;
	readonly session: BundleFile;
	readonly sidecars: readonly BundleFile[];
	readonly droppedUserMessages: readonly string[];
	readonly payloads: readonly MovePayload[];
}

export class MoveBundleInvalidError extends Error {
	readonly code = "move_bundle_invalid";

	constructor(detail: string) {
		super(`The moved session could not be verified (${detail}); it was not imported. The original device keeps it.`);
		this.name = "MoveBundleInvalidError";
	}
}

/** Streams the file through the hash, so a large blob never blocks the host's event loop. */
export async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

const isString = (value: unknown): value is string => typeof value === "string";

/** Both separators count: a bundle written on one OS is read on another. */
function leavesBundle(path: string): boolean {
	return posix.isAbsolute(path) || win32.isAbsolute(path) || path.split(/[\\/]/).includes("..");
}

function parseFile(value: unknown): BundleFile {
	const file = value as Partial<BundleFile> | null;
	if (typeof file !== "object" || file === null || !isString(file.path) || !isString(file.sha256))
		throw new MoveBundleInvalidError("a listed file is malformed");
	if (leavesBundle(file.path)) throw new MoveBundleInvalidError(`a listed path leaves the bundle: ${file.path}`);
	return { path: file.path, sha256: file.sha256 };
}

/**
 * Move ids and session ids become folder and file names (staging folder, ledger record, resident blobs), so they
 * must be plain ids: a letter or digit first (never `.` or `..`), then letters, digits, `.`, `_`, `-`, at most 128.
 */
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isPlainId(value: unknown): value is string {
	return typeof value === "string" && PLAIN_ID.test(value);
}

export function isMoveId(value: unknown): value is MoveId {
	return isPlainId(value);
}

export function parsePlainId(value: unknown, what: string): string {
	if (typeof value !== "string" || !PLAIN_ID.test(value))
		throw new MoveBundleInvalidError(`the ${what} is not a plain id: ${JSON.stringify(value)}`);
	return value;
}

export function parseMoveId(value: unknown): MoveId {
	return parsePlainId(value, "move id") as MoveId;
}

/** The importer joins this name onto its session folder, so it must be a plain session file name and nothing else. */
const SESSION_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/;

function parseSessionFileName(value: string): string {
	if (!SESSION_FILE_NAME.test(value) || value.includes(".."))
		throw new MoveBundleInvalidError(`the session file name is not a plain file name: ${value}`);
	return value;
}

/** Payload kinds this version imports; any other kind refuses the bundle. */
export const KNOWN_PAYLOAD_KINDS: ReadonlySet<string> = new Set(["extension-state"]);

/** Where `extension-state` payload files sit inside the bundle. */
export const EXTENSION_STATE_PREFIX = "state/";

function parsePayload(value: unknown): MovePayload {
	const payload = value as Partial<MovePayload> | null;
	if (typeof payload !== "object" || payload === null || !isString(payload.kind) || !Array.isArray(payload.files))
		throw new MoveBundleInvalidError("a payload is malformed");
	if (!KNOWN_PAYLOAD_KINDS.has(payload.kind))
		throw new MoveBundleInvalidError("it carries a payload this version cannot import");
	const files = payload.files.map(parseFile);
	// The importer unpacks extension state by stripping this prefix; a file anywhere else is not extension state.
	const outside = files.find((file) => !file.path.startsWith(EXTENSION_STATE_PREFIX));
	if (outside !== undefined)
		throw new MoveBundleInvalidError(`an extension-state file is listed outside state/: ${outside.path}`);
	return { kind: payload.kind, files };
}

export async function readManifest(bundleDir: string): Promise<MoveManifest> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(join(bundleDir, MANIFEST_FILE), "utf8"));
	} catch (error) {
		throw new MoveBundleInvalidError(
			`manifest unreadable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const m = raw as Record<string, unknown>;
	if (m.format !== MOVE_BUNDLE_FORMAT) throw new MoveBundleInvalidError(`unknown bundle format ${String(m.format)}`);
	for (const key of ["moveId", "sessionId", "sessionFileName", "sourceCwd"] as const) {
		if (!isString(m[key])) throw new MoveBundleInvalidError(`missing ${key}`);
	}
	const payloads = (Array.isArray(m.payloads) ? m.payloads : []).map(parsePayload);
	const dropped = Array.isArray(m.droppedUserMessages) ? m.droppedUserMessages : [];
	if (!dropped.every(isString)) throw new MoveBundleInvalidError("malformed queued input");
	return {
		format: MOVE_BUNDLE_FORMAT,
		moveId: parseMoveId(m.moveId),
		sessionId: parsePlainId(m.sessionId, "session id"),
		sessionFileName: parseSessionFileName(m.sessionFileName as string),
		sourceCwd: m.sourceCwd as string,
		repository: parseRepositoryIdentity(m.repository),
		session: parseFile(m.session),
		sidecars: (Array.isArray(m.sidecars) ? m.sidecars : []).map(parseFile),
		droppedUserMessages: dropped,
		payloads,
	};
}

export async function verifyBundle(bundleDir: string, manifest: MoveManifest): Promise<void> {
	for (const file of [manifest.session, ...manifest.sidecars, ...manifest.payloads.flatMap((p) => p.files)]) {
		let actual: string;
		try {
			actual = await sha256File(join(bundleDir, file.path));
		} catch {
			throw new MoveBundleInvalidError(`missing ${file.path}`);
		}
		if (actual !== file.sha256) throw new MoveBundleInvalidError(`${file.path} changed in transit`);
	}
	const header = (await readFile(join(bundleDir, manifest.session.path), "utf8")).split("\n", 1)[0] ?? "";
	let id: unknown;
	try {
		id = (JSON.parse(header) as { readonly id?: unknown }).id;
	} catch {
		id = undefined;
	}
	if (id !== manifest.sessionId)
		throw new MoveBundleInvalidError("the session file's own id does not match the bundle's session id");
}
