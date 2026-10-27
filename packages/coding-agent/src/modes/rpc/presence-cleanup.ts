/**
 * Presence cleanup for sisyphuslabs/omo-desktop-app#4199 (design 4.2a Revision 7 "Presence cleanup", test 24). Windows
 * only; the POSIX unlink-while-holding variant is the design's conditional contract.
 *
 * Every deletion is made by a process that holds the object at that moment, and only after the database no longer
 * needs it. Holding, on Windows, is an exclusive open (`DELETE` access, share mode 0) through the bridge: presence guards
 * and probes never grant delete sharing, so that open fails with a sharing violation while any other handle on the
 * object exists, and the object is then left for the sweep. Deletion is delete-on-close set through the held handle.
 *
 * - A holder deletes its own object after its `released` commit and after closing its guard (`deletePresenceObject`).
 * - Recovery deletes a retired generation's objects the same way, after releasing its recovered guards.
 * - The sweep (`sweepPresenceObjects`) runs only inside an invocation that already holds the endpoint lock, handles at
 *   most `PRESENCE_SWEEP_BOUND` objects per run, considers an object only when the row naming it is `released` or
 *   retired, or when no row names it and its header is older than `PRESENCE_SWEEP_AGE_MS`, takes the exclusive hold,
 *   rechecks the row in a short state transaction while holding, compares the held object's identity and header with
 *   the row's, and deletes. A held object is skipped, and so is one whose identity is not the recorded one. The age
 *   covers only the window between creating an object and committing its offer; it is never evidence about a process.
 *   A hold is released on every path, a thrown store error included; the sweep's outcome never decides a start.
 *
 * Nothing here renames, truncates, replaces or recreates an object, and nothing deletes by path.
 */
import { randomUUID } from "node:crypto";
import {
	EndpointReservationError,
	type EndpointReservationStore,
	type PresenceObjectDispositionRow,
	type PresenceObjectRecord,
	presenceObjectPath,
	type PresenceRootRecord,
} from "./endpoint-reservation-store.ts";
import type {
	NativePresenceHoldRelease,
	NativePresencePlacementBinding,
	PresencePlacementLoad,
} from "./socket-secret-native.ts";

/** How many objects one sweep run holds; the rest wait for the next endpoint-locked invocation. */
export const PRESENCE_SWEEP_BOUND = 32;
/** The liveness filter for an object no row references: the window between its creation and its offer's commit. */
export const PRESENCE_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

export type PresenceDeletion =
	| { readonly status: "deleted" }
	| {
			readonly status: "left";
			readonly reason:
				| "busy"
				| "missing"
				| "identity_mismatch"
				| "presence_unavailable"
				| "native_unavailable"
				| "failed";
			readonly detail: string | null;
	  };

/** One exclusive hold, open until released with or without deletion. */
interface ExclusiveHold {
	readonly volumeSerial: string;
	readonly fileId: string;
	readonly header: Buffer;
	release(deleteObject: boolean): NativePresenceHoldRelease;
}

type HoldAttempt =
	| { readonly status: "held"; readonly hold: ExclusiveHold }
	| { readonly status: "busy" | "missing" | "failed"; readonly detail: string | null };

function failure(step: string | null | undefined, code: number | null | undefined): string {
	return `${step ?? "unknown"}:${code ?? 0}`;
}

function takeHold(native: NativePresencePlacementBinding, path: string): HoldAttempt {
	const holdId = randomUUID();
	const held = native.presenceObjectHold({ holdId, path });
	if (held.status === "busy" || held.status === "missing") return { status: held.status, detail: null };
	if (held.status !== "held" || !held.volumeSerial || !held.fileId || !held.header) {
		if (held.status === "held") native.presenceObjectRelease(holdId, false);
		return {
			status: "failed",
			detail: held.status === "unavailable" ? (held.reason ?? "unavailable") : failure(held.step, held.code),
		};
	}
	return {
		status: "held",
		hold: {
			volumeSerial: held.volumeSerial,
			fileId: held.fileId,
			header: held.header,
			release: (deleteObject) => native.presenceObjectRelease(holdId, deleteObject),
		},
	};
}

function isRecorded(
	hold: ExclusiveHold,
	recorded: { readonly volumeSerial: string; readonly fileId: string; readonly header: string },
): boolean {
	return (
		hold.volumeSerial === recorded.volumeSerial &&
		hold.fileId === recorded.fileId &&
		hold.header.equals(Buffer.from(recorded.header, "hex"))
	);
}

/**
 * Deletes one recorded presence object the database no longer needs: an exclusive hold, the recorded identity and tag
 * checked through it, then delete-on-close. The caller has committed `released` (or retirement) and closed its own
 * guard first. Anything but a clean deletion leaves the object for the sweep, typed.
 */
export function deletePresenceObject(object: PresenceObjectRecord, native: PresencePlacementLoad): PresenceDeletion {
	if (object.status !== "predeclared") return { status: "left", reason: "presence_unavailable", detail: null };
	if (native.status !== "available") return { status: "left", reason: "native_unavailable", detail: native.reason };
	const attempt = takeHold(native.native, object.path);
	if (attempt.status !== "held") return { status: "left", reason: attempt.status, detail: attempt.detail };
	if (!isRecorded(attempt.hold, object)) {
		attempt.hold.release(false);
		return { status: "left", reason: "identity_mismatch", detail: null };
	}
	// (identity and header compared through the hold above)
	const released = attempt.hold.release(true);
	return released.status === "deleted"
		? { status: "deleted" }
		: { status: "left", reason: "failed", detail: failure(released.step, released.code) };
}

export type PresenceObjectState = "present" | "missing" | "busy" | "unknown";

/**
 * What an issuer finds once its offer committed (design: "If an issuer's creation stalls past the age filter and the
 * object is missing after it commits the offer, it cancels that offer before any spawn"): `present` (the recorded
 * object, opened exclusively and released again), `missing` (gone or replaced), `busy` (another handle holds it
 * exclusively, which only a sweep about to decide its fate does: the issuer cannot know whether the object survives,
 * so busy is never read as "exists and fine" where a spawn is decided), or `unknown` (an open the bridge could not
 * make for another reason; the participant's own acquisition then fails closed). A row without presence is `present`.
 */
export function presenceObjectState(object: PresenceObjectRecord, native: PresencePlacementLoad): PresenceObjectState {
	if (object.status !== "predeclared" || native.status !== "available") return "present";
	const attempt = takeHold(native.native, object.path);
	if (attempt.status === "missing") return "missing";
	if (attempt.status === "busy") return "busy";
	if (attempt.status !== "held") return "unknown";
	const recorded = isRecorded(attempt.hold, object);
	attempt.hold.release(false);
	return recorded ? "present" : "missing";
}

export type PresenceSweepSkip =
	| "held"
	| "referenced"
	| "young"
	| "unreadable"
	| "missing"
	| "failed"
	| "store_busy"
	| "identity_mismatch";

export type PresenceSweepReport =
	| {
			readonly status: "swept";
			/** Object names deleted, in the order they were handled. */
			readonly deleted: readonly string[];
			readonly skipped: readonly { readonly name: string; readonly reason: PresenceSweepSkip }[];
			/** The bound stopped the run before every candidate was handled. */
			readonly bounded: boolean;
	  }
	| {
			readonly status: "skipped";
			readonly reason: "presence_unavailable" | "native_unavailable" | "root_unreadable";
			readonly detail: string | null;
	  };

export interface PresenceSweepOptions {
	readonly bound?: number;
	readonly ageMs?: number;
	readonly now?: () => number;
}

const OBJECT_NAME = /^([0-9a-f]{32})\.presence$/;

/** The creation time of an object's immutable header, or `undefined` when the content is not a presence header. */
function headerCreatedAt(header: Buffer): number | undefined {
	try {
		const value: unknown = JSON.parse(header.toString("utf8"));
		if (typeof value !== "object" || value === null || Reflect.get(value, "kind") !== "senpi-presence")
			return undefined;
		const createdAt = Reflect.get(value, "createdAt");
		return typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The bounded sweep of one presence root. The caller holds the endpoint lock; this is never scheduled on a timer or in
 * the background. Objects are handled in name order. A row the store cannot read (`store_busy`) ends the run.
 */
export function sweepPresenceObjects(
	store: EndpointReservationStore,
	root: PresenceRootRecord,
	native: PresencePlacementLoad,
	options: PresenceSweepOptions = {},
): PresenceSweepReport {
	if (root.status !== "placed") return { status: "skipped", reason: "presence_unavailable", detail: root.reason };
	if (native.status !== "available") return { status: "skipped", reason: "native_unavailable", detail: native.reason };
	const bridge = native.native;
	const listing = bridge.presenceRootList(root.path);
	if (listing.status !== "listed" || !listing.names) {
		return {
			status: "skipped",
			reason: "root_unreadable",
			detail: listing.status === "unavailable" ? (listing.reason ?? null) : failure(listing.step, listing.code),
		};
	}
	const bound = options.bound ?? PRESENCE_SWEEP_BOUND;
	const ageMs = options.ageMs ?? PRESENCE_SWEEP_AGE_MS;
	const now = options.now ?? Date.now;
	const deleted: string[] = [];
	const skipped: { name: string; reason: PresenceSweepSkip }[] = [];
	let handled = 0;
	const disposition = (path: string): PresenceObjectDispositionRow | "store_busy" => {
		try {
			return store.presenceObjectDisposition(path);
		} catch (error: unknown) {
			if (error instanceof EndpointReservationError && error.reason === "store_busy") return "store_busy";
			throw error;
		}
	};
	for (const name of [...listing.names].sort()) {
		const match = OBJECT_NAME.exec(name);
		if (!match) continue;
		if (handled >= bound) return { status: "swept", deleted, skipped, bounded: true };
		const path = presenceObjectPath(root.path, match[1] ?? "");
		const before = disposition(path);
		if (before === "store_busy") {
			skipped.push({ name, reason: "store_busy" });
			return { status: "swept", deleted, skipped, bounded: false };
		}
		if (before.disposition === "referenced") {
			skipped.push({ name, reason: "referenced" });
			continue;
		}
		handled++;
		const attempt = takeHold(bridge, path);
		if (attempt.status !== "held") {
			skipped.push({ name, reason: attempt.status === "busy" ? "held" : attempt.status });
			continue;
		}
		const { hold } = attempt;
		// Whatever happens while the object is held, the hold is released: a thrown store error must not leak it.
		let deleteObject = false;
		try {
			if (before.disposition === "unreferenced") {
				// An object no row names is deleted only once it is older than the age filter: an issuer may still be
				// between creating it and committing the offer that names it.
				const createdAt = headerCreatedAt(hold.header);
				if (createdAt === undefined || !(now() - createdAt > ageMs)) {
					skipped.push({ name, reason: createdAt === undefined ? "unreadable" : "young" });
					continue;
				}
			}
			// The recheck, in a short state transaction, while the object is held.
			const during = disposition(path);
			if (during === "store_busy") {
				skipped.push({ name, reason: "store_busy" });
				return { status: "swept", deleted, skipped, bounded: false };
			}
			if (during.disposition === "referenced") {
				skipped.push({ name, reason: "referenced" });
				continue;
			}
			// A released or retired row is deleted only through a hold on the object it recorded: identity and header are
			// compared through the hold, as the holder's own deletion compares them.
			if (during.recorded !== undefined && !isRecorded(hold, during.recorded)) {
				skipped.push({ name, reason: "identity_mismatch" });
				continue;
			}
			deleteObject = true;
		} finally {
			const released = hold.release(deleteObject);
			if (deleteObject) {
				if (released.status === "deleted") deleted.push(name);
				else skipped.push({ name, reason: "failed" });
			}
		}
	}
	return { status: "swept", deleted, skipped, bounded: false };
}
