import type { SessionHold } from "../../core/engine-turn-hold.ts";

export interface SessionRowHold extends Pick<SessionHold, "kind" | "key" | "since"> {
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
	return hold && { kind: hold.kind, key: hold.key, since: hold.since, queueDepth: pending() };
}
