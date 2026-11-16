/**
 * Public lifecycle admission before credential mutation (sisyphuslabs/omo-desktop-app#4199, design 4.2a "Admission
 * BEFORE mutation"). On a Windows public endpoint the pipe name and the handshake both derive from the public secret, so
 * a missing or malformed secret makes every connection to a live owner fail; that failure is never proof that the owner
 * is gone. Before anything stops a host, clears a registration or writes a new secret, an ensure that finds the secret
 * missing or malformed takes a census of the recorded owners under the endpoint lock: a live or identity-unreadable
 * owner refuses with `public_secret_recovery_required` and nothing is mutated. Only an endpoint whose recorded owners
 * are all proven gone proceeds to provision.
 *
 * The census reads every record that can name an owner, not only the generation the pointer names: a predecessor
 * drains beside its successor after a handoff, a crash can leave the pointer on a dead generation or remove it while a
 * generation still serves, a host child holds session claims after its supervisor died, and a launch in progress owns
 * the endpoint through its reservation before any generation record exists. A record that cannot be read (a torn host
 * child pidfile, a malformed identity, an offer nobody has claimed yet) is incomplete evidence and refuses like a live
 * owner; only a recorded identity whose process is proven gone counts as absence.
 */
import { lstat, readdir } from "node:fs/promises";
import { parseDaemonPidFile } from "../../utils/process-identity.ts";
import {
	EndpointReservationError,
	openEndpointReservationStore,
	type ReservationCensusRow,
} from "./endpoint-reservation-store.ts";
import { generationPaths, type HostDaemonPaths } from "./host-daemon-paths.ts";
import { readFileOrUndefined } from "./host-daemon-state.ts";
import { HostEnsureRefusedError } from "./host-decision.ts";
import { hostEnsureLockTarget } from "./host-ensure-lock.ts";
import { resolvePidFileOwnership } from "./host-ensure-stop.ts";
import { readLegacyHost } from "./host-legacy.ts";
import { readSessionPathClaims } from "./host-reservations.ts";
import { hostChildAlive } from "./host-stalled-evidence.ts";
import { classifySocketSecret, socketSecretPath } from "./socket-transport.ts";

type ReadStartTime = ((pid: number) => Promise<string | undefined>) | undefined;

/** Throws `public_secret_recovery_required` when the secret is unusable and a recorded owner may be live. */
export async function admitPublicSecretMutation(
	paths: HostDaemonPaths,
	socket: string,
	readStartTime: ReadStartTime,
): Promise<void> {
	const credential = await classifySocketSecret(socketSecretPath(socket));
	if (credential === "valid") return;
	const evidence = await liveOwnerEvidence(paths, socket, readStartTime);
	if (evidence === undefined) return;
	throw new HostEnsureRefusedError(
		socket,
		"public_secret_recovery_required",
		undefined,
		`the public secret is ${credential} and ${evidence}`,
	);
}

/** The first owner that is live or cannot be proven gone, as a non-secret reason; nothing when all are proven gone. */
async function liveOwnerEvidence(
	paths: HostDaemonPaths,
	socket: string,
	readStartTime: ReadStartTime,
): Promise<string | undefined> {
	return (
		(await generationEvidence(paths, readStartTime)) ??
		(await legacyEvidence(paths, readStartTime)) ??
		(await claimEvidence(paths, readStartTime)) ??
		(await reservationEvidence(socket, readStartTime))
	);
}

/** Every generation directory, whatever the pointer says: its supervisor record, then its host child record. */
async function generationEvidence(paths: HostDaemonPaths, readStartTime: ReadStartTime): Promise<string | undefined> {
	const entries = await readdir(paths.generationsDir, { withFileTypes: true }).catch(() => []);
	for (const instanceId of entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()) {
		const generation = generationPaths(paths, instanceId);
		const text = await readFileOrUndefined(generation.pidFile);
		const record = text === undefined ? undefined : parseDaemonPidFile(text);
		if (record === undefined) return `generation ${instanceId} has no readable record`;
		const supervisor = await resolvePidFileOwnership(record, readStartTime);
		if (supervisor === "owns") return `generation ${instanceId} (pid ${record.pid}) is live`;
		if (supervisor === "unknown") return `generation ${instanceId} (pid ${record.pid}) has an unreadable identity`;
		const child = await hostChildAlive(generation);
		if (child === true) return `the host child of generation ${instanceId} is live`;
		if (child === undefined) return `the host child of generation ${instanceId} has no readable record`;
	}
	return undefined;
}

async function legacyEvidence(paths: HostDaemonPaths, readStartTime: ReadStartTime): Promise<string | undefined> {
	const legacy = await readLegacyHost(paths);
	if (!legacy) return undefined;
	const owner = await resolvePidFileOwnership(legacy.record, readStartTime);
	if (owner === "gone") return undefined;
	return `a legacy host (pid ${legacy.record.pid}) is ${owner === "owns" ? "live" : "unknown"}`;
}

/** A session-path claim names the process holding a session file open: an owner even without a generation record. */
async function claimEvidence(paths: HostDaemonPaths, readStartTime: ReadStartTime): Promise<string | undefined> {
	for (const { owner } of await readSessionPathClaims(paths.reservationsDir)) {
		const holder = await resolvePidFileOwnership(owner, readStartTime);
		if (holder === "gone") continue;
		return `a session claim of generation ${owner.instanceId} (pid ${owner.pid}) is ${holder === "owns" ? "live" : "unknown"}`;
	}
	return undefined;
}

/**
 * The reservation store beside the endpoint lock (#4372), read only when it already exists: admission creates no
 * coordination state. The reserving owner holds authority while its generation is pending; a claimed or granted role
 * names the participant that holds it; an offer nobody has claimed names no identity and so cannot be proven gone.
 */
async function reservationEvidence(socket: string, readStartTime: ReadStartTime): Promise<string | undefined> {
	const path = `${hostEnsureLockTarget(socket)}.reservation.db`;
	const present = await lstat(path).then(
		() => true,
		() => false,
	);
	if (!present) return undefined;
	// A store this process cannot open or read (another writer holds it, it is insecure, a row is malformed) is
	// unreadable evidence: the admission refuses typed, like every other incomplete discovery, never with a raw error.
	let rows: readonly ReservationCensusRow[];
	try {
		const store = await openEndpointReservationStore(path);
		try {
			rows = store.census();
		} finally {
			store.close();
		}
	} catch (error: unknown) {
		if (!(error instanceof EndpointReservationError)) throw error;
		return `the reservation store cannot be read (${error.reason})`;
	}
	for (const row of rows) {
		if (row.state === "pending") {
			const owner = await identityEvidence(row.owner, readStartTime);
			if (owner !== undefined) return `the owner of pending reservation ${row.generation} ${owner}`;
		}
		for (const role of row.roles) {
			if (role.status === "offered") return `the ${role.role} offer of reservation ${row.generation} is unclaimed`;
			if (role.status !== "claimed" && role.status !== "granted") continue;
			const participant =
				role.participant === null
					? "has no recorded identity"
					: await identityEvidence(role.participant, readStartTime);
			if (participant !== undefined) return `the ${role.role} of reservation ${row.generation} ${participant}`;
		}
	}
	return undefined;
}

/** A recorded `{"pid":..,"processStartTime":..}` identity: live, unknown, or (nothing) proven gone. */
async function identityEvidence(recorded: string, readStartTime: ReadStartTime): Promise<string | undefined> {
	const identity = parseDaemonPidFile(recorded);
	if (identity === undefined) return "has a malformed identity";
	const owner = await resolvePidFileOwnership(identity, readStartTime);
	if (owner === "gone") return undefined;
	return `(pid ${identity.pid}) is ${owner === "owns" ? "live" : "unknown"}`;
}
