import type { JsonValue } from "@earendil-works/pi-ai";

/**
 * The device's files, as extension code reaches them (brain/hand split, S40, senpi#5645). On a fused session this is
 * the local filesystem, called directly. On a split session every operation is one message to the hand, which checks
 * the session's grant, runs its own `tool_call` handlers and filesystem policy, and touches its own disk: the files
 * stay on the device wherever the loop runs. There is no fallback to a direct open.
 */
export interface DeviceFiles {
	read(path: string, options?: DeviceFileOptions): Promise<Uint8Array>;
	/** Creates parent directories. `exclusive`: fail `exists` when the file is already there (lock files). */
	write(path: string, data: Uint8Array, options?: DeviceFileOptions & { readonly exclusive?: boolean }): Promise<void>;
	list(path: string, options?: DeviceFileOptions): Promise<readonly string[]>;
	stat(path: string, options?: DeviceFileOptions): Promise<DeviceFileStat>;
	rename(from: string, to: string, options?: DeviceFileOptions): Promise<void>;
	/** Removes a file, or a directory with everything in it. */
	remove(path: string, options?: DeviceFileOptions): Promise<void>;
	/** Creates a directory and its parents; an existing directory is not an error. */
	mkdir(path: string, options?: DeviceFileOptions): Promise<void>;
}

export interface DeviceFileOptions {
	readonly signal?: AbortSignal;
}

export interface DeviceFileStat {
	readonly kind: "file" | "directory" | "other";
	readonly size: number;
	readonly mtimeMs: number;
}

/** The channel's name in a hand's `hello`. */
export const FILE_CHANNEL = "file/1";

/** The most data one operation reads or writes, in raw bytes, in both directions. */
export const FILE_CHANNEL_MAX_BYTES = 8 * 1024 * 1024;

export type DeviceFileOp = "read" | "write" | "list" | "stat" | "rename" | "remove" | "mkdir";
export const DEVICE_FILE_OPS: readonly DeviceFileOp[] = ["read", "write", "list", "stat", "rename", "remove", "mkdir"];

export type DeviceFileErrorCode =
	| "not_found"
	| "not_a_file"
	| "exists"
	| "too_large"
	| "io"
	| "aborted"
	| "refused_by_grant"
	| "refused_by_policy"
	| "hand_unreachable"
	| "unsupported"
	| "interrupted"
	| "protocol";

/**
 * A device file operation that did not complete. `interrupted` carries the hand's terminal reason; `uncertain` says the
 * operation may have taken effect (a write may or may not have landed). Nothing is ever retried.
 */
export class DeviceFileError extends Error {
	readonly code: DeviceFileErrorCode;
	readonly reason: string | undefined;
	readonly uncertain: boolean;
	constructor(code: DeviceFileErrorCode, message: string, detail: { reason?: string; uncertain?: boolean } = {}) {
		super(`${code}: ${message}`);
		this.name = "DeviceFileError";
		this.code = code;
		this.reason = detail.reason;
		this.uncertain = detail.uncertain ?? false;
	}
}

const CODES: readonly DeviceFileErrorCode[] = [
	"not_found",
	"not_a_file",
	"exists",
	"too_large",
	"io",
	"aborted",
	"refused_by_grant",
	"refused_by_policy",
	"hand_unreachable",
	"unsupported",
	"interrupted",
	"protocol",
];

export function isDeviceFileErrorCode(value: unknown): value is DeviceFileErrorCode {
	return typeof value === "string" && (CODES as readonly string[]).includes(value);
}

/** One operation's arguments, as the hand receives them: paths are strings, written data is base64. */
export type DeviceFileArgs =
	| { readonly op: "read" | "list" | "stat" | "remove" | "mkdir"; readonly path: string }
	| { readonly op: "write"; readonly path: string; readonly data: string; readonly exclusive: boolean }
	| { readonly op: "rename"; readonly path: string; readonly to: string };

/** One operation's outcome, carried in a settled result's `details.file`. */
export type DeviceFileOutcome =
	| { readonly ok: true; readonly value: JsonValue }
	| { readonly ok: false; readonly code: DeviceFileErrorCode; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Parses an operation's arguments; `undefined` for anything malformed. */
export function decodeDeviceFileArgs(op: unknown, args: unknown): DeviceFileArgs | undefined {
	if (!isRecord(args) || typeof args.path !== "string" || args.path.length === 0) return undefined;
	const path = args.path;
	switch (op) {
		case "read":
		case "list":
		case "stat":
		case "remove":
		case "mkdir":
			return { op, path };
		case "write":
			return typeof args.data === "string"
				? { op, path, data: args.data, exclusive: args.exclusive === true }
				: undefined;
		case "rename":
			return typeof args.to === "string" && args.to.length > 0 ? { op, path, to: args.to } : undefined;
		default:
			return undefined;
	}
}

export function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let start = 0; start < bytes.length; start += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
	return btoa(binary);
}

export function decodeBase64(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** The raw byte length a base64 string decodes to, without decoding it. */
export function base64Length(text: string): number {
	const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
	return Math.floor((text.length * 3) / 4) - padding;
}

export function fileOutcomeOf(details: unknown): DeviceFileOutcome | undefined {
	if (!isRecord(details) || !isRecord(details.file)) return undefined;
	const file = details.file;
	if (file.ok === true && "value" in file) return { ok: true, value: file.value as JsonValue };
	if (file.ok === false && isDeviceFileErrorCode(file.code) && typeof file.message === "string")
		return { ok: false, code: file.code, message: file.message };
	return undefined;
}
