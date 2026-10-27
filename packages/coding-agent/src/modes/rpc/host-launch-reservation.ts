/**
 * The supervisor and host hops of the wrapper-safe launch (sisyphuslabs/omo-desktop-app#4199, design 4.2a "Wrapper-safe discovery
 * and one-time claim"). The launcher reserves a generation and offers the supervisor role, then forwards only a
 * non-secret locator in argv: the store path, endpoint, generation and role. Whatever process the selected runtime
 * finally becomes opens the store itself, reads its role's nonce there and claims with its own identity. The issuer
 * grants only when the claimed identity equals what it observed through the OS for the process it launched, bound to
 * the credential commitment. Nothing in argv, environment or an inherited channel grants anything.
 *
 * Every offer predeclares its role's presence object in the root the reserving owner recorded, before the offer commits
 * and so before any spawn; a claimant first checks that root is the recorded, still-local physical directory (design
 * 4.2a "Placement.").
 *
 * Acquire before authority; release after quiescence (design 4.2a, Revision 6): the reserving owner holds its own
 * presence object before it persists the reservation, and each participant acquires its predeclared object before the
 * nonce-claim transaction, which revalidates the revision and records the binding. A participant keeps that lock through
 * the grant and everything it then does, and closes it only after its `released` commit; a handle that no committed
 * authority ever used is the only one released early. A row without a local root holds no lock at all.
 */
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { LaunchReservationError, LOCATOR_FLAGS, type StoreLocator } from "./host-lifecycle-launch.ts";
import {
	EndpointReservationError,
	type EndpointReservationStore,
	openEndpointReservationStore,
	type PresenceObjectRecord,
	type ReservationPresence,
	type ReservationRole,
} from "./endpoint-reservation-store.ts";
import { predeclarePresenceObject, verifyRecordedPresenceRoot } from "./presence-placement.ts";
import { loadPresencePlacement, type PresencePlacementLoad } from "./socket-secret-native.ts";

export { LaunchReservationError, parseReservationLocatorArgs, type StoreLocator } from "./host-lifecycle-launch.ts";

/** A process as the OS identifies it: PID and its exact start discriminator. */
export interface LaunchIdentity {
	readonly pid: number;
	readonly processStartTime: string | null;
}

/** Identities are stored as their canonical JSON, so equality is exact on PID and start discriminator. */
function identityKey(identity: LaunchIdentity): string {
	return JSON.stringify({ pid: identity.pid, processStartTime: identity.processStartTime });
}

/**
 * A presence lock this process holds for one actor, or, for a row without a local root, the record that there is none.
 * The native registry keeps the guard; nothing here closes it implicitly.
 */
export interface HeldPresence {
	readonly object: PresenceObjectRecord;
	/**
	 * Closes the guard: only after the actor's `released` commit, or for a handle no authority ever used (design 4.2a:
	 * "Failure or a cancelled/retired offer releases only its own unused handle"). Holds nothing to close without presence.
	 */
	release(): void;
}

/**
 * Opens and acquires a predeclared presence object with one nonblocking attempt. The bridge keeps the guard only when the
 * opened object's content tag, physical identity and locality match the record (admissibility rules 1 and 2), so an
 * acquired object is the predeclared one. Rule 3, the kernel-session match of a relocated object, is recovery evidence:
 * a start never uses that identity (Revision 8 clause (ii)), so an unverified session never blocks one. Busy is
 * `presence_occupied` and proves only occupied authority, never who holds it; every other result is `presence_unknown`.
 */
export function acquirePresence(object: PresenceObjectRecord, native: PresencePlacementLoad): HeldPresence {
	if (object.status !== "predeclared") return { object, release: () => {} };
	if (native.status !== "available") {
		throw new LaunchReservationError("presence_unknown", `${object.presenceId}: ${native.reason}`);
	}
	const bridge = native.native;
	const result = bridge.presenceProbe({
		presenceId: object.presenceId,
		path: object.path,
		tag: Buffer.from(object.header, "hex"),
		volumeSerial: object.volumeSerial,
		fileId: object.fileId,
		createdLocal: object.classification === "local",
		relocated: false,
		kernelSession: null,
	});
	if (result.status === "occupied") throw new LaunchReservationError("presence_occupied", object.presenceId);
	if (result.status !== "acquired") {
		const reason = "reason" in result ? ` ${result.reason}` : "";
		throw new LaunchReservationError("presence_unknown", `${object.presenceId}: ${result.status}${reason}`);
	}
	return {
		object,
		release: () => {
			bridge.presenceReleaseAfterQuiescence({ presenceId: object.presenceId, state: "released" });
		},
	};
}

/** The reserving owner's own presence object, predeclared in the root it resolved and held before anything is persisted. */
export function acquireOwnerPresence(reservation: ReservationPresence, native: PresencePlacementLoad): HeldPresence {
	return acquirePresence(predeclarePresenceObject(reservation.root, native), native);
}

/**
 * The reserving owner's own `released` commit once the generation is terminal for it, then the close of its guard.
 */
export function releaseReservingOwner(
	store: EndpointReservationStore,
	generation: string,
	owner: LaunchIdentity,
	presence: HeldPresence,
): void {
	store.releaseOwner(generation, identityKey(owner));
	presence.release();
}

/**
 * Reserves a generation with the presence root the owner resolved and the owner's held presence object, predeclares the
 * supervisor's presence object in that root, offers the supervisor role and returns the argv that carries the locator.
 * It takes over `ownerPresence`: a reservation that is not persisted releases that unused handle, and a predeclaration
 * that fails fences the generation, commits the owner's `released` and only then releases it.
 */
export function offerSupervisorLaunch(
	store: EndpointReservationStore,
	endpoint: string,
	owner: LaunchIdentity,
	presence: {
		readonly reservation: ReservationPresence;
		readonly native: PresencePlacementLoad;
		readonly ownerPresence: HeldPresence;
	},
): { generation: string; args: readonly string[] } {
	let generation: string;
	try {
		generation = store.reserve(
			endpoint,
			identityKey(owner),
			["supervisor", "host"],
			presence.reservation,
			presence.ownerPresence.object,
		);
	} catch (error: unknown) {
		presence.ownerPresence.release();
		throw error;
	}
	try {
		store.offer(
			generation,
			"supervisor",
			identityKey(owner),
			predeclarePresenceObject(presence.reservation.root, presence.native),
		);
	} catch (error: unknown) {
		store.cancel(generation);
		releaseReservingOwner(store, generation, owner, presence.ownerPresence);
		throw error;
	}
	return {
		generation,
		args: [
			LOCATOR_FLAGS.storePath,
			store.path,
			LOCATOR_FLAGS.endpoint,
			endpoint,
			LOCATOR_FLAGS.generation,
			generation,
			LOCATOR_FLAGS.role,
			"supervisor",
		],
	};
}

/**
 * The issuer's offer of the host role in an existing generation: it predeclares the host's presence object in the
 * RECORDED root, never a re-resolved one, then commits the offer.
 */
export function offerHostRole(
	store: EndpointReservationStore,
	generation: string,
	issuer: LaunchIdentity,
	native: PresencePlacementLoad = loadPresencePlacement(),
): void {
	const { root } = store.reservation(generation).presence;
	store.offer(generation, "host", identityKey(issuer), predeclarePresenceObject(root, native));
}

/**
 * The claimant opens the store named by the locator, checks that the recorded presence root is the same still-local
 * physical directory from where it runs, reads its nonce there, acquires its role's predeclared presence object BEFORE
 * the nonce-claim transaction, and claims with its own identity bound to that object at the revision it read first. A
 * different physical directory (another profile, packaged-app virtualization) or a busy or unknown acquisition fails
 * typed and consumes nothing; a claim refused after the acquisition releases that unused handle.
 */
export async function claimLaunchRole(
	locator: StoreLocator,
	self: LaunchIdentity,
	native: PresencePlacementLoad = loadPresencePlacement(),
): Promise<{ readonly outcome: "claimed" | "already_claimed_by_caller"; readonly presence: HeldPresence }> {
	const store = await openEndpointReservationStore(locator.storePath);
	try {
		const reservation = store.reservation(locator.generation);
		verifyRecordedPresenceRoot(reservation.presence.root, native);
		const nonce = store.readOffer(locator);
		const row = store.roleRow(locator);
		if (!row) throw new EndpointReservationError("role_not_offered", `${locator.role} in ${locator.generation}`);
		const presence = acquirePresence(row.presence, native);
		try {
			const binding =
				row.presence.status === "predeclared"
					? { revision: reservation.revision, presenceId: row.presence.presenceId }
					: undefined;
			return { outcome: store.claim(locator, nonce, identityKey(self), binding), presence };
		} catch (error: unknown) {
			presence.release();
			throw error;
		}
	} finally {
		store.close();
	}
}

/**
 * Grants `role` only to the participant whose recorded identity equals `observed`, the identity the issuer read through
 * the OS for the process it launched. An observation without an exact start discriminator grants nothing.
 */
export function grantVerifiedParticipant(
	store: EndpointReservationStore,
	generation: string,
	role: ReservationRole,
	issuer: LaunchIdentity,
	observed: LaunchIdentity,
	commitment: Uint8Array,
): void {
	if (observed.processStartTime === null) {
		throw new LaunchReservationError("identity_unverified", `pid ${observed.pid} has no readable start time`);
	}
	try {
		store.grant(generation, role, identityKey(issuer), identityKey(observed), commitment);
	} catch (error: unknown) {
		if (error instanceof EndpointReservationError && error.reason === "participant_mismatch") {
			throw new LaunchReservationError("participant_mismatch", `pid ${observed.pid} is not the claimant`);
		}
		throw error;
	}
}

export type GrantWait =
	| { readonly granted: true; readonly commitment: string }
	| { readonly granted: false; readonly reason: "generation_cancelled" | "grant_deadline" };

/**
 * Waits, bounded by `deadlineMs`, until the claimant's role is granted. Each check is one authoritative read of the
 * store; running out of time or a cancelled generation answers "not granted", never an inferred grant.
 */
export async function waitForGrant(
	locator: StoreLocator,
	self: LaunchIdentity,
	options: { readonly deadlineMs: number; readonly intervalMs?: number },
): Promise<GrantWait> {
	const until = Date.now() + options.deadlineMs;
	const store = await openEndpointReservationStore(locator.storePath);
	try {
		for (;;) {
			try {
				const reservation = store.reservation(locator.generation);
				if (reservation.state === "cancelling") return { granted: false, reason: "generation_cancelled" };
				const role = store.grantedRole(locator, identityKey(self));
				if (role) return { granted: true, commitment: role.commitment };
			} catch (error: unknown) {
				if (!(error instanceof EndpointReservationError && error.reason === "store_busy")) throw error;
			}
			if (Date.now() >= until) return { granted: false, reason: "grant_deadline" };
			await delay(Math.min(options.intervalMs ?? 25, Math.max(1, until - Date.now())));
		}
	} finally {
		store.close();
	}
}

export type ClaimWait =
	| { readonly claimed: true; readonly participant: LaunchIdentity }
	| { readonly claimed: false; readonly reason: "generation_cancelled" | "claim_deadline" };

/**
 * The issuer's bounded wait for the claim of `role`. It returns the identity the claimant recorded, which the issuer
 * must then observe through the OS: the claimant may be a wrapper's descendant, never assumed to be the spawned PID.
 */
export async function waitForClaim(
	store: EndpointReservationStore,
	generation: string,
	role: ReservationRole,
	options: { readonly deadlineMs: number; readonly intervalMs?: number },
): Promise<ClaimWait> {
	const until = Date.now() + options.deadlineMs;
	for (;;) {
		try {
			const reservation = store.reservation(generation);
			if (reservation.state === "cancelling") return { claimed: false, reason: "generation_cancelled" };
			const row = store.roleRow({ endpoint: reservation.endpoint, generation, role });
			if (row?.status === "claimed" && row.participant !== null) {
				return { claimed: true, participant: parseIdentity(row.participant) };
			}
		} catch (error: unknown) {
			if (!(error instanceof EndpointReservationError && error.reason === "store_busy")) throw error;
		}
		if (Date.now() >= until) return { claimed: false, reason: "claim_deadline" };
		await delay(Math.min(options.intervalMs ?? 25, Math.max(1, until - Date.now())));
	}
}

function parseIdentity(text: string): LaunchIdentity {
	const value: unknown = JSON.parse(text);
	const pid = typeof value === "object" && value !== null ? Reflect.get(value, "pid") : undefined;
	const start = typeof value === "object" && value !== null ? Reflect.get(value, "processStartTime") : undefined;
	if (typeof pid !== "number" || !(typeof start === "string" || start === null)) {
		throw new LaunchReservationError("identity_unverified", "the recorded participant identity is malformed");
	}
	return { pid, processStartTime: start };
}

/** How an admitted participant that holds a presence lock ends its authority, once it is quiescent. */
export interface ParticipantRelease {
	/** Commits the role's `released`, then closes the guard. Call only after the participant's work is done. */
	releaseAfterQuiescence(): Promise<void>;
}

/**
 * A reserved participant's entry (design 4.2a steps 2-4): claim the offered role with this process's own
 * identity, wait (bounded) for the issuer's grant, then verify the parent's established public secret read-only against
 * the granted commitment. Any failure aborts the start: no provisioning, no repair, no fallback to a direct launch, and
 * the presence handle, which then never authorized a spawn or a listener, is released. An admitted participant keeps
 * holding its lock; the returned release ends it after quiescence. A row without presence returns nothing to release.
 */
export async function admitClaimedParticipant(
	locator: StoreLocator,
	self: LaunchIdentity,
	credential: Buffer | undefined,
	options: { readonly deadlineMs: number; readonly presence?: PresencePlacementLoad },
): Promise<ParticipantRelease | undefined> {
	const { presence } = await claimLaunchRole(locator, self, options.presence);
	try {
		const grant = await waitForGrant(locator, self, options);
		if (!grant.granted) throw new LaunchReservationError(grant.reason, `${locator.role} in ${locator.generation}`);
		const established = credential ? createHash("sha256").update(credential).digest("hex") : undefined;
		if (established !== grant.commitment) {
			throw new LaunchReservationError(
				"commitment_mismatch",
				"the established public secret is not the granted one",
			);
		}
	} catch (error: unknown) {
		presence.release();
		throw error;
	}
	if (presence.object.status !== "predeclared") return undefined;
	return {
		async releaseAfterQuiescence() {
			const store = await openEndpointReservationStore(locator.storePath);
			try {
				store.release(locator.generation, locator.role, identityKey(self));
			} finally {
				store.close();
			}
			presence.release();
		},
	};
}

/**
 * The issuer's half of either hop: wait (bounded) for the claim, read the claimed PID's start time through the
 * OS with `observe`, and grant only when it equals the claimed one, bound to the commitment of `secret`. The claimant
 * may be a wrapper's descendant, so the spawned PID is never assumed to be it.
 */
export async function grantClaimedParticipant(
	store: EndpointReservationStore,
	generation: string,
	role: ReservationRole,
	issuer: LaunchIdentity,
	secret: Buffer,
	observe: (pid: number) => Promise<string | undefined>,
	options: { readonly deadlineMs: number },
): Promise<LaunchIdentity> {
	const claim = await waitForClaim(store, generation, role, options);
	if (!claim.claimed) throw new LaunchReservationError(claim.reason, `${role} in ${generation}`);
	const observed = { pid: claim.participant.pid, processStartTime: (await observe(claim.participant.pid)) ?? null };
	grantVerifiedParticipant(store, generation, role, issuer, observed, createHash("sha256").update(secret).digest());
	return observed;
}
