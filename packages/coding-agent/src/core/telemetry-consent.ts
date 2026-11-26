/**
 * The one place a session's caller-attributed telemetry is decided (senpi#7446).
 *
 * Effective permission = the host permits AND every caller of the session permits explicitly. A caller grant
 * never overrides a host opt-out, an unanswered or declined caller never exports, and one session's callers
 * never decide for another session of the same host process. Every gate (provider attribution, the extension
 * context, a worker session) reads this module; none keeps its own copy of the rule.
 */

/** A caller's answer. `unanswered` is an answer too: it is what an older peer that sends nothing gets. */
export type TelemetryConsent = "granted" | "declined" | "unanswered";

export const TELEMETRY_CONSENTS: readonly TelemetryConsent[] = ["granted", "declined", "unanswered"];

/** The wire field a caller answers with on `open_session` and `attach_session`. */
export interface TelemetryDeclaration {
	readonly consent: TelemetryConsent;
}

export function isTelemetryConsent(value: unknown): value is TelemetryConsent {
	return value === "granted" || value === "declined" || value === "unanswered";
}

/** The decision itself, at collection and again at delivery: the host's setting AND the callers' verdict for that use. */
export function telemetryPermitted(hostPermits: boolean, callersPermit: boolean): boolean {
	return hostPermits && callersPermit;
}

/**
 * What a session's callers permit, per use. `events` (telemetry events) needs every caller's explicit grant: an
 * unknown answer is never promoted. `attribution` (provider attribution headers, app identity only and no user data)
 * keeps the host's rule for an unanswered caller and is removed by an explicit decline or revoke from any caller.
 */
export interface TelemetryCallersVerdict {
	readonly events: boolean;
	readonly attribution: boolean;
}

/** A classic launch: no caller but the host, so the host's setting alone decides both uses. */
export const HOST_ONLY_VERDICT: TelemetryCallersVerdict = Object.freeze({ events: true, attribution: true });

/**
 * Who a session's standing answer belongs to: the host process itself (a classic launch, whose own settings are
 * the caller's), or the caller that opened the session over the wire.
 */
export type TelemetryStanding = "host" | TelemetryConsent;

/**
 * The callers of one session. `standing` is the answer the session keeps with no caller attached (a retained
 * session keeps running after its opener leaves); every attached connection adds its own live answer.
 *
 * An attach only adds the caller's live answer, which leaves with it. On a session a caller opened, the open and
 * every deliberate change (`set_telemetry_consent`) also become the standing answer, so a revocation outlives the
 * connection that sent it, and a caller that merely attaches and leaves changes nothing after it is gone. A
 * host-owned session's standing answer is always the host's own policy.
 */
export class SessionTelemetryCallers {
	private standing: TelemetryStanding;
	private readonly live = new Map<string, TelemetryConsent>();

	constructor(standing: TelemetryStanding) {
		this.standing = standing;
	}

	/** A connection attached with this answer; it counts only while the connection stays attached. */
	attach(connection: string, consent: TelemetryConsent): void {
		this.live.set(connection, consent);
	}

	/** A connection opened the session or changed its answer on purpose: it is live and it is what the session keeps. */
	answer(connection: string, consent: TelemetryConsent): void {
		this.live.set(connection, consent);
		if (this.standing !== "host") this.standing = consent;
	}

	/** An independent copy: a change is applied to it and kept only once the session confirmed the result. */
	copy(): SessionTelemetryCallers {
		const copy = new SessionTelemetryCallers(this.standing);
		for (const [connection, consent] of this.live) copy.live.set(connection, consent);
		return copy;
	}

	/** A connection stopped being attached; its live answer goes with it, the standing one stays. */
	leave(connection: string): void {
		this.live.delete(connection);
	}

	/** The answer a restart or a handover reopens this session with; absent for a host-owned session. */
	standingConsent(): TelemetryConsent | undefined {
		return this.standing === "host" ? undefined : this.standing;
	}

	/** Both uses, from the same answers: the only place unanswered and declined are told apart. */
	verdict(): TelemetryCallersVerdict {
		const answers = [...this.live.values(), ...(this.standing === "host" ? [] : [this.standing])];
		return {
			events: answers.every((consent) => consent === "granted"),
			attribution: answers.every((consent) => consent !== "declined"),
		};
	}
}

/** The verdict a session starts with, before any connection is attached: its opener's answer alone. */
export function openingCallersVerdict(openerConsent: TelemetryConsent | undefined): TelemetryCallersVerdict {
	return new SessionTelemetryCallers(openerConsent ?? "host").verdict();
}
