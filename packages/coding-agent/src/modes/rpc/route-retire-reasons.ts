/**
 * RULING-119 (#5274): the engine never retires a delivering route silently. Every retire is either the direct result
 * of a client action whose reply the client sees, or announced to that client by a typed record before the route stops
 * delivering. Each reason a route retires for is classified here; `RecoveryCheckpoints.retireRoute` takes one, so a new
 * retire site cannot compile without choosing which kind it is.
 */
export const ROUTE_RETIRE_REASONS = {
	/** A completed re-open of the session by the same socket (RULING-117): the new open's reply. */
	reopen_superseded: "client_action",
	/** `close_session`, `release_attachment`, `reclaim_session` or `detach_connection` (RULING-118): its reply. */
	client_detach: "client_action",
	/** `unsubscribe_sessions`, or the mirror's own subscribe cancelled or refused before its first delivery. */
	mirror_unsubscribed: "client_action",
	/** An accepted open that ends without completing (cancelled, refused, failed): its own tagged final reply. */
	open_ended: "announced",
} as const satisfies Readonly<Record<string, "client_action" | "announced">>;

export type RouteRetireReason = keyof typeof ROUTE_RETIRE_REASONS;

/** The reasons whose retire is the client's own action: passed to `retireRoute` as they are. */
export type ClientActionRetire = {
	[R in RouteRetireReason]: (typeof ROUTE_RETIRE_REASONS)[R] extends "client_action" ? R : never;
}[RouteRetireReason];

/** The reasons an engine-side end retires for: they reach `retireRoute` only as a `RouteAnnouncement`. */
export type AnnouncedRetire = Exclude<RouteRetireReason, ClientActionRetire>;

/** Proof that the typed record ending an admission was enqueued; only `RouteAnnouncement.emit` makes one. */
export class RouteAnnouncement {
	readonly reason: AnnouncedRetire;

	private constructor(reason: AnnouncedRetire) {
		this.reason = reason;
	}

	/** Enqueues the typed end record first, then returns the proof the retire needs. */
	static emit(reason: AnnouncedRetire, emit: () => void): RouteAnnouncement {
		emit();
		return new RouteAnnouncement(reason);
	}
}

export type RouteRetirement = ClientActionRetire | RouteAnnouncement;
