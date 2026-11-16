import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	makeUserPrivateDirectory,
	UserDirUnsafeError,
	userPrivateDirectoryPath,
} from "../../../../utils/user-private-dir.ts";
import { redactSensitiveOutput, redactSensitiveTokenValues } from "../../../sensitive-output.ts";

export const DEFAULT_STDOUT_LIMIT_BYTES = 64 * 1024;
export const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024;

export type HookOutputPolicy = {
	readonly maxStdoutBytes?: number;
	readonly maxStderrBytes?: number;
	readonly spillDir?: string;
};

export type HookStreamSafetyMetadata = {
	readonly originalBytes: number;
	readonly returnedBytes: number;
	readonly redacted: boolean;
	readonly spilled: boolean;
	readonly truncated: boolean;
	readonly spillPath?: string;
};

export type HookOutputSafetyMetadata = {
	readonly stdout: HookStreamSafetyMetadata;
	readonly stderr: HookStreamSafetyMetadata;
};

export type HookSafeOutput = {
	readonly text: string;
	readonly safety: HookStreamSafetyMetadata;
};

export function applyHookOutputSafety(
	stream: "stderr" | "stdout",
	text: string,
	policy: HookOutputPolicy | undefined,
	capture?: { readonly originalBytes: number; readonly truncated: boolean },
): HookSafeOutput {
	const originalBytes = capture?.originalBytes ?? Buffer.byteLength(text);
	const redactedText = redactHookOutput(text);
	const redacted = redactedText !== text;
	const limit = stream === "stdout" ? policy?.maxStdoutBytes : policy?.maxStderrBytes;
	const maxBytes = limit ?? (stream === "stdout" ? DEFAULT_STDOUT_LIMIT_BYTES : DEFAULT_STDERR_LIMIT_BYTES);
	const redactedBytes = Buffer.byteLength(redactedText);
	const truncated = capture?.truncated === true || redactedBytes > maxBytes;
	const spillPath = truncated ? spillRedactedOutput(stream, redactedText, policy) : undefined;
	const returnedText = truncated ? Buffer.from(redactedText).subarray(0, maxBytes).toString("utf8") : redactedText;
	return {
		safety: {
			originalBytes,
			redacted,
			returnedBytes: Buffer.byteLength(returnedText),
			spilled: spillPath !== undefined,
			...(spillPath === undefined ? {} : { spillPath }),
			truncated,
		},
		text: returnedText,
	};
}

function redactHookOutput(text: string): string {
	return redactSensitiveOutput(text);
}

const SPILL_DIRECTORY_NAME = "senpi-hook-output";
const fallbackSpillDirectories = new Map<string, string>();

/**
 * This user's own spill directory, never a fixed name every user of the machine shares (senpi#6871). Another user can
 * squat that predictable name, and a sticky `/tmp` keeps this user from removing it; a spill only needs somewhere
 * private, so it then goes to one fresh `mkdtemp` directory (0700, unpredictable name) per process instead of failing
 * every oversized hook (review #2 L1).
 */
function defaultSpillDirectory(): string {
	try {
		return makeUserPrivateDirectory(SPILL_DIRECTORY_NAME);
	} catch (cause) {
		if (!(cause instanceof UserDirUnsafeError)) throw cause;
		const prefix = `${userPrivateDirectoryPath(SPILL_DIRECTORY_NAME)}-`;
		let fallback = fallbackSpillDirectories.get(prefix);
		if (fallback === undefined) {
			fallback = mkdtempSync(prefix);
			fallbackSpillDirectories.set(prefix, fallback);
		}
		return fallback;
	}
}

export function redactHookTokenValues(text: string, replacement = "[REDACTED]"): string {
	return redactSensitiveTokenValues(text, replacement);
}

function spillRedactedOutput(stream: "stderr" | "stdout", text: string, policy: HookOutputPolicy | undefined): string {
	const spillDir = policy?.spillDir ?? defaultSpillDirectory();
	if (policy?.spillDir !== undefined) mkdirSync(spillDir, { recursive: true });
	const path = join(spillDir, `hook-${stream}-${process.pid}-${randomUUID()}.txt`);
	writeFileSync(path, text, { mode: 0o600, flag: "wx" });
	return path;
}
