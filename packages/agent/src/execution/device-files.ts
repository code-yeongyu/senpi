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
	/** Runs git or lsof on the device (split: only the calls the hand's allowlist admits; fused: a direct spawn). */
	run(request: DeviceRunRequest, options?: DeviceFileOptions): Promise<DeviceRunResult>;
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

export type DeviceFileOp = "read" | "write" | "list" | "stat" | "rename" | "remove" | "mkdir" | "run";
export const DEVICE_FILE_OPS: readonly DeviceFileOp[] = [
	"read",
	"write",
	"list",
	"stat",
	"rename",
	"remove",
	"mkdir",
	"run",
];

/** The `run` operation's name in a hand's `hello` (S40 PR 2): git and lsof as the memory component calls them. */
export const RUN_CHANNEL = "run/1";

export interface DeviceRunRequest {
	readonly exe: string;
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly stdin?: Uint8Array;
	readonly timeoutMs?: number;
	/** Hold the memory component's git-activity lock as fd 3 while git runs; the hand derives the lock from `cwd`. */
	readonly activityLock?: boolean;
}

export interface DeviceRunResult {
	readonly code: number | null;
	readonly signal: string | null;
	readonly stdout: Uint8Array;
	readonly stderr: string;
}

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

function isDeviceFileErrorCode(value: unknown): value is DeviceFileErrorCode {
	return typeof value === "string" && (CODES as readonly string[]).includes(value);
}

/** One operation's arguments, as the hand receives them: paths are strings, written data is base64. */
export type DeviceFileArgs =
	| { readonly op: "read" | "list" | "stat" | "remove" | "mkdir"; readonly path: string }
	| { readonly op: "write"; readonly path: string; readonly data: string; readonly exclusive: boolean }
	| { readonly op: "rename"; readonly path: string; readonly to: string }
	| {
			readonly op: "run";
			readonly path: string;
			readonly exe: string;
			readonly argv: readonly string[];
			readonly env: Readonly<Record<string, string>>;
			readonly stdin?: string;
			readonly timeoutMs?: number;
			readonly activityLock: boolean;
	  };

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
		case "run":
			return decodeRunArgs(path, args);
		default:
			return undefined;
	}
}

function decodeRunArgs(path: string, args: Record<string, unknown>): DeviceFileArgs | undefined {
	const { exe, argv, env, stdin, timeoutMs, activityLock } = args;
	if (typeof exe !== "string" || !Array.isArray(argv) || !argv.every((arg) => typeof arg === "string"))
		return undefined;
	const environment = env ?? {};
	if (!isRecord(environment) || !Object.values(environment).every((value) => typeof value === "string"))
		return undefined;
	if (stdin !== undefined && typeof stdin !== "string") return undefined;
	if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0))
		return undefined;
	if (activityLock !== undefined && typeof activityLock !== "boolean") return undefined;
	return {
		op: "run",
		path,
		exe,
		argv: argv as string[],
		env: environment as Record<string, string>,
		...(stdin === undefined ? {} : { stdin }),
		...(timeoutMs === undefined ? {} : { timeoutMs }),
		activityLock: activityLock === true,
	};
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
