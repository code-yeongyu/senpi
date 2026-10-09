/**
 * The terminal manifest's strict fail-closed parse: every field is checked, unknown keys are
 * ignored (so optional additions never need a version bump), and any malformed value throws
 * InvalidTerminalManifestError so a restore fails closed instead of guessing.
 */

import { InvalidSidecarStoreError, type SidecarStoreRef } from "../../../session-sidecar-store.ts";
import type { ChildProcessIdentity } from "./process-identity.ts";
import {
	type ManifestBackgroundSession,
	type ManifestMonitor,
	TERMINAL_MANIFEST_VERSION,
	type TerminalManifest,
	type TerminalManifestCheckpoint,
} from "./terminal-manifest-model.ts";

export class InvalidTerminalManifestError extends InvalidSidecarStoreError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "InvalidTerminalManifestError";
	}
}

type Raw = Record<string, unknown>;

const RUNTIME_KINDS = ["command", "file"] as const;
const DURABILITY_CLASSES = ["ephemeral", "restartable-command", "checkpointed-file"] as const;
const FILE_EVENTS = ["create", "modify"] as const;
const isStr = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isBool = (value: unknown): value is boolean => typeof value === "boolean";
const isObj = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

function invalid(message: string): never {
	throw new InvalidTerminalManifestError(`terminal manifest is invalid: ${message}`);
}

function str(raw: Raw, field: string): string {
	if (!isStr(raw[field])) invalid(`field ${field} must be a non-empty string`);
	return raw[field];
}

function num(raw: Raw, field: string): number {
	if (!isNum(raw[field])) invalid(`field ${field} must be a finite number`);
	return raw[field];
}

function digest(raw: Raw, field: string): string {
	if (typeof raw[field] !== "string") invalid(`field ${field} must be a string`);
	return raw[field];
}

function bool(raw: Raw, field: string): boolean {
	if (!isBool(raw[field])) invalid(`field ${field} must be a boolean`);
	return raw[field];
}

function opt<T>(raw: Raw, field: string, required: (raw: Raw, field: string) => T): T | undefined {
	return raw[field] === undefined ? undefined : required(raw, field);
}

function oneOf<T extends string>(values: readonly T[], raw: Raw, field: string): T {
	const value = raw[field];
	if (typeof value !== "string" || !values.includes(value as T))
		invalid(`field ${field} must be one of: ${values.join(", ")}`);
	return value as T;
}

function checkpoint(raw: unknown): TerminalManifestCheckpoint {
	if (!isObj(raw)) invalid("field lastCheckpoint must be an object");
	return {
		dev: num(raw, "dev"),
		ino: num(raw, "ino"),
		size: num(raw, "size"),
		mtimeMs: num(raw, "mtimeMs"),
		// A checkpoint without a digest cannot detect a same-size, same-mtime rewrite, so the field is
		// required — but an absent file legitimately checkpoints an empty digest, so "" is valid.
		digest: digest(raw, "digest"),
		present: bool(raw, "present"),
	};
}

function fireWindow(raw: unknown): { startMs: number; count: number } {
	if (!isObj(raw)) invalid("field fireWindow must be an object");
	return { startMs: num(raw, "startMs"), count: num(raw, "count") };
}

function runtimeIdentity(raw: Raw, field: string): ChildProcessIdentity {
	const value = raw[field];
	if (!isObj(value)) invalid(`field ${field} must be an object`);
	const argv = value.argv;
	if (!Array.isArray(argv) || !argv.every(isStr)) invalid(`field ${field}.argv must be an array of strings`);
	const pid = value.pid;
	if (!isNum(pid)) invalid(`field ${field}.pid must be a finite number`);
	const groupId = value.processGroupId;
	if (groupId !== undefined && !isNum(groupId)) invalid(`field ${field}.processGroupId must be a finite number`);
	return {
		pid,
		...(groupId !== undefined ? { processGroupId: groupId } : {}),
		startedAtMs: num(value, "startedAtMs"),
		bootAtMs: num(value, "bootAtMs"),
		argv,
	};
}

function parseMonitor(entry: unknown): ManifestMonitor {
	if (!isObj(entry)) invalid("a monitor entry must be an object");
	return {
		monitorId: str(entry, "monitorId"),
		sessionId: str(entry, "sessionId"),
		description: str(entry, "description"),
		runtimeKind: oneOf(RUNTIME_KINDS, entry, "runtimeKind"),
		durabilityClass: oneOf(DURABILITY_CLASSES, entry, "durabilityClass"),
		command: opt(entry, "command", str),
		path: opt(entry, "path", str),
		event: opt(entry, "event", (raw, field) => oneOf(FILE_EVENTS, raw, field)),
		filter: opt(entry, "filter", str),
		cwd: opt(entry, "cwd", str),
		approvedParent: opt(entry, "approvedParent", str),
		createdAt: num(entry, "createdAt"),
		expiresAt: entry.expiresAt === undefined || entry.expiresAt === null ? null : num(entry, "expiresAt"),
		persistent: bool(entry, "persistent"),
		suspended: bool(entry, "suspended"),
		lastCheckpoint: entry.lastCheckpoint === null ? null : checkpoint(entry.lastCheckpoint),
		deliveryPaused: bool(entry, "deliveryPaused"),
		// Unknown keys are ignored by this field-by-field parse, so a manifest written before
		// `wakeCount` was dropped still reads back cleanly; no version bump is needed. The same
		// rule makes `runtime` / `deadlineMs` optional additions that v1 readers skip.
		fireWindow: fireWindow(entry.fireWindow),
		...(entry.runtime === undefined ? {} : { runtime: runtimeIdentity(entry, "runtime") }),
		...(entry.deadlineMs === undefined ? {} : { deadlineMs: num(entry, "deadlineMs") }),
	};
}

function parseBackgroundSession(entry: unknown): ManifestBackgroundSession {
	if (!isObj(entry)) invalid("a background session entry must be an object");
	return {
		id: str(entry, "id"),
		command: str(entry, "command"),
		startedAtMs: num(entry, "startedAtMs"),
		...(entry.runtime === undefined ? {} : { runtime: runtimeIdentity(entry, "runtime") }),
	};
}

/** Strict fail-closed domain parse; the sidecar store has already checked version and session. */
export function parseTerminalManifest(raw: unknown, ref: SidecarStoreRef): TerminalManifest {
	if (!isObj(raw)) invalid("the payload must be an object");
	if (!Array.isArray(raw.monitors)) invalid("field monitors must be an array");
	if (!Array.isArray(raw.backgroundSessions)) invalid("field backgroundSessions must be an array");
	return {
		version: TERMINAL_MANIFEST_VERSION,
		sessionId: ref.sessionId,
		monitors: raw.monitors.map(parseMonitor),
		backgroundSessions: raw.backgroundSessions.map(parseBackgroundSession),
		updatedAt: num(raw, "updatedAt"),
	};
}
