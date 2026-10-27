/**
 * The supervisor and host hops of the wrapper-safe launch (sisyphuslabs/omo-desktop-app#4199, design 4.2a "Wrapper-safe
 * discovery and one-time claim"). The launcher reserves a generation and offers the supervisor role, then forwards only a
 * non-secret locator in argv: the store path, endpoint, generation and role. Whatever process the selected runtime
 * finally becomes opens the store itself, reads its role's nonce there and claims with its own identity. The issuer
 * grants only when the claimed identity equals what it observed through the OS for the process it launched, bound to
 * the credential commitment. Nothing in argv, environment or an inherited channel grants anything.
 *
 * The locator must resolve to the endpoint's fixed store beside its ensure lock (step 1): a claimant computes that path
 * itself and refuses a locator naming any other file. A commitment is the private SHA-256 digest of the credential bound
 * to its role and its path, so one credential yields a different commitment per hop. Before its bind, a granted
 * participant commits its pre-listen intent in a short transaction that revalidates the grant (step 4).
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
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
import { hostEnsureLockTarget } from "./host-ensure-lock.ts";
import {
	LaunchReservationError,
	LOCATOR_FLAGS,
	type StoreLocator,
	spawnableChildLaunch,
} from "./host-lifecycle-launch.ts";
import { predeclarePresenceObject, verifyRecordedPresenceRoot } from "./presence-placement.ts";
import { loadPresencePlacement, type PresencePlacementLoad } from "./socket-secret-native.ts";
import { socketSecretPath } from "./socket-transport.ts";

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

/** The endpoint's one reservation store, beside its ensure lock (design 4.2a step 1); the only store a locator may name. */
export function reservationStorePath(endpoint: string): string {
	return `${hostEnsureLockTarget(endpoint)}.reservation.db`;
}

/**
 * How many times an identity is observed before it stays unknown, and the floor each observation keeps of the caller's
 * deadline (design 4.2a: a second observation within five seconds, bounded by the existing claim/grant budget). A single
 * 1 s CIM probe fails on a loaded Windows runner; the retry stays inside the deadline the caller already waits.
 */
export const IDENTITY_OBSERVATION_ATTEMPTS = 2;
const IDENTITY_OBSERVATION_BUDGET_MS = 5_000;
/** Each production probe's own limit: two of them fit the five-second bound, and one outlasts a loaded runner's CIM read. */
export const IDENTITY_OBSERVATION_PROBE_MS = IDENTITY_OBSERVATION_BUDGET_MS / IDENTITY_OBSERVATION_ATTEMPTS;

/** Store contention during the intent transaction is retried inside this bound; the transaction itself is short. */
const INTENT_BUSY_RETRY_MS = 2_000;

/**
 * The commitment of `credential` for one hop: a private SHA-256 digest bound to the role and the credential's path, so
 * the host's commitment is never valid for the supervisor's grant and a credential at another path never matches.
 * Fields are length-prefixed, so no boundary between them is ambiguous.
 */
export function credentialCommitment(credential: Uint8Array, role: ReservationRole, path: string): Buffer {
	const hash = createHash("sha256");
	for (const field of [
		Buffer.from("senpi-rpc-launch-commitment-v1"),
		Buffer.from(role),
		Buffer.from(path),
		credential,
	]) {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(field.length);
		hash.update(length).update(field);
	}
	return hash.digest();
}

/** The commitment the issuer grants and the claimant verifies for `role` of `endpoint`: the public secret's. */
function endpointCommitment(credential: Uint8Array, role: ReservationRole, endpoint: string): Buffer {
	return credentialCommitment(credential, role, socketSecretPath(endpoint));
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
	 * The Revision 7 pre-action check on the holding handle (design 4.2a "Descriptor-loss detection"), run before each
	 * authorized bind, spawn or credential mutation: the bridge compares the handle's physical identity with the recorded
	 * one, reads through it and reclassifies the volume. A failed check is terminal for the actor and throws
	 * `presence_pre_action_failed`; the registry stays fenced, so the actor never re-acquires and continues. A row
	 * without presence has nothing to check.
	 */
	preActionCheck(): void;
}

/**
 * Opens and acquires a predeclared presence object with one nonblocking attempt. The bridge keeps the guard only when the
 * opened object's content tag, physical identity and locality match the record (admissibility rules 1 and 2), so an
 * acquired object is the predeclared one. Rule 3, the kernel-session match of a relocated object, is recovery evidence:
 * the design's kernel-session identity bullet says grants, starts and observations through a retained handle never use
 * the identity, so an unverified session never blocks a start. Busy is `presence_occupied` and proves only occupied
 * authority, never who holds it; every other result is `presence_unknown`.
 */
export function acquirePresence(object: PresenceObjectRecord, native: PresencePlacementLoad): HeldPresence {
	if (object.status !== "predeclared") return { object, release: () => {}, preActionCheck: () => {} };
	if (native.status !== "available") {
		throw new LaunchReservationError("presence_unknown", `${object.presenceId}: ${native.reason}`);
	}
	const bridge = native.native;
	const result = bridge.presenceProbe({
		presenceId: object.presenceId,
		path: object.path,
		header: Buffer.from(object.header, "hex"),
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
		preActionCheck: () => {
			const check = bridge.presencePreActionCheck(object.presenceId);
			if (check.status === "valid") return;
			const reason = "reason" in check ? ` ${check.reason}` : "";
			throw new LaunchReservationError(
				"presence_pre_action_failed",
				`${object.presenceId}: ${check.status}${reason}`,
			);
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

/**
 * What an old runtime's root `--version` prints (`DISPLAY_VERSION` in config.ts), each form positively recognized: one
 * version, optionally `v`-prefixed, with a pre-release or build (the engine's `VERSION` and a brand's semver or CalVer
 * `displayVersion`); or the brand label an `omo` distribution injects as its `displayVersion`,
 * `<brand>@<commit> <date> <time> <zone>` (for example `omo@c6e7dd7 2026-09-04 10:17 +09:00`). Any other line is not a
 * legacy answer: it is unrecognized and fails closed.
 */
const VERSION_LINES: readonly RegExp[] = [
	/^v?\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.+-]*)?$/,
	/^[A-Za-z][A-Za-z0-9._-]*@[0-9a-f]{7,40} \d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}$/,
];
const PROBE_OUTPUT_LIMIT = 4096;
const LAUNCH_CAPABILITY_PROBE_DEADLINE_MS = 10_000;

/**
 * How a probe that outlived its deadline is ended. A POSIX probe runs in its own process group, so the group signal
 * also ends what a wrapper started. Windows has no group signal, and killing only the direct child leaves the runtime a
 * `.cmd`/`.bat` wrapper started running: the whole tree is ended by pid through `taskkill /t`.
 */
export function probeDeadlineKill(
	pid: number,
	platform: NodeJS.Platform,
):
	| { readonly command: string; readonly args: readonly string[] }
	| { readonly signal: "SIGKILL"; readonly target: number } {
	return platform === "win32"
		? { command: "taskkill", args: ["/pid", String(pid), "/t", "/f"] }
		: { signal: "SIGKILL", target: -pid };
}

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
				if (child.pid === undefined) {
					child.kill("SIGKILL");
				} else {
					const kill = probeDeadlineKill(child.pid, process.platform);
					if ("signal" in kill) process.kill(kill.target, kill.signal);
					else spawn(kill.command, [...kill.args], { stdio: "ignore", windowsHide: true }).once("error", () => {});
				}
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
	if (answer !== undefined && VERSION_LINES.some((form) => form.test(answer))) return "legacy";
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

/** Two spellings of one path compare equal; win32 paths compare case-insensitively like the filesystem does. */
function samePath(left: string, right: string): boolean {
	const normalize = (path: string) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
	return normalize(left) === normalize(right);
}

/**
 * Opens the store a locator names, after checking it IS the endpoint's fixed reservation store (design 4.2a step 1):
 * a wrapper that renames the store path confers nothing, and nothing in that other file is read.
 */
async function openLocatedStore(locator: StoreLocator): Promise<EndpointReservationStore> {
	const expected = reservationStorePath(locator.endpoint);
	if (!samePath(locator.storePath, expected)) {
		throw new LaunchReservationError("store_mismatch", `the locator does not name the endpoint's reservation store`);
	}
	return openEndpointReservationStore(locator.storePath);
}

/**
 * The claimant opens the endpoint's store named by the locator, checks that the recorded presence root is the same
 * still-local physical directory from where it runs, reads its nonce there, acquires its role's predeclared presence
 * object BEFORE the nonce-claim transaction, and claims with its own identity bound to that object at the revision it
 * read first. A different physical directory (another profile, packaged-app virtualization) or a busy or unknown
 * acquisition fails typed and consumes nothing; a claim refused after the acquisition releases that unused handle.
 */
export async function claimLaunchRole(
	locator: StoreLocator,
	self: LaunchIdentity,
	native: PresencePlacementLoad = loadPresencePlacement(),
): Promise<{ readonly outcome: "claimed" | "already_claimed_by_caller"; readonly presence: HeldPresence }> {
	const store = await openLocatedStore(locator);
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
	const store = await openLocatedStore(locator);
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

/**
 * The granted participant's pre-listen intent (design 4.2a step 4), committed immediately before its bind: one short
 * transaction revalidates generation, role, grant and the commitment of the credential it is about to serve with, then
 * records the intent. A generation cancelled after the grant refuses it typed, so the participant aborts before it
 * binds; the recorded grant and identity stay for the recovery census.
 */
export async function commitListenIntent(
	locator: StoreLocator,
	self: LaunchIdentity,
	credential: Uint8Array,
): Promise<void> {
	const store = await openLocatedStore(locator);
	const until = Date.now() + INTENT_BUSY_RETRY_MS;
	try {
		for (;;) {
			try {
				store.commitListenIntent(
					locator,
					identityKey(self),
					endpointCommitment(credential, locator.role, locator.endpoint),
				);
				return;
			} catch (error: unknown) {
				if (!(error instanceof EndpointReservationError)) throw error;
				if (error.reason === "store_busy" && Date.now() < until) {
					await delay(25);
					continue;
				}
				if (error.reason === "generation_cancelled") {
					throw new LaunchReservationError("generation_cancelled", `${locator.role} in ${locator.generation}`);
				}
				if (error.reason === "commitment_mismatch") {
					throw new LaunchReservationError(
						"commitment_mismatch",
						"the credential about to be served is not the granted one",
					);
				}
				throw error;
			}
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
	/** The pre-action check of the held guard before each authorized spawn or bind; see `HeldPresence.preActionCheck`. */
	preActionCheck(): void;
}

/**
 * Reads a process's exact start discriminator with `observe`, retrying a failed or empty observation
 * `IDENTITY_OBSERVATION_ATTEMPTS` times in all within the smaller of `deadlineMs` and the design's five-second bound.
 * Still unreadable after that: `undefined`, which grants nothing; it never becomes an inferred identity.
 */
export async function observeStartTime(
	pid: number,
	observe: (pid: number) => Promise<string | undefined>,
	deadlineMs: number,
): Promise<string | undefined> {
	const until = Date.now() + Math.min(deadlineMs, IDENTITY_OBSERVATION_BUDGET_MS);
	for (let attempt = 1; ; attempt++) {
		try {
			const start = await observe(pid);
			if (start) return start;
		} catch {
			// A starved or failed probe is an observation failure, retried below; never a verdict on the process.
		}
		if (attempt >= IDENTITY_OBSERVATION_ATTEMPTS || Date.now() >= until) return undefined;
		await delay(Math.min(100, Math.max(1, until - Date.now())));
	}
}

/**
 * A claimant's own identity, read with the same bound as the issuer's observation: an identity that stays unreadable
 * claims nothing, since no grant could ever match it.
 */
export async function readClaimantIdentity(
	pid: number,
	observe: (pid: number) => Promise<string | undefined>,
	deadlineMs: number,
): Promise<LaunchIdentity> {
	const processStartTime = await observeStartTime(pid, observe, deadlineMs);
	if (processStartTime === undefined) {
		throw new LaunchReservationError("identity_unverified", `pid ${pid} could not read its own start time`);
	}
	return { pid, processStartTime };
}

/**
 * A reserved participant's entry (design 4.2a steps 2-3): claim the offered role with this process's own
 * identity, wait (bounded) for the issuer's grant, then verify the parent's established public secret read-only against
 * the granted commitment. Any failure aborts the start: no provisioning, no repair, no fallback to a direct launch, and
 * the presence handle, which then never authorized a spawn or a listener, is released. An admitted participant keeps
 * holding its lock; the returned release ends it after quiescence. A row without presence returns nothing to release.
 * The pre-listen intent (step 4) is committed separately, immediately before the bind, with `commitListenIntent`.
 */
export async function admitClaimedParticipant(
	locator: StoreLocator,
	self: LaunchIdentity,
	credential: Buffer | undefined,
	options: { readonly deadlineMs: number; readonly presence?: PresencePlacementLoad },
): Promise<ParticipantRelease | undefined> {
	const { presence } = await claimLaunchRole(locator, self, options.presence);
	const releaseAfterQuiescence = async () => {
		const store = await openEndpointReservationStore(locator.storePath);
		try {
			store.release(locator.generation, locator.role, identityKey(self));
		} finally {
			store.close();
		}
		presence.release();
	};
	let granted = false;
	try {
		const grant = await waitForGrant(locator, self, options);
		if (!grant.granted) throw new LaunchReservationError(grant.reason, `${locator.role} in ${locator.generation}`);
		granted = true;
		const established = credential
			? endpointCommitment(credential, locator.role, locator.endpoint).toString("hex")
			: undefined;
		if (established !== grant.commitment) {
			throw new LaunchReservationError(
				"commitment_mismatch",
				"the established public secret is not the granted one",
			);
		}
	} catch (error: unknown) {
		if (granted && presence.object.status === "predeclared") {
			// Granted, then refused before any spawn or listen: the handle is no longer unused, so the role's authority
			// ends with its own `released` commit before the guard closes. A commit that fails keeps the guard held; the
			// process exits without spawn or listen and the kernel releases it.
			await releaseAfterQuiescence().catch(() => {});
			throw error;
		}
		presence.release();
		throw error;
	}
	if (presence.object.status !== "predeclared") return undefined;
	return { releaseAfterQuiescence, preActionCheck: () => presence.preActionCheck() };
}

/**
 * The issuer's half of either hop: wait (bounded) for the claim, read the claimed PID's start time through the
 * OS with `observe` (retried once inside the remaining budget), and grant only when it equals the claimed one, bound to
 * the commitment of `secret` for that role. The claimant may be a wrapper's descendant, so the spawned PID is never
 * assumed to be it.
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
	const until = Date.now() + options.deadlineMs;
	const claim = await waitForClaim(store, generation, role, options);
	if (!claim.claimed) throw new LaunchReservationError(claim.reason, `${role} in ${generation}`);
	const observed = {
		pid: claim.participant.pid,
		processStartTime:
			(await observeStartTime(claim.participant.pid, observe, Math.max(1, until - Date.now()))) ?? null,
	};
	const { endpoint } = store.reservation(generation);
	grantVerifiedParticipant(store, generation, role, issuer, observed, endpointCommitment(secret, role, endpoint));
	return observed;
}
