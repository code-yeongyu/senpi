/**
 * The engine side of moving a live session to another of the user's computers. The engine knows no other machines:
 * a host that offers relocation (the desktop over RPC) installs a `SessionRelocationHost` on the session, and every
 * answer comes from it. Without one, every call answers `unavailable` and the session keeps working here.
 */

/** One computer the host offers; the agent names it by `name`. Hints are the host's, passed through unchanged. */
export interface RelocationTarget {
	readonly name: string;
	readonly online: boolean;
	/** Free-form capacity hint from the host, for example `"high"` or `"busy"`. */
	readonly capacity?: string;
	/** The host expects this computer to sleep soon. */
	readonly aboutToSleep?: boolean;
}

export interface RelocationRequest {
	readonly target: string;
	readonly reason: string;
}

/** Why no host can be asked: none offers relocation (`not_offered`), or this session cannot be handed over. */
export type RelocationUnavailableReason = "not_offered" | "not_releasable";

export type RelocationUnavailable = {
	readonly status: "unavailable";
	readonly reason: RelocationUnavailableReason;
	readonly detail: string;
};

/** A request that reached no move: the host declined it (its own reason), or the engine did before asking. */
export type RelocationRefused = { readonly status: "refused"; readonly reason: string; readonly detail: string };

export type RelocationTargetsResult =
	| { readonly status: "listed"; readonly targets: readonly RelocationTarget[] }
	| RelocationUnavailable
	| RelocationRefused;

/** `scheduled`: the host accepted; the move starts when the current turn ends, never before. */
export type RelocationRequestResult =
	| { readonly status: "scheduled"; readonly target: string; readonly moveId: string }
	| RelocationUnavailable
	| RelocationRefused;

export interface SessionRelocationHost {
	/** Whether a host offers relocation for this session right now; decides if the agent sees the tools at all. */
	offered(): boolean;
	targets(signal?: AbortSignal): Promise<RelocationTargetsResult>;
	request(request: RelocationRequest, signal?: AbortSignal): Promise<RelocationRequestResult>;
}

export const RELOCATION_NOT_OFFERED: RelocationUnavailable = {
	status: "unavailable",
	reason: "not_offered",
	detail: "no app connected to this session offers moving it to another computer",
};
