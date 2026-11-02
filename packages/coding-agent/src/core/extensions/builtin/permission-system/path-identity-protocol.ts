import type { MountSnapshot } from "./mount-table.ts";
import type { CanonicalPath, CanonicalRule } from "./path-identity.ts";

export type ResolverRequest =
	| { readonly id: number; readonly kind: "canonicalize"; readonly path: string; readonly cwd?: string }
	| { readonly id: number; readonly kind: "canonicalizeRule"; readonly pattern: string; readonly cwd?: string }
	| { readonly id: number; readonly kind: "detect"; readonly path: string }
	| { readonly id: number; readonly kind: "walk"; readonly path: string }
	| { readonly id: number; readonly kind: "refresh" };

export type ResolverValue = CanonicalPath | CanonicalRule | undefined | boolean | string;

export type ResolverReply =
	| { readonly id: number; readonly ok: true; readonly value: ResolverValue }
	| { readonly id: number; readonly ok: false; readonly code: string };

export interface ResolverSnapshotMessage {
	readonly type: "snapshot";
	readonly snapshot: MountSnapshot;
	readonly firmlinks: readonly string[];
}

export type ResolverWorkerMessage = ResolverReply | ResolverSnapshotMessage;
