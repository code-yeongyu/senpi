/**
 * The supervisor and host hops of the wrapper-safe launch (sisyphuslabs/omo-desktop-app#4199, design 4.2a "Wrapper-safe discovery
 * and one-time claim"). The launcher reserves a generation and offers the supervisor role, then forwards only a
 * non-secret locator in argv: the store path, endpoint, generation and role. Whatever process the selected runtime
 * finally becomes opens the store itself, reads its role's nonce there and claims with its own identity. The issuer
 * grants only when the claimed identity equals what it observed through the OS for the process it launched, bound to
 * the credential commitment. Nothing in argv, environment or an inherited channel grants anything.
 *
 * On Windows that observation is the bridge's retained-handle adapter (design 4.2a "OS identity", Revision 8 clause
 * (ii)): the issuer opens the claimant's recorded PID on its own kernel, requires `GetProcessId`, the exact creation
 * FILETIME and the `TokenUser` SID to match on that handle, and retains the handle while it grants and observes that
 * participant; a non-match only refuses the grant. A claimant records the same three read on one handle of itself.
 * Elsewhere the identity is the PID and the platform's start-time discriminator, as before.
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
 *
 * Presence cleanup (design 4.2a Revision 7): after its `released` commit and the close of its guard, an actor deletes
 * its own object through an exclusive open; a sharing violation leaves it for the sweep. An issuer whose predeclared
 * object is missing once the offer committed cancels that offer before any spawn.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
	LaunchReservationError,
	LOCATOR_FLAGS,
	type StoreLocator,
	spawnableChildLaunch,
} from "./host-lifecycle-launch.ts";
import {
	LAUNCH_CAPABILITIES_FLAG,
	launchCapabilities,
	PARTICIPANT_LIFETIME_LOCKS_V1,
	SOCKET_SECRET_RESERVATION_V1,
} from "./launch-capabilities.ts";
import {
	EndpointReservationError,
	type EndpointReservationStore,
	openEndpointReservationStore,
	type PresenceObjectRecord,
	type ReservationPresence,
	type ReservationRole,
} from "./endpoint-reservation-store.ts";
import { deletePresenceObject, type PresenceDeletion, presenceObjectMissing } from "./presence-cleanup.ts";
import { predeclarePresenceObject, PresencePlacementError, verifyRecordedPresenceRoot } from "./presence-placement.ts";
import {
	classifyObservation,
	type ProcessEvidence,
	type ProcessExitWait,
	type ProcessRecord,
} from "./process-evidence.ts";
import { loadPresencePlacement, type PresencePlacementLoad } from "./socket-secret-native.ts";

export { LaunchReservationError, parseReservationLocatorArgs, type StoreLocator } from "./host-lifecycle-launch.ts";

/**
 * A process as the OS identifies it: PID, its exact start discriminator and, when read through the Windows bridge on one
 * process handle, its `TokenUser` SID. An identity without a SID is one the platform's start-time reader produced.
 */
export type LaunchIdentity = ProcessRecord;

/**
 * Identities are stored as their canonical JSON, so equality is exact on PID, start discriminator and, when recorded, SID;
 * an identity without a SID keeps the two-field encoding every earlier row has.
 */
function identityKey(identity: LaunchIdentity): string {
	const { pid, processStartTime } = identity;
	return JSON.stringify(
		typeof identity.userSid === "string"
			? { pid, processStartTime, userSid: identity.userSid }
			: { pid, processStartTime },
	);
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
	/**
	 * Deletes the object after the actor's `released` commit and after `release()` closed the guard (design 4.2a Revision
	 * 7 "Clean exit"): an exclusive open that fails with a sharing violation while any other handle exists, leaving the
	 * object for the sweep. Never called for a handle whose authority is still recorded.
	 */
	deleteAfterRelease(): PresenceDeletion;
}

/**
 * Opens and acquires a predeclared presence object with one nonblocking attempt. The bridge keeps the guard only when the
 * opened object's content tag, physical identity and locality match the record (admissibility rules 1 and 2), so an
 * acquired object is the predeclared one. Rule 3, the kernel-session match of a relocated object, is recovery evidence:
 * a start never uses that identity (Revision 8 clause (ii)), so an unverified session never blocks one. Busy is
 * `presence_occupied` and proves only occupied authority, never who holds it; every other result is `presence_unknown`.
 */
export function acquirePresence(object: PresenceObjectRecord, native: PresencePlacementLoad): HeldPresence {
	if (object.status !== "predeclared") {
		return {
			object,
			release: () => {},
			deleteAfterRelease: () => ({ status: "left", reason: "presence_unavailable", detail: null }),
		};
	}
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
		deleteAfterRelease: () => deletePresenceObject(object, native),
	};
}

/** The reserving owner's own presence object, predeclared in the root it resolved and held before anything is persisted. */
export function acquireOwnerPresence(reservation: ReservationPresence, native: PresencePlacementLoad): HeldPresence {
	return acquirePresence(predeclarePresenceObject(reservation.root, native), native);
}

/**
 * The reserving owner's own `released` commit once the generation is terminal for it, then the close of its guard, then
 * the deletion of its object (left for the sweep when another handle is open). Returns the deletion outcome; the
 * commit and the close are the contract, the deletion is cleanup.
 */
export function releaseReservingOwner(
	store: EndpointReservationStore,
	generation: string,
	owner: LaunchIdentity,
	presence: HeldPresence,
): PresenceDeletion {
	store.releaseOwner(generation, identityKey(owner));
	presence.release();
	return presence.deleteAfterRelease();
}

/**
 * The issuer's check once its offer committed (design 4.2a Revision 7): a predeclared object that is missing, which
 * only the sweep's age filter can cause after a creation that stalled past it, cancels the offer before any spawn.
 */
function requireOfferedObject(
	store: EndpointReservationStore,
	generation: string,
	role: ReservationRole,
	object: PresenceObjectRecord,
	native: PresencePlacementLoad,
): void {
	if (!presenceObjectMissing(object, native)) return;
	store.cancel(generation);
	const presenceId = object.status === "predeclared" ? object.presenceId : "";
	throw new PresencePlacementError(
		"presence_object_missing",
		`${presenceId} of ${role} in ${generation} vanished before the offer committed`,
	);
}

/**
 * Which launch route a selected command takes (design section 5, "Mixed versions", final paragraph): the parent-admitted
 * reservation route only for a command whose explicit result names both `socket_secret_reservation_v1` and
 * `participant_lifetime_locks_v1`; any other recognized result, including a reservation-only one, keeps the legacy route.
 */
export type LaunchRoute = "reservation" | "legacy";

function routeOf(capabilities: readonly string[]): LaunchRoute {
	return capabilities.includes(SOCKET_SECRET_RESERVATION_V1) && capabilities.includes(PARTICIPANT_LIFETIME_LOCKS_V1)
		? "reservation"
		: "legacy";
}

/**
 * The route of a command that is this build (the supervisor `startHost` launches, a supervisor's default host): it
 * supplies its own artifact's capability without being probed.
 */
export function ownLaunchRoute(): LaunchRoute {
	return routeOf(launchCapabilities(process.platform));
}

/** What an old runtime's root `--version` prints: one version, optionally `v`-prefixed, with a pre-release or build. */
const VERSION_LINE = /^v?\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.+-]*)?$/;
const PROBE_OUTPUT_LIMIT = 4096;
const LAUNCH_CAPABILITY_PROBE_DEADLINE_MS = 10_000;

/**
 * Runs the selected command, wrapper included, as `<command> <args...> --launch-capabilities --version` and classifies
 * its answer. A capability record selects by its names; an old runtime's version line is its recognized legacy result.
 * A spawn failure, a non-zero exit, a deadline or any other output is an execution/IO error, never a legacy result: it
 * fails with `launch_capability_unknown`. A route never comes from a version number, a spawn's success or a timeout.
 */
export async function selectLaunchRoute(
	launch: { readonly command: string; readonly args: readonly string[] },
	options: { readonly deadlineMs?: number } = {},
): Promise<LaunchRoute> {
	const probe = spawnableChildLaunch({
		command: launch.command,
		args: [...launch.args, LAUNCH_CAPABILITIES_FLAG, "--version"],
	});
	const unknown = (detail: string) => new LaunchReservationError("launch_capability_unknown", detail);
	const output = await new Promise<string>((resolve, reject) => {
		const detached = process.platform !== "win32";
		const child = spawn(probe.command, probe.args, {
			shell: probe.shell,
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
			// Its own process group, so a deadline also stops what a wrapper started.
			detached,
		});
		let stdout = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < PROBE_OUTPUT_LIMIT) stdout += chunk.toString("utf8");
		});
		const timer = setTimeout(() => {
			try {
				if (detached && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {}
			reject(
				unknown(
					`${launch.command} did not answer within ${options.deadlineMs ?? LAUNCH_CAPABILITY_PROBE_DEADLINE_MS}ms`,
				),
			);
		}, options.deadlineMs ?? LAUNCH_CAPABILITY_PROBE_DEADLINE_MS);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(unknown(`${launch.command}: ${error.message}`));
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) resolve(stdout);
			else reject(unknown(`${launch.command} exited with ${code ?? signal}`));
		});
	});
	const lines = output.split(/\r?\n/).filter((line) => line.trim() !== "");
	const answer = lines.length === 1 ? (lines[0] ?? "").trim() : undefined;
	if (answer !== undefined && VERSION_LINE.test(answer)) return "legacy";
	let record: unknown;
	try {
		record = answer === undefined ? undefined : JSON.parse(answer);
	} catch {
		record = undefined;
	}
	const capabilities =
		typeof record === "object" && record !== null ? Reflect.get(record, "launch_capabilities") : undefined;
	if (!Array.isArray(capabilities) || !capabilities.every((name) => typeof name === "string")) {
		throw unknown(`${launch.command} answered no launch-capability result`);
	}
	return routeOf(capabilities);
}

/**
 * Reserves a generation with the presence root the owner resolved and the owner's held presence object, predeclares the
 * supervisor's presence object in that root, offers the supervisor role and returns the argv that carries the locator.
 * The generation expects a host role only when its host target reported both launch capabilities.
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
	expectedRoles: readonly ReservationRole[] = ["supervisor", "host"],
): { generation: string; args: readonly string[] } {
	let generation: string;
	try {
		generation = store.reserve(
			endpoint,
			identityKey(owner),
			expectedRoles,
			presence.reservation,
			presence.ownerPresence.object,
		);
	} catch (error: unknown) {
		presence.ownerPresence.release();
		throw error;
	}
	try {
		const object = predeclarePresenceObject(presence.reservation.root, presence.native);
		store.offer(generation, "supervisor", identityKey(owner), object);
		requireOfferedObject(store, generation, "supervisor", object, presence.native);
	} catch (error: unknown) {
		if (store.reservation(generation).state !== "cancelling") store.cancel(generation);
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
	const object = predeclarePresenceObject(root, native);
	store.offer(generation, "host", identityKey(issuer), object);
	requireOfferedObject(store, generation, "host", object, native);
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
	const sid = typeof value === "object" && value !== null ? Reflect.get(value, "userSid") : undefined;
	if (typeof pid !== "number" || !(typeof start === "string" || start === null)) {
		throw new LaunchReservationError("identity_unverified", "the recorded participant identity is malformed");
	}
	return typeof sid === "string" ? { pid, processStartTime: start, userSid: sid } : { pid, processStartTime: start };
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
			// Clean exit (Revision 7): the `released` commit precedes every deletion; a busy object is the sweep's.
			presence.deleteAfterRelease();
		},
	};
}

/** A granted participant as the issuer observed it, and the handle the issuer keeps open on it. */
export interface GrantedParticipant {
	readonly identity: LaunchIdentity;
	/**
	 * The participant's exit as its process object signals it (design 4.2a: "process-object signalling for exit ... not
	 * wrapper exit"), through the retained handle: the issuer's authority on that participant's death. `cancelled` when
	 * `signal` aborts or `release` runs first; `unavailable` off the bridge, where nothing is retained.
	 */
	waitExit(signal?: AbortSignal): Promise<ProcessExitWait>;
	/** Closes the retained handle once the issuer stops observing the participant. Idempotent. */
	release(): void;
}

/**
 * The issuer's half of either hop: wait (bounded) for the claim, open the claimed PID through `evidence` and grant only
 * the process whose identity matches the claimed one on that handle, bound to the commitment of `secret`. The claimant
 * may be a wrapper's descendant, so the spawned PID is never assumed to be it. Through the bridge the observation table
 * decides: the match is `GetProcessId`, the exact creation FILETIME and the SID; a different creation time, an exited
 * object or an absent PID refuses `participant_mismatch`, a same-birth SID mismatch or a handle whose PID is not the
 * claimed one refuses `identity_inconsistent`, an unreadable or noncomparable observation refuses `identity_unverified`.
 * A start-time reader's identity is compared exactly, as the platform encodes it, by the store's compare-and-grant, as
 * before. A refused handle is closed at once; the granted handle stays open until `release`.
 */
export async function grantClaimedParticipant(
	store: EndpointReservationStore,
	generation: string,
	role: ReservationRole,
	issuer: LaunchIdentity,
	secret: Buffer,
	evidence: ProcessEvidence,
	options: { readonly deadlineMs: number },
): Promise<GrantedParticipant> {
	const claim = await waitForClaim(store, generation, role, options);
	if (!claim.claimed) throw new LaunchReservationError(claim.reason, `${role} in ${generation}`);
	const { pid } = claim.participant;
	const retained = await evidence.open(pid);
	try {
		const { observation } = retained;
		// A reader's identity is the store's to compare; every other observation goes through the table first.
		const verdict = observation.kind === "present" ? undefined : classifyObservation(claim.participant, observation);
		if (verdict?.kind === "gone") {
			throw new LaunchReservationError("participant_mismatch", `pid ${pid} is not the claimant (${verdict.reason})`);
		}
		if (verdict?.kind === "unknown") {
			throw new LaunchReservationError(
				verdict.reason === "inconsistent" ? "identity_inconsistent" : "identity_unverified",
				`pid ${pid}: ${verdict.detail}`,
			);
		}
		// Live on the retained handle: the identity as that handle read it; the reader's: its start time. The table never
		// answers live for an absent or unreadable PID, and a `null` start time grants nothing below either way.
		const observed: LaunchIdentity =
			observation.kind === "opened"
				? { pid, processStartTime: observation.facts.creationTime, userSid: observation.facts.userSid }
				: { pid, processStartTime: observation.kind === "present" ? observation.identity : null };
		// The store's compare-and-grant checks the observed identity against the claim once more, atomically.
		grantVerifiedParticipant(store, generation, role, issuer, observed, createHash("sha256").update(secret).digest());
		return {
			identity: observed,
			waitExit: (signal) => retained.waitExit(signal),
			release: () => retained.close(),
		};
	} catch (error: unknown) {
		retained.close();
		throw error;
	}
}
