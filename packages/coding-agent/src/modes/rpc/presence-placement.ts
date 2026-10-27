/**
 * Presence placement for sisyphuslabs/omo-desktop-app#4199 (design 4.2a, Revision 6 "Lifetime object and binding",
 * Revision 7/8 "Placement."). Windows only: elsewhere the natives are typed unavailable and every root is
 * `presence_unavailable` (the POSIX placement is the design's conditional contract).
 *
 * The reserving owner resolves the root ONCE: the private sibling directory `<coordination target>.presence` when the
 * store's directory classifies `local`, otherwise a per-user root under FOLDERID_LocalAppData keyed by the canonical
 * endpoint identity, which must itself classify `local`; failing both, the reservation records `presence_unavailable`
 * and startup goes on. Issuers, participants and probers never re-resolve: they open the RECORDED canonical path and
 * require it to classify `local` and to carry the recorded physical identity. An offer predeclares its role's presence
 * object in that root, created new and flushed before the offer commits. Objects are never renamed, truncated or
 * replaced; cleanup belongs to the Revision 7 cleanup rules, not here.
 */
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { win32 } from "node:path";
import {
	ENDPOINT_RESERVATION_SCHEMA,
	type KernelSessionRecord,
	type PresenceObjectRecord,
	type PresenceRootRecord,
	presenceObjectPath,
	type ReservationPresence,
} from "./endpoint-reservation-store.ts";
import type {
	NativeKernelSessionIdentity,
	NativePresencePlacementBinding,
	NativePresenceRoot,
	PresencePlacementLoad,
} from "./socket-secret-native.ts";

export type PresencePlacementRejection =
	| "presence_root_unverifiable"
	| "presence_root_unreadable"
	| "presence_root_mismatch"
	| "presence_root_not_local"
	| "presence_object_exists"
	| "presence_object_failed"
	| "presence_object_not_local";

/** A typed refusal to use or create presence in the recorded root; `reason` is machine-readable. */
export class PresencePlacementError extends Error {
	readonly code = "presence-placement-rejected";
	readonly reason: PresencePlacementRejection;

	constructor(reason: PresencePlacementRejection, detail: string) {
		super(`presence placement ${reason}: ${detail}`);
		this.name = "PresencePlacementError";
		this.reason = reason;
	}
}

export interface PresenceRootRequest {
	/** The endpoint lock target the reservation store sits beside, without its `.lock` suffix. */
	readonly coordinationTarget: string;
	/** The canonical endpoint identity that keys the per-user root. */
	readonly endpointKey: string;
	readonly native: PresencePlacementLoad;
}

/** A bridge kernel-session read as a record: only a verified read with a value is `verified`. */
export function kernelSession(identity: NativeKernelSessionIdentity): KernelSessionRecord {
	return identity.status === "verified" && identity.creationTime
		? { status: "verified", value: identity.creationTime }
		: { status: "unverified", reason: identity.reason ?? "unverified" };
}

function failure(step: string | null | undefined, code: number | null | undefined): string {
	return `${step ?? "unknown"}:${code ?? 0}`;
}

function openRoot(
	native: NativePresencePlacementBinding,
	path: string,
	placement: "beside_store" | "relocated",
): PresenceRootRecord {
	const opened = native.presenceRootOpen(path, true);
	if (opened.status !== "opened" || !opened.path || !opened.volumeSerial || !opened.fileId) {
		const detail =
			opened.status === "insecure" ? `insecure:${opened.reason ?? ""}` : failure(opened.step, opened.code);
		return { status: "presence_unavailable", reason: "root_unavailable", detail };
	}
	if (opened.locality !== "local") {
		return { status: "presence_unavailable", reason: "root_not_local", detail: opened.reason ?? null };
	}
	return {
		status: "placed",
		placement,
		path: opened.path,
		volumeSerial: opened.volumeSerial,
		fileId: opened.fileId,
		classification: "local",
		fileSystem: opened.reportedFileSystem ?? null,
	};
}

/** The reserving owner's one resolution of its presence root, with its own kernel-session identity. */
export function resolvePresenceRoot(request: PresenceRootRequest): ReservationPresence {
	if (request.native.status !== "available") {
		const { reason } = request.native;
		return {
			root: { status: "presence_unavailable", reason, detail: null },
			ownerKernelSession: { status: "unverified", reason },
		};
	}
	const native = request.native.native;
	const ownerKernelSession = kernelSession(native.kernelSessionIdentity());
	// The store directory is classified from its own opened handle; a classification error is not_local.
	const store = native.classifyVolume(win32.dirname(request.coordinationTarget));
	if (store.locality === "local") {
		return { root: openRoot(native, `${request.coordinationTarget}.presence`, "beside_store"), ownerKernelSession };
	}
	const folder = native.localAppDataPath();
	if (folder.status !== "found" || !folder.path) {
		return {
			root: {
				status: "presence_unavailable",
				reason: "local_app_data_unavailable",
				detail: failure(folder.status, folder.code),
			},
			ownerKernelSession,
		};
	}
	const relocated = win32.join(folder.path, "senpi", "rpc-presence", request.endpointKey);
	return { root: openRoot(native, relocated, "relocated"), ownerKernelSession };
}

function requireNative(native: PresencePlacementLoad, root: string): NativePresencePlacementBinding {
	if (native.status !== "available") {
		throw new PresencePlacementError("presence_root_unverifiable", `${root}: ${native.reason}`);
	}
	return native.native;
}

function checkOpened(root: PresenceRootRecord & { status: "placed" }, opened: NativePresenceRoot): void {
	if (opened.status !== "opened") {
		throw new PresencePlacementError(
			"presence_root_unreadable",
			`${root.path}: ${opened.status === "insecure" ? `insecure ${opened.reason ?? ""}` : failure(opened.step, opened.code)}`,
		);
	}
	if (opened.volumeSerial !== root.volumeSerial || opened.fileId !== root.fileId) {
		throw new PresencePlacementError("presence_root_mismatch", `${root.path} is another physical directory`);
	}
	if (opened.locality !== "local") {
		throw new PresencePlacementError("presence_root_not_local", `${root.path}: ${opened.reason ?? "not_local"}`);
	}
}

/**
 * Opens the RECORDED root, never a re-resolved one, and requires it to classify `local` and to be the recorded physical
 * directory. A root recorded `presence_unavailable` has nothing to verify.
 */
export function verifyRecordedPresenceRoot(root: PresenceRootRecord, native: PresencePlacementLoad): void {
	if (root.status !== "placed") return;
	checkOpened(root, requireNative(native, root.path).presenceRootOpen(root.path, false));
}

/** The object's immutable content: a random tag, the schema and a creation time (a cleanup liveness filter only). */
function presenceHeader(): Buffer {
	const header = {
		kind: "senpi-presence",
		schema: ENDPOINT_RESERVATION_SCHEMA,
		tag: randomBytes(32).toString("hex"),
		createdAt: Date.now(),
	};
	return Buffer.from(`${JSON.stringify(header)}\n`);
}

/**
 * Creates and flushes a new presence object for one role in the recorded root, before the caller commits the offer
 * that names it. The bridge opens the recorded path itself and creates relative to that handle only after the identity
 * and locality checks pass. A root recorded `presence_unavailable` predeclares nothing.
 */
export function predeclarePresenceObject(
	root: PresenceRootRecord,
	native: PresencePlacementLoad,
): PresenceObjectRecord {
	if (root.status !== "placed") return { status: "presence_unavailable" };
	const bridge = requireNative(native, root.path);
	const presenceId = randomBytes(16).toString("hex");
	const header = presenceHeader();
	const created = bridge.presenceObjectCreate({
		rootPath: root.path,
		rootVolumeSerial: root.volumeSerial,
		rootFileId: root.fileId,
		name: `${presenceId}.presence`,
		header,
	});
	switch (created.status) {
		case "created":
			break;
		case "root_mismatch":
			throw new PresencePlacementError("presence_root_mismatch", `${root.path} is another physical directory`);
		case "root_not_local":
			throw new PresencePlacementError("presence_root_not_local", `${root.path}: ${created.reason ?? "not_local"}`);
		case "exists":
			throw new PresencePlacementError("presence_object_exists", `${presenceId} already exists in ${root.path}`);
		case "unavailable":
			throw new PresencePlacementError("presence_root_unverifiable", `${root.path}: ${created.reason ?? ""}`);
		default:
			throw new PresencePlacementError(
				"presence_object_failed",
				`${root.path}: ${created.status === "insecure" ? `insecure ${created.reason ?? ""}` : failure(created.step, created.code)}`,
			);
	}
	if (created.locality !== "local" || !created.volumeSerial || !created.fileId) {
		throw new PresencePlacementError("presence_object_not_local", `${presenceId} in ${root.path}`);
	}
	return {
		status: "predeclared",
		presenceId,
		path: presenceObjectPath(root.path, presenceId),
		header: header.toString("hex"),
		volumeSerial: created.volumeSerial,
		fileId: created.fileId,
		classification: "local",
		fileSystem: created.reportedFileSystem ?? null,
		kernelSession: kernelSession(bridge.kernelSessionIdentity()),
		hostLabel: hostname(),
	};
}
