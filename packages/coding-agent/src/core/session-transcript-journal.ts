import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { parseSessionEntryLine, SESSION_READ_BUFFER_SIZE, SessionLineSplitter } from "./session-entry-file.ts";
import type { FileEntry } from "./session-manager.ts";

/** The file a persisted base was read from. A rewrite through rename, or any other file at that path, differs. */
export interface FileIdentity {
	readonly path: string;
	readonly dev: string;
	readonly ino: string;
}

/** The first `count` entries of a session file as one load or rewrite left them, named without holding them (R3.C1.1). */
export interface PersistedBase {
	readonly fileIdentity: FileIdentity;
	readonly count: number;
	readonly idFingerprint: string;
}

export type TranscriptUnavailableReason =
	| "transition_over_worker_frame_limit"
	| "transcript_file_identity_unavailable"
	| "transcript_tail_trimmed"
	| "transcript_tail_over_byte_limit";

export interface TranscriptPersistence {
	readonly fileIdentity: FileIdentity;
	readonly count: number;
}

/**
 * A committed change that removes, replaces or reinstalls whole messages of the active path, named by entry id
 * (RULING-33 condition 2). Messages are owned JSON, the public message each entry contributes.
 */
export type TranscriptFlow =
	| { readonly kind: "edit"; readonly targetId: string; readonly message: AgentMessage }
	| { readonly kind: "context_edit_removal"; readonly targetId: string }
	| { readonly kind: "compaction"; readonly removedIds: readonly string[] }
	| {
			readonly kind: "branch";
			readonly removedIds: readonly string[];
			readonly installed: readonly { readonly id: string; readonly message: AgentMessage }[];
	  };

/**
 * One committed change of a manager's transcript, recorded after the commit and never before persistence.
 * Entry values are owned JSON: the manager mutates its entry objects later (mirror trimming re-parents them).
 */
export type TranscriptTransition =
	| { readonly kind: "replace"; readonly base: PersistedBase | null }
	| {
			readonly kind: "append";
			readonly id: string;
			readonly entry?: string;
			readonly persistence?: TranscriptPersistence;
			readonly owningMessageId?: string;
			readonly recoveryEpoch?: string;
			readonly flow?: TranscriptFlow;
	  }
	| { readonly kind: "persisted"; readonly persistence: TranscriptPersistence }
	| { readonly kind: "leaf"; readonly leafId: string | null; readonly flow?: TranscriptFlow }
	| { readonly kind: "unavailable"; readonly reason: TranscriptUnavailableReason };

export type PersistedBaseError =
	| "base_file_missing"
	| "base_file_replaced"
	| "base_file_truncated"
	| "base_fingerprint_mismatch";

export type PersistedBaseRead =
	| { readonly ok: true; readonly entries: readonly FileEntry[] }
	| { readonly ok: false; readonly error: PersistedBaseError };

/** The committed transcript changes a consumer has not taken yet; it exists only once a consumer began it. */
export class TranscriptJournal {
	private pending: TranscriptTransition[] = [];

	record(...transitions: TranscriptTransition[]): void {
		this.pending.push(...transitions);
	}

	drain(): TranscriptTransition[] {
		const taken = this.pending;
		this.pending = [];
		return taken;
	}
}

function fingerprint(entries: readonly FileEntry[]): string {
	const hash = createHash("sha256");
	for (const entry of entries) hash.update(`${entry.type}\u0000${entry.id}\n`);
	return hash.digest("hex");
}

/** Describe the loaded/written entries now; the owning descriptor supplies their identity asynchronously. */
export function captureTranscriptBase(entries: readonly FileEntry[]): {
	readonly count: number;
	readonly idFingerprint: string;
	readonly history: number;
} {
	return {
		count: entries.length,
		idFingerprint: fingerprint(entries),
		history: entries.filter((entry) => entry.type !== "session").length,
	};
}

/**
 * Reads `base` through its captured identity only. It stops at `count`, so a legal append after the base is never
 * read, and a replaced, truncated or rewritten file is a typed failure, never a full or current-file read.
 */
export function readPersistedBase(base: PersistedBase, acceptedIds: readonly string[] = []): PersistedBaseRead {
	let fd: number;
	try {
		fd = openSync(base.fileIdentity.path, "r");
	} catch {
		return { ok: false, error: "base_file_missing" };
	}
	try {
		const stat = fstatSync(fd, { bigint: true });
		if (String(stat.dev) !== base.fileIdentity.dev || String(stat.ino) !== base.fileIdentity.ino)
			return { ok: false, error: "base_file_replaced" };
		const entries: FileEntry[] = [];
		const take = (line: string): void => {
			const entry = parseSessionEntryLine(line);
			if (entry && entries.length < base.count + acceptedIds.length) entries.push(entry);
		};
		const splitter = new SessionLineSplitter();
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
		while (entries.length < base.count + acceptedIds.length) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) {
				take(splitter.finish());
				break;
			}
			for (const line of splitter.push(buffer.subarray(0, bytesRead))) take(line);
		}
		if (entries.length < base.count + acceptedIds.length) return { ok: false, error: "base_file_truncated" };
		if (
			fingerprint(entries.slice(0, base.count)) !== base.idFingerprint ||
			acceptedIds.some((id, index) => entries[base.count + index]?.id !== id)
		)
			return { ok: false, error: "base_fingerprint_mismatch" };
		return { ok: true, entries };
	} finally {
		closeSync(fd);
	}
}

/**
 * A manager's whole transcript as transitions: its persisted base, each entry not on that base as its own append,
 * then its leaf. `unpersisted` is undefined when a trimmed mirror no longer holds those entries.
 */
export function snapshotTranscript(state: {
	readonly base: PersistedBase | null;
	readonly unpersisted: readonly FileEntry[] | undefined;
	readonly leafId: string | null;
	readonly own: (entry: FileEntry) => string;
	readonly persistence?: TranscriptPersistence;
}): TranscriptTransition[] {
	if (state.unpersisted === undefined) return [{ kind: "unavailable", reason: "transcript_tail_trimmed" }];
	return [
		{ kind: "replace", base: state.base },
		...state.unpersisted.map((entry): TranscriptTransition => ({
			kind: "append",
			id: entry.id,
			...(state.persistence ? { persistence: state.persistence } : { entry: state.own(entry) }),
		})),
		{ kind: "leaf", leafId: state.leafId },
	];
}
