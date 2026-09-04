/**
 * The terminal manifest's read side and restore orchestrator: the strict fail-closed
 * parse every persisted manifest must survive, plus `restoreTerminalState`, which
 * replays the manifest after a restart. Each monitor is classified by its durability
 * class and handed to that class's handler; ephemeral monitors and background sessions
 * are always lost, and an expired watch never reaches its handler. Both durable
 * handler slots ship as stubs reporting `lost` — later phases plug the real ones in.
 */

import { InvalidSidecarStoreError, type SidecarStore, type SidecarStoreRef } from "../../../session-sidecar-store.ts";
import {
	type ManifestBackgroundSession,
	type ManifestMonitor,
	TERMINAL_MANIFEST_VERSION,
	type TerminalManifest,
	type TerminalManifestCheckpoint,
} from "./terminal-manifest.ts";

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
		wakeCount: num(entry, "wakeCount"),
		fireWindow: fireWindow(entry.fireWindow),
	};
}

function parseBackgroundSession(entry: unknown): ManifestBackgroundSession {
	if (!isObj(entry)) invalid("a background session entry must be an object");
	return { id: str(entry, "id"), command: str(entry, "command"), startedAtMs: num(entry, "startedAtMs") };
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

export type RestoreOutcome = "restored" | "lost" | "muted" | "attachedElsewhere";

export interface RestoreHandlerResult {
	readonly outcome: RestoreOutcome;
	/** Why a durable monitor could not be restored; diagnostic only, never part of the digest counts. */
	readonly reason?: string;
}

export type RestoreHandler = (monitor: ManifestMonitor) => RestoreHandlerResult | Promise<RestoreHandlerResult>;

export interface RestoreHandlers {
	readonly "restartable-command": RestoreHandler;
	readonly "checkpointed-file": RestoreHandler;
}

/** The registry surface a restore handler needs to re-apply a persisted mute. */
export interface PersistedMuteRegistry {
	pause(ids: readonly string[]): string[];
}

/**
 * Re-apply a persisted `deliveryPaused` mute to a freshly restored monitor and report the
 * outcome it contributes to the digest. The mute MUST be applied by the FRESH runtime id
 * (bash_N/watch_N) the restore just allocated: `MonitorRegistry.pause` resolves records by
 * runtime id only, so passing the persisted `mon_` id silently no-ops and the mute is lost.
 */
export function reapplyPersistedMute(
	registry: PersistedMuteRegistry,
	monitor: Pick<ManifestMonitor, "deliveryPaused">,
	runtimeId: string,
): RestoreOutcome {
	if (!monitor.deliveryPaused) return "restored";
	registry.pause([runtimeId]);
	return "muted";
}

/** Stub durability handlers: every durable monitor is reported lost until later phases land. */
export const stubRestoreHandlers: RestoreHandlers = {
	"restartable-command": () => ({ outcome: "lost" }),
	"checkpointed-file": () => ({ outcome: "lost" }),
};

export interface RestoreDigest {
	restored: number;
	lost: number;
	expired: number;
	muted: number;
	attachedElsewhere: number;
	storeError: boolean;
}

export interface RestoreTerminalStateOptions {
	readonly manifest: SidecarStore<TerminalManifest>;
	readonly handlers?: Partial<RestoreHandlers>;
	readonly now?: () => number;
}

export async function restoreTerminalState(options: RestoreTerminalStateOptions): Promise<RestoreDigest> {
	const digest: RestoreDigest = {
		restored: 0,
		lost: 0,
		expired: 0,
		muted: 0,
		attachedElsewhere: 0,
		storeError: false,
	};
	let state: TerminalManifest | null;
	try {
		state = await options.manifest.read();
	} catch {
		// Fail closed: a corrupt or foreign manifest restores nothing and reports the store error.
		return { ...digest, storeError: true };
	}
	if (state === null) return digest;
	const now = (options.now ?? Date.now)();
	const handlers: RestoreHandlers = { ...stubRestoreHandlers, ...options.handlers };
	for (const monitor of state.monitors) {
		// At the deadline the entry is already expired: the handler must not see it at all.
		if (monitor.expiresAt !== null && monitor.expiresAt <= now) {
			digest.expired += 1;
			continue;
		}
		if (monitor.durabilityClass === "ephemeral") {
			digest.lost += 1;
			continue;
		}
		const outcome = (await handlers[monitor.durabilityClass](monitor)).outcome;
		digest[outcome] += 1;
	}
	// Background sessions carry no durable identity: every one of them is lost.
	digest.lost += state.backgroundSessions.length;
	return digest;
}
