/**
 * The extension-facing contract of a session's control surface: how another session's message is
 * ADMITTED into this one, what the runtime remembers about admissions, and how an extension exposes
 * the session on a control endpoint and is woken to drain its inbox.
 *
 * The delivery authority lives outside the engine (omo's gateway store); the engine owns the two
 * things only it can answer atomically - whether the runtime took a message, and whether its
 * transcript entry is written. Nothing here holds a queue of its own: an admitted delivery sits in
 * the runtime's steering or follow-up queue exactly like a user's queued message.
 */

/** Why a `session_control_wake` fired. */
export type SessionControlWakeReason =
	| "idle"
	| "submission"
	| "draft_cleared"
	| "command"
	| "inbox"
	| "emitted"
	| "continue";

/**
 * Fired on every edge after which an inbox drain may have work: the session went idle, the user
 * submitted or cleared the editor, a `wake` command arrived, the inbox directory changed, an admitted
 * delivery reached the transcript, or the process continued after a stop. Wakes that arrive while a
 * drain runs are coalesced into one more pass; `reasons` lists every edge the pass covers and
 * `reason` is the one a held delivery cares about most.
 */
export interface SessionControlWakeEvent {
	readonly type: "session_control_wake";
	readonly reason: SessionControlWakeReason;
	readonly reasons: readonly SessionControlWakeReason[];
	/** Deliveries a `wake` command named; absent for every other edge. */
	readonly delivery_ids?: readonly string[];
}

export type ExternalDeliverAs = "steer" | "followUp";

/**
 * Who sent a delivery, for the surfaces a human reads: another session (by id, with the name it had
 * when it sent), the command line, or an external chat. The model reads `text`; this is not shown
 * to it.
 */
export type SessionControlSender =
	| { readonly kind: "agent"; readonly session_id: string; readonly name?: string }
	| { readonly kind: "command_line"; readonly user?: string }
	| { readonly kind: "external"; readonly platform: string; readonly author?: string };

export interface AdmitExternalMessageInput {
	readonly delivery_id: string;
	readonly text: string;
	/** Who sent it; a delivery without one renders as a generic remote message. */
	readonly sender?: SessionControlSender;
	/** The message as its sender wrote it, for human surfaces; `text` keeps the provenance the model reads. */
	readonly display_text?: string;
	readonly deliverAs: ExternalDeliverAs;
	/** The `turn_epoch` the sender observed; a steer is admitted only while it is still current. */
	readonly expected_turn_id?: number;
}

/**
 * - `started`   the session was idle: the delivery starts a turn
 * - `queued`    mid-turn follow-up: enqueued once into the runtime's follow-up queue
 * - `steered`   mid-turn steer at the current epoch: enqueued once into the steering queue
 * - `turn_conflict`    the sender's epoch is stale (or a steer named none)
 * - `held_draft`       the user is composing: nothing was enqueued; retry on the next edge
 * - `already_admitted` this runtime already holds or already wrote this `delivery_id`
 */
export type ExternalAdmissionKind =
	| "started"
	| "queued"
	| "steered"
	| "turn_conflict"
	| "held_draft"
	| "already_admitted";

export interface ExternalAdmissionResult {
	readonly kind: ExternalAdmissionKind;
	readonly turn_epoch: number;
}

/** What the user is holding in the composer. A terminal delivers IME text only when it commits, so `ime` is reserved. */
export type AdmissionHoldReason = "draft" | "ime" | "attachment";

/** Read-only admission pre-check: calling it changes nothing. */
export interface SessionAdmissionGate {
	readonly can_admit: boolean;
	readonly hold_reason?: AdmissionHoldReason;
	readonly editor_revision: number;
	readonly turn_epoch: number;
}

/**
 * The process-lifetime admission ledger: `pending` = held by this runtime (either queue, or a
 * started turn whose entry is not written yet), `emitted` = transcript entry written, `failed`
 * (present only when non-empty) = the session file refused the entry: not held, still with its
 * sender, and `already_admitted` until the run that refused it has settled with the file writable.
 */
export interface AdmittedDeliveries {
	readonly pending: readonly string[];
	readonly emitted: readonly string[];
	readonly failed?: readonly FailedDelivery[];
}

/** A delivery whose transcript entry the session file refused, and that write's error message. */
export interface FailedDelivery {
	readonly delivery_id: string;
	readonly error: string;
}

export interface SessionControlAdmission {
	readonly delivery_id: string;
	readonly kind: ExternalAdmissionKind;
}

export interface SessionControlDrainResult {
	readonly admitted?: readonly SessionControlAdmission[];
}

export type SessionControlDrain = (
	event: SessionControlWakeEvent,
) => SessionControlDrainResult | undefined | Promise<SessionControlDrainResult | undefined>;

export interface RegisterControlEndpointOptions {
	/** Directory whose entry creations/deletions wake the drain (`reason: "inbox"`). Created 0700 when missing. */
	readonly inboxDir: string;
	readonly drain: SessionControlDrain;
	/**
	 * Asked once at clean exit: whether anything outside the transcript still names this session.
	 * A session whose file holds only its header is removed exactly when this answers `false`
	 * (or is not supplied); a referenced one keeps its file so its id survives the exit.
	 */
	readonly isSessionReferenced?: () => boolean | Promise<boolean>;
}

export type SessionControlRegistration =
	| { readonly status: "registered"; readonly socket: string; readonly dispose: () => Promise<void> }
	| { readonly status: "unsupported"; readonly reason: "unsupported_platform" | "unsupported_mode" }
	| { readonly status: "failed"; readonly reason: string };

/** `pi.session`: the session control surface. */
export interface SessionControlActions {
	/** POSIX interactive sessions only; anything else answers `unsupported` and registers nothing. */
	registerControlEndpoint(options: RegisterControlEndpointOptions): Promise<SessionControlRegistration>;
	admissionGate(): SessionAdmissionGate;
	admitExternalMessage(input: AdmitExternalMessageInput): ExternalAdmissionResult;
	listAdmittedDeliveries(): AdmittedDeliveries;
	/** Writes the session header now, so the session id is durable before anything exposes it. */
	persistHeaderNow(): Promise<void>;
}

/** `customType` of the transcript entry an admitted delivery becomes. */
export const SESSION_CONTROL_DELIVERY_TYPE = "session_control_delivery";

/** `details` of that entry: the `delivery_id` is the on-disk proof the delivery was applied. */
export interface SessionControlDeliveryDetails {
	readonly delivery_id: string;
	readonly source: "session_control";
	readonly deliverAs: ExternalDeliverAs;
	readonly sender?: SessionControlSender;
	readonly display_text?: string;
}

/** The sender a delivery's `details` names, when it names a well-formed one. */
export function sessionControlSenderOf(details: unknown): SessionControlSender | undefined {
	if (!isSessionControlDeliveryDetails(details) || typeof details.sender !== "object" || details.sender === null)
		return undefined;
	const sender: Record<string, unknown> = { ...details.sender };
	const optional = (key: string) => (typeof sender[key] === "string" ? { [key]: sender[key] as string } : {});
	if (sender.kind === "agent" && typeof sender.session_id === "string") {
		return { kind: "agent", session_id: sender.session_id, ...optional("name") };
	}
	if (sender.kind === "command_line") return { kind: "command_line", ...optional("user") };
	if (sender.kind === "external" && typeof sender.platform === "string") {
		return { kind: "external", platform: sender.platform, ...optional("author") };
	}
	return undefined;
}

/** Whether a custom-message `details` value proves it came through session-control admission. */
export function isSessionControlDeliveryDetails(value: unknown): value is SessionControlDeliveryDetails {
	if (typeof value !== "object" || value === null) return false;
	if (!("delivery_id" in value) || typeof value.delivery_id !== "string") return false;
	if (!("source" in value) || value.source !== "session_control") return false;
	return "deliverAs" in value && (value.deliverAs === "steer" || value.deliverAs === "followUp");
}
