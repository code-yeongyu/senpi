import type { BoundedId, ContentDigest, ContentRef } from "./compact-recovery-ids.ts";
import type { RecoveryRouteKind } from "./compact-recovery-types.ts";

/** A manifest string: inline when it is a bounded protocol id, otherwise a ref to its exact stored value. */
export type ManifestText =
	| { readonly id: BoundedId }
	| { readonly ref: ContentRef; readonly length: number; readonly digest: ContentDigest };

/**
 * The compact-v1 manifest (R4.B1): bounded scalar identity of one frozen checkpoint and the root of its catalog;
 * never the checkpoint or a list of its components. Every id is generated and bounded; a session id or transcript
 * id a user chose becomes a ref (RULING-57 Q2 (2)) and reads back exactly through the catalog.
 */
export interface RecoveryManifest {
	readonly format: "senpi-recovery-manifest";
	readonly version: 1;
	readonly socketEpoch: ManifestText;
	readonly admissionId: ManifestText;
	readonly routeKind: RecoveryRouteKind;
	readonly session: ManifestText;
	readonly sessionEpoch: ManifestText;
	readonly generation: number;
	readonly sequence: number;
	readonly historyVersion: number;
	readonly token: ManifestText;
	readonly leaf: ManifestText | null;
	readonly activeMessage: ManifestText | null;
	readonly turn: ManifestText | null;
	readonly checkpointDigest: ContentDigest;
	readonly catalogRoot: ContentRef;
	readonly catalogRootLength: number;
}

export const TEXT_FIELDS = [
	"socketEpoch",
	"admissionId",
	"session",
	"sessionEpoch",
	"token",
	"leaf",
	"activeMessage",
	"turn",
] as const;
export type TextField = (typeof TEXT_FIELDS)[number];
