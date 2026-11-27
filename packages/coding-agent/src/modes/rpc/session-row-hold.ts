import type { SessionHold } from "../../core/engine-turn-hold.ts";

export const SESSION_ROW_HOLD_KEYS = {
	session_hold: ["interrupted-run", "session_hold"],
	inherited_hold: ["inherited_hold"],
	unattended: ["unattended", "closing", "host-drain"],
	run_fence: [],
} as const satisfies Record<SessionHold["kind"], readonly string[]>;

type PublicKind = Exclude<keyof typeof SESSION_ROW_HOLD_KEYS, "run_fence">;
export interface SessionRowHold {
	readonly kind: PublicKind;
	readonly key: (typeof SESSION_ROW_HOLD_KEYS)[PublicKind][number] | "other";
	readonly since?: string;
	readonly queueDepth: number;
}

/** A run fence alone does not pause the session. Report the hold a peer cannot release first. */
export function sessionRowHold(holds: readonly SessionHold[], pending: () => number): SessionRowHold | undefined {
	const hold =
		holds.find(
			({ kind, key }) => kind === "inherited_hold" || (kind === "session_hold" && key !== "interrupted-run"),
		) ??
		holds.find(({ kind }) => kind === "session_hold") ??
		holds.find(({ kind }) => kind === "unattended");
	if (!hold || hold.kind === "run_fence") return undefined;
	const { kind, key, since } = hold;
	const family =
		kind === "session_hold" && typeof key === "string" && /^session_hold:[0-9]{1,16}$/.test(key)
			? "session_hold"
			: key;
	const publicKey = SESSION_ROW_HOLD_KEYS[kind].find((literal) => literal === family);
	const ms = typeof since === "string" && since.length <= 27 ? Date.parse(since) : NaN;
	return {
		kind,
		key: publicKey ?? "other",
		...(Number.isFinite(ms) && new Date(ms).toISOString() === since ? { since } : {}),
		queueDepth: pending(),
	};
}
