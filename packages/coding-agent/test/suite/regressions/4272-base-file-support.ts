import { createHash } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { expect } from "vitest";
import type { PersistedBase } from "../../../src/core/session-transcript-journal.ts";
import type { RecoveryManifest } from "../../../src/modes/rpc/compact-recovery-manifest.ts";
import {
	type RecoveryPageAnswer,
	type RecoveryPageOutcome,
	type RecoveryPageRequest,
	RecoveryPageRequests,
} from "../../../src/modes/rpc/compact-recovery-requests.ts";
import type { RecoveryRoute } from "../../../src/modes/rpc/compact-recovery-state.ts";
import type { RecoveryCaller } from "../../../src/modes/rpc/compact-recovery-types.ts";
import { type RecoveryRig, recoveryRig } from "./4272-recovery-support.ts";

/** A session-file line as the test writes it: the three fields a stamped row carries plus any payload. */
export interface BaseEntry {
	readonly type: string;
	readonly id: string;
	readonly parentId?: string | null;
	readonly [payload: string]: unknown;
}

/** The written spec of the base stream (S11c, RULING-70 (1)), restated so no expected byte comes from the producer. */
const FAMILY_OF: Readonly<Record<string, string>> = {
	session: "transcript",
	message: "transcript",
	thinking_level_change: "source",
	configuration_update: "source",
	model_change: "source",
	model_change_rejected: "source",
	usage: "source",
	compaction: "source",
	branch_summary: "source",
	custom: "source",
	custom_message: "source",
	context_edit: "source",
	label: "source",
	session_info: "source",
};

export const stampedRow = (index: number, entry: BaseEntry): string =>
	`${JSON.stringify({
		index,
		id: entry.id,
		source: "file",
		parentId: entry.parentId ?? null,
		kind: entry.type,
		family: FAMILY_OF[entry.type] ?? "opaque",
	})}\n`;

/** The whole stream as the ONE UTF-16LE codec stores it: one stamped row per base entry, in file order. */
export const stampedBytes = (entries: readonly BaseEntry[]): Buffer =>
	Buffer.from(entries.map((entry, index) => stampedRow(index, entry)).join(""), "utf16le");

/** `captureTranscriptBase`'s fingerprint, restated: sha256 over `type NUL id LF` per entry. */
export function fingerprintOf(entries: readonly { readonly type: string; readonly id: string }[]): string {
	const hash = createHash("sha256");
	for (const entry of entries) hash.update(`${entry.type}\u0000${entry.id}\n`);
	return hash.digest("hex");
}

/** RULING-72's content fingerprint, restated: sha256 over its own domain tag, NUL, then each counted line and LF. */
export function contentFingerprintOf(lines: readonly string[]): string {
	const hash = createHash("sha256").update("senpi-recovery-base/1/sha256\u0000");
	for (const line of lines) hash.update(`${line}\n`);
	return hash.digest("hex");
}

/** Writes `entries` as a session file and names it the way a load captures it: identity, count, fingerprints. */
export async function writeBase(path: string, entries: readonly BaseEntry[], raw?: string): Promise<PersistedBase> {
	const lines = entries.map((entry) => JSON.stringify(entry));
	await writeFile(path, raw ?? `${lines.join("\n")}\n`);
	const identity = await stat(path, { bigint: true });
	return {
		fileIdentity: { path, dev: String(identity.dev), ino: String(identity.ino) },
		count: entries.length,
		idFingerprint: fingerprintOf(entries),
		contentFingerprint: contentFingerprintOf(lines),
	};
}

const route = (): RecoveryRoute => ({
	socketEpoch: "socket-1",
	admissionId: "attach-1",
	routeKind: "ordinary",
	peer: "peer",
	sessionId: "s",
});

export function unwrap<T>(outcome: { ok: true; value: T } | { ok: false; failure: unknown }): T {
	if (!outcome.ok) throw new Error(`refused: ${JSON.stringify(outcome.failure)}`);
	return outcome.value;
}

export const refusal = (outcome: RecoveryPageOutcome) => (outcome.ok ? undefined : outcome.failure);

/** A rig whose epoch is bootstrapped on `base` (a loaded session file), frozen once, with its page request owner. */
export async function baseRig(base: PersistedBase, leafId = "e0") {
	const rig: RecoveryRig = recoveryRig();
	rig.lane.bootstrap({
		transcript: [
			{ kind: "replace", base },
			{ kind: "leaf", leafId },
		],
	});
	await rig.lane.idle();
	const caller: RecoveryCaller = { socketEpoch: "socket-1", sessionId: "s" };
	const { token } = unwrap(rig.checkpoints.freeze(route(), rig.lane));
	const manifest: RecoveryManifest = unwrap(await rig.checkpoints.catalog(token, caller));
	const pages = new RecoveryPageRequests(rig.checkpoints);
	const first: RecoveryPageRequest = {
		requestId: "r-0",
		admissionId: token.admission.admissionId,
		token: token.id,
		componentRef: `${manifest.catalogRoot}:base`,
	};
	let serial = 0;
	const request = (fields: Partial<RecoveryPageRequest> = {}) =>
		pages.request(caller, { ...first, requestId: `r-${++serial}`, ...fields });
	/** Every page of the base in cursor order (a test-side join the production path never makes). */
	const stream = async (): Promise<{ answers: RecoveryPageAnswer[]; bytes: Buffer }> => {
		const answers: RecoveryPageAnswer[] = [];
		let cursor: string | null = null;
		do {
			const answer: RecoveryPageAnswer = unwrap(await request(cursor === null ? {} : { cursor }));
			answers.push(answer);
			cursor = answer.cursor;
		} while (cursor !== null);
		expect(answers.at(-1)?.complete).toBe(true);
		return { answers, bytes: Buffer.concat(answers.map((answer) => Buffer.from(answer.bytes, "base64"))) };
	};
	const release = async () => {
		rig.checkpoints.release(token);
		await rig.lane.idle();
		expect(rig.lane.liveRoots).toBe(0);
	};
	return { rig, caller, token, manifest, pages, request, stream, release };
}
