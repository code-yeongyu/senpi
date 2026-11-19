import { isAbsolute } from "node:path";
import { ProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { assertValidSessionId } from "../../core/session-manager.ts";
import { compactUpdatesEnabled } from "../../core/engine-socket-flag.ts";
import { startOpenTimer } from "../../core/open-timing.ts";

import { SESSION_PATH_RETRY_AFTER_MS } from "./host-reservations.ts";

import { RESERVATION_DENIAL_CODES, type SessionPathReservations } from "./session-path-reservations.ts";
import {
	frozenProfile,
	type OpenRpcSession,
	type RpcSessionEntry,
	type RpcSessionLaunchProfile,
	type RpcSessionOpenOptions,
	RpcSessionRegistryError,
	sessionIdentity,
} from "./session-registry.ts";
import { releaseWithinGrace } from "./session-teardown.ts";
import type { SessionWorkerClient } from "./session-worker-client.ts";
import {
	closedByWorkerDeath,
	SESSION_WORKER_LIMITS,
	type SessionWriteGrant,
	typedWorkerRefusal,
} from "./session-worker-protocol.ts";
import { WorkerSessionClaims } from "./worker-session-claims.ts";
import type { WorkerSessionRegistryOptions } from "./worker-session-registry.ts";
export interface WorkerSessionOpenPort {
	readonly entries: Map<string, RpcSessionEntry>;
	readonly reservations: SessionPathReservations;
	readonly claims: Map<string, WorkerSessionClaims>;
	readonly options: WorkerSessionRegistryOptions;
	readonly closeGraceMs: number;
	readonly size: number;
	now(): number;
	nextHandle(): string;
	knownReservationKey(path: string): string | undefined;
	attach(
		owner: string,
		path: string,
		options?: RpcSessionOpenOptions,
		requested?: RpcSessionLaunchProfile,
	): Promise<OpenRpcSession>;
	reserve(handle: string, path: string): Promise<SessionWriteGrant>;
	reconcile(handle: string, paths: readonly string[]): Promise<void>;
	openResult(handle: string, entry: RpcSessionEntry): OpenRpcSession;
	createWorker(callbacks: ConstructorParameters<typeof SessionWorkerClient>[0]): SessionWorkerClient;
}
export async function openWorkerSession(
	host: WorkerSessionOpenPort,
	profile: RpcSessionLaunchProfile,
	options?: RpcSessionOpenOptions,
): Promise<OpenRpcSession> {
	if (!isAbsolute(profile.cwd) || (profile.sessionPath !== undefined && !isAbsolute(profile.sessionPath)))
		throw new RpcSessionRegistryError("invalid_path");
	// Same contract as RpcSessionRegistry.openSession (#1951), on the registry the multi-session
	// host actually instantiates (#2010). Both checks run SYNCHRONOUSLY before the first await:
	// the format check so a bad id is refused with its own code instead of surfacing as the
	// worker's death (`session_closing`), and the collision scan so a concurrent open naming the
	// same durable id finds this one already recorded. Re-opening the SAME path is an attach,
	// not a collision: the id is the file's own.
	const requestedDurableId = profile.durableSessionId;
	if (requestedDurableId !== undefined) {
		try {
			assertValidSessionId(requestedDurableId);
		} catch (cause) {
			throw new RpcSessionRegistryError("invalid_session_id", String(cause));
		}
		const requestedKey = profile.sessionPath ? host.knownReservationKey(profile.sessionPath) : undefined;
		for (const entry of host.entries.values()) {
			if (entry.state === "closed") continue;
			if (entry.durableSessionId !== requestedDurableId) continue;
			if (requestedKey !== undefined && entry.reservationKey === requestedKey) continue;
			throw new RpcSessionRegistryError("session_id_in_use");
		}
	}
	// A quarantined entry's worker stopped answering, but it keeps its entry, claim and grants until its
	// real exit: a worker stuck in a syscall can still be writing the file. The path is still in use, so
	// the refusal keeps the documented `session_path_in_use` code and names the quarantine in its detail;
	// the worker's exit callback releases everything, and only a retry after that reopens the session
	// from its file (senpi#6452).
	// Matched by the requested spelling or by the key the host already resolved it to, so a platform whose temp
	// paths are symlinks (macOS /var -> /private/var) answers exactly what one without them does.
	const knownKey = profile.sessionPath ? host.knownReservationKey(profile.sessionPath) : undefined;
	for (const entry of host.entries.values()) {
		if (entry.state !== "quarantined") continue;
		const samePath =
			profile.sessionPath !== undefined &&
			(entry.sessionPath === profile.sessionPath || (knownKey !== undefined && entry.reservationKey === knownKey));
		const sameId = requestedDurableId !== undefined && entry.durableSessionId === requestedDurableId;
		if (!samePath && !sameId) continue;
		throw new RpcSessionRegistryError("session_path_in_use", undefined, {
			reason: "session_quarantined",
			action: "retry",
			retry_after_ms: SESSION_PATH_RETRY_AFTER_MS,
		});
	}
	const owner = knownKey ? host.reservations.owner(knownKey) : undefined;
	if (knownKey && owner) return host.attach(owner, knownKey, options, profile);
	if (options?.attachOnly)
		throw new RpcSessionRegistryError("session_not_held", undefined, {
			reason: "session_not_held",
			action: "rediscover_holder",
		});
	if (host.size >= SESSION_WORKER_LIMITS.workers) throw new Error("too_many_sessions");
	const handle = host.nextHandle();
	const claims = new WorkerSessionClaims(host.options.pathReservations);
	host.claims.set(handle, claims);
	const storedProfile = frozenProfile(profile);
	const entry: RpcSessionEntry = {
		state: "opening",
		scope: new ProviderScope(),
		profile: storedProfile,
		...sessionIdentity(storedProfile),
		cwd: profile.cwd,
		attachments: options?.unattached ? 0 : 1,
		retainOnDisconnect: options?.retainOnDisconnect === true,
		lastCommandAt: host.now(),
		lifecycleMutex: Promise.resolve(),
		// Recorded before the first await so the collision scan above sees an open still being
		// built; `snapshot.state.sessionId` overwrites it with the authoritative value after
		// commit, which on a resume is the header's id rather than the requested one.
		...(requestedDurableId !== undefined ? { durableSessionId: requestedDurableId } : {}),
	};
	let workerFailure: string | undefined;
	const worker = host.createWorker({
		reserve: (path) => host.reserve(handle, path),
		reconcile: (livePaths) => host.reconcile(handle, livePaths),
		exit: () => {
			if (host.entries.get(handle) !== entry) return;
			const finish = (): void => {
				if (host.entries.get(handle) !== entry) return;
				entry.state = "closed";
				host.entries.delete(handle);
				host.claims.delete(handle);
				host.reservations.releaseAll(handle);
				entry.closeResolve?.();
			};
			return releaseWithinGrace(
				{ closeGraceMs: host.closeGraceMs, releaseReservation: () => claims.close() },
				handle,
				entry.reservationKey ?? handle,
			).then(finish);
		},
		failure: (error) => {
			// The open below only learns that its entry left `opening`, never why. Without this the
			// caller is told `session_closing` - a path whose owner is tearing down - for a worker
			// that died, and the actual reason reaches stderr alone (#1953).
			workerFailure = error;
			entry.state = "quarantined";
			process.stderr.write(`senpi rpc session ${handle} quarantined: ${error}\n`);
		},
	});
	entry.worker = worker;
	host.entries.set(handle, entry);
	const timer = startOpenTimer(`worker-open:${handle}`);
	try {
		const path = await worker.prepare(host.options.configuration, profile).catch(typedWorkerRefusal);
		timer.mark("prepare");
		const owner = host.reservations.owner(path);
		if (owner) {
			const attached = await host.attach(owner, path, options, profile);
			entry.state = "quarantined";
			worker.quarantine();
			return attached;
		}
		const predecessor = await claims.claim(path);
		timer.mark("claim");
		if (predecessor)
			throw new RpcSessionRegistryError("session_path_in_use", undefined, {
				owner: predecessor,
				retry_after_ms: SESSION_PATH_RETRY_AFTER_MS,
			});
		const grant = await host.reserve(handle, path);
		timer.mark("reserve");
		if (grant !== "granted") throw new RpcSessionRegistryError(RESERVATION_DENIAL_CODES[grant]);
		entry.reservationKey = path;
		entry.requestedPathKey = profile.sessionPath ? path : undefined;
		entry.sessionPath = path;
		const snapshot = await worker.commit();
		timer.mark("commit");
		if (compactUpdatesEnabled()) await worker.acceptance?.generations.bind(snapshot.state.sessionId);
		if (entry.state !== "opening")
			throw workerFailure === undefined
				? new RpcSessionRegistryError("session_closing")
				: new RpcSessionRegistryError("open_failed", workerFailure.replace(/^open_failed: /, ""));
		entry.durableSessionId = snapshot.state.sessionId;
		entry.cwd = snapshot.state.cwd;
		entry.state = "open";
		return host.openResult(handle, entry);
	} catch (cause) {
		entry.state = "quarantined";
		worker.quarantine();
		// A worker that dies before commit (for example one that cannot load its modules) closes what the open
		// is still waiting on: its own request channel rejects the pending prepare with a plain
		// `session_closing` / `session_worker_exited`, and the claims and grants report `session_closing`.
		// Name why the worker died instead, as the commit check above does (#4037, #1953).
		if (workerFailure !== undefined && closedByWorkerDeath(cause))
			throw new RpcSessionRegistryError("open_failed", workerFailure.replace(/^open_failed: /, ""));
		throw cause;
	}
}
