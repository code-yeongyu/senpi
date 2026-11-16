import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ensurePrivateDirectory,
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
 * private, so it then goes to a fresh `mkdtemp` directory (0700, unpredictable name) instead of failing every oversized
 * hook (review #2 L1).
 */
function defaultSpillDirectory(): string {
	try {
		return makeUserPrivateDirectory(SPILL_DIRECTORY_NAME);
	} catch (cause) {
		if (!(cause instanceof UserDirUnsafeError)) throw cause;
		return fallbackSpillDirectory(`${userPrivateDirectoryPath(SPILL_DIRECTORY_NAME)}-`);
	}
}

/**
 * The process keeps its fallback directory, but proves it on every spill the way the primary path does: a temp cleaner
 * may have removed it under a long-lived host (re-created 0700 in place), and if its name was taken meanwhile it is
 * replaced by a fresh `mkdtemp` directory (senpi#6874 review LOW).
 */
function fallbackSpillDirectory(prefix: string): string {
	const kept = fallbackSpillDirectories.get(prefix);
	if (kept !== undefined) {
		try {
			ensurePrivateDirectory(kept);
			return kept;
		} catch (cause) {
			if (!(cause instanceof UserDirUnsafeError)) throw cause;
		}
	}
	const fresh = mkdtempSync(prefix);
	fallbackSpillDirectories.set(prefix, fresh);
	return fresh;
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
