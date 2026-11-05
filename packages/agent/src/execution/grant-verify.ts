/**
 * A hand's offline check of the sender's capability grant (brain/hand split S27b; relay decision 0009, R14): before
 * anything of a call runs, the hand verifies that the link's authenticated peer holds `execute` toward this hand for
 * the workspace the call's root lies in, from a local snapshot of the verified roster. Nothing is contacted per call.
 *
 * The embedder (the device service) verifies the signed roster, installs snapshots with a non-decreasing `rv` and, during
 * the v1 dual-serve, derives the rows by 0009's role backfill. It also owns the peer binding: one executor per
 * authenticated-sender link, no other sender's frames routed into it, and a carrier re-attach only for the same sender.
 */

/** The capability a hand requires: a tool call is the shell/files/process effect 0014 and 0016 define as `execute`. */
export const HAND_CAPABILITY = "execute";

/** The workspace label of a configured root that names none (0009's default workspace). */
export const DEFAULT_WORKSPACE = "omo";

/** One 0009 grant row: `holder` may do `capability` on `target` in `workspace`. Exact; no capability implies another. */
export interface GrantRow {
	readonly holder: string;
	readonly target: string;
	readonly workspace: string;
	readonly capability: string;
}

/** A verified roster's grants as the hand holds them. `expiresAt` is the roster's `exp_ms`. */
export interface GrantSnapshot {
	readonly rv: number;
	readonly expiresAt: number;
	readonly grants: readonly GrantRow[];
}

export type GrantRefusal = "grant_missing" | "grant_expired" | "workspace_unknown";

export type GrantVerdict =
	| { readonly ok: true; readonly root: string }
	| { readonly ok: false; readonly reason: GrantRefusal };

export interface WorkspaceRoot {
	readonly root: string;
	readonly label?: string;
}

export interface GrantVerifierOptions {
	/** This hand's device ID: the target of every grant it accepts. */
	readonly self: string;
	/** The roots this hand serves; a call's root must lie inside one of them. */
	readonly workspaces: readonly WorkspaceRoot[];
	/** The canonical form of an existing path (the real path); throws for a path that does not exist or cannot be read. */
	readonly canonicalize: (path: string) => string;
	readonly now?: () => number;
}

export interface GrantVerifier {
	/** Reads one snapshot; never what the session says about itself (R16). */
	verify(peer: string, scopeRoot: string): GrantVerdict;
	/** Replaces the snapshot. A lower `rv` than the installed one is ignored (rollback); a non-finite `rv` or `expiresAt` throws. */
	install(snapshot: GrantSnapshot): void;
	/** Called after every replacement, so running calls can be re-verified. Returns the unsubscribe. */
	onReplace(listener: () => void): () => void;
}

/**
 * Whose calls an executor runs: its own device's (`self`: fused and split-local, no grant needed, 0009) or one
 * authenticated peer's, every call checked by `verifier`. Required, so a peer link without a verifier cannot be built.
 */
export type HandAuthority =
	| { readonly kind: "self" }
	| { readonly kind: "peer"; readonly peer: string; readonly verifier: GrantVerifier };

/** The root a call may open its scope on, or why it is refused; a self link keeps the call's root as given. */
export function authorize(authority: HandAuthority, scopeRoot: string): GrantVerdict {
	return authority.kind === "self"
		? { ok: true, root: scopeRoot }
		: authority.verifier.verify(authority.peer, scopeRoot);
}

const SEPARATORS = /[\\/]+$/;

/** `child` is `root` or lies under it, compared by whole path components (`/ws` never contains `/ws2`). */
function contains(root: string, child: string): boolean {
	const base = root.replace(SEPARATORS, "");
	if (child === base) return true;
	if (!child.startsWith(base)) return false;
	const next = child.charAt(base.length);
	return next === "/" || next === "\\";
}

export function createGrantVerifier(options: GrantVerifierOptions): GrantVerifier {
	const { self, canonicalize } = options;
	const now = options.now ?? Date.now;
	const listeners = new Set<() => void>();
	let snapshot: GrantSnapshot | undefined;

	const canonical = (path: string): string | undefined => {
		try {
			return canonicalize(path);
		} catch {
			return undefined;
		}
	};

	const workspaceOf = (root: string): string | undefined => {
		let best: { readonly label: string; readonly length: number } | undefined;
		for (const workspace of options.workspaces) {
			const resolved = canonical(workspace.root);
			if (resolved === undefined || !contains(resolved, root)) continue;
			if (best === undefined || resolved.length > best.length)
				best = { label: workspace.label ?? DEFAULT_WORKSPACE, length: resolved.length };
		}
		return best?.label;
	};

	return {
		verify(peer, scopeRoot) {
			const root = canonical(scopeRoot);
			const workspace = root === undefined ? undefined : workspaceOf(root);
			if (root === undefined || workspace === undefined) return { ok: false, reason: "workspace_unknown" };
			if (peer === self) return { ok: true, root };
			const current = snapshot;
			if (current === undefined || now() >= current.expiresAt) return { ok: false, reason: "grant_expired" };
			const granted = current.grants.some(
				(row) =>
					row.holder === peer &&
					row.target === self &&
					row.workspace === workspace &&
					row.capability === HAND_CAPABILITY,
			);
			return granted ? { ok: true, root } : { ok: false, reason: "grant_missing" };
		},
		install(next) {
			if (!Number.isFinite(next.rv) || !Number.isFinite(next.expiresAt))
				throw new Error("A grant snapshot needs a finite rv and expiresAt; the installed snapshot is kept");
			if (snapshot !== undefined && next.rv < snapshot.rv) return;
			snapshot = next;
			for (const listener of [...listeners]) listener();
		},
		onReplace(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
