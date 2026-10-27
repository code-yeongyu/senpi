#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAgentDir, isBundledNode, VERSION } from "../../config.ts";
import { readProcessStartTime } from "../../utils/process-identity.ts";
import { HostAdmission } from "./host-admission.ts";
import { classifyChildExit, noteChildExit } from "./host-child-exit.ts";
import { hostCrashCleanupPaths } from "./host-cleanup-paths.ts";
import { isCliModuleEntry } from "./host-cli-entry.ts";
import { createHostDaemonPaths, generationPaths } from "./host-daemon-paths.ts";
import { HOST_INSTANCE_ID_ENV } from "./host-identity-env.ts";
import type { GrantedParticipant, LaunchIdentity, ParticipantRelease } from "./host-launch-reservation.ts";
import { SupervisorActivity, SupervisorOwner } from "./host-lifecycle-activity.ts";
import { drainOnPublicSocketLoss, SupervisorDrain, watchWin32ChildIdentity } from "./host-lifecycle-drain.ts";
import { prepareInternalHop } from "./host-lifecycle-internal-key.ts";
import {
	HOST_CAPABILITY_PROBE_DEADLINE_MS,
	HOST_CHILD_WATCH_FD,
	HOST_STARTUP_BUDGET_MS,
	parseSupervisorArgs,
	type StoreLocator,
	type SupervisorLaunch,
	spawnHostChild,
} from "./host-lifecycle-launch.ts";
import { resolveHostPolicy } from "./host-lifecycle-policy.ts";
import {
	adoptPublicSocket,
	createPublicProxy,
	ensurePublicSocketSecret,
	listen,
	prepareSocketPath,
	waitForListener,
} from "./host-lifecycle-proxy.ts";
import { readSettingsFile, recordChildPid } from "./host-lifecycle-scratch.ts";
import {
	performShutdown,
	registerSupervisorSignals,
	type SupervisorShutdown,
	type SupervisorState,
	supervisorSender,
} from "./host-lifecycle-shutdown.ts";
import { startSupervisorTicker } from "./host-lifecycle-ticker.ts";
import { errorMessage, writeHostReady, writeStderrLine } from "./host-supervisor-log.ts";
import { RpcPublicEndpoint } from "./rpc-public-key.ts";
import { PUBLIC_SOCKET_IDENTITY_FILE, statSocketIdentity, writeSocketIdentityFile } from "./socket-ownership.ts";
import { readSocketSecret, socketSecretPath } from "./socket-transport.ts";

// The exit verdict, the launch surface and the cold-start/idle-exit policy live in their own modules
// (host-child-exit.ts, host-lifecycle-launch.ts, host-lifecycle-policy.ts); they stay exported from
// here so every existing importer keeps resolving them at their original home.
export { classifyChildExit } from "./host-child-exit.ts";
export {
	findInternalSupervisorArgs,
	INTERNAL_SUPERVISOR_FLAG,
	parseSupervisorArgs,
	resolveCliMainPath,
	resolveHostChildLaunch,
	type SupervisorLaunch,
	spawnableChildLaunch,
} from "./host-lifecycle-launch.ts";
export {
	DEFAULT_HANDOFF_GRACE_MS,
	DEFAULT_HOST_IDLE_EXIT_MS,
	HANDOFF_GRACE_MS_ENV,
	HOST_COLD_START_ENV,
	HOST_IDLE_EXIT_MS_ENV,
	type HostActivity,
	type HostColdStart,
	type HostLifecyclePolicy,
	type HostLifecyclePolicyInput,
	IdleExitDecider,
	type IdleExitDecision,
	parseColdStart,
	parseIdleExitMs,
	resolveHostPolicy,
} from "./host-lifecycle-policy.ts";
export { createInternalSocketPath } from "./host-lifecycle-scratch.ts";

export async function runHostSupervisor(launch: SupervisorLaunch): Promise<void> {
	const paths = createHostDaemonPaths({ socket: launch.socket, agentDir: launch.agentDir ?? getAgentDir() });
	// Which generation this supervisor is: the ensure that spawned it says so, and a DIRECT launch
	// (the hidden supervisor route, with no ensure behind it) names itself so its child agrees.
	const told = process.env[HOST_INSTANCE_ID_ENV];
	const instanceId = told !== undefined && told.trim() !== "" ? told : randomUUID();
	const generation = generationPaths(paths, instanceId);
	const policy = resolveHostPolicy(await readSettingsFile(paths.settingsFile), process.env);
	const publicSocket = launch.socket;
	const publicEndpoint =
		process.platform === "win32" ? undefined : new RpcPublicEndpoint(launch.agentDir ?? getAgentDir(), publicSocket);
	// A successor generation binds its own name and adopts the public one by rename; an ordinary
	// start binds the public name directly. Everything downstream - the child's environment, the
	// ownership token, the teardown - is expressed in terms of the PUBLIC path either way.
	const bindSocket = launch.bindSocket ?? publicSocket;
	const successor = launch.bindSocket !== undefined;
	// Direct-launch contract: the supervisor owns the public secret. ensureHost()
	// writes it before spawning, but the hidden --internal-rpc-host-supervisor route
	// has no such caller, so a fresh profile would otherwise die reading it (#1370).
	// It is provisioned BEFORE the internal hop and the child so a provisioning
	// failure leaves no scratch directory and no host process behind.
	// A parent-admitted supervisor claims its reservation and starts only once granted, verifying the parent's secret
	// read-only; it never provisions it (#4199 design 4.2a). The reservation module loads only on that path, so a direct
	// launch keeps its startup import graph (test/supervisor-import-graph.test.ts).
	const admittedLaunch = launch.reservation ? await admitReservedLaunch(launch.reservation, publicSocket) : undefined;
	const publicSecret = admittedLaunch
		? admittedLaunch.credential
		: process.platform === "win32"
			? await ensurePublicSocketSecret(publicSocket)
			: undefined;
	const hop = await prepareInternalHop(paths.dir);
	const { internal, internalSocket, internalSecret, internalKey } = hop;
	const state: SupervisorState = {
		shuttingDown: false,
		shutdownReason: undefined,
		childExitRecorded: Promise.resolve(),
		publicSocketOwned: false,
		publicSocketIdentity: undefined,
		endpointReplaced: false,
	};
	const owner = new SupervisorOwner(generation.dir);
	const activity = new SupervisorActivity({
		idleExitMs: policy.coldStart === "persistent" ? Number.POSITIVE_INFINITY : policy.idleExitMs,
		internalSocket,
		...hop.transport,
		instanceId,
		settled: () => state.shuttingDown,
		onActivity: () => owner.activity(),
	});
	const watchers: Array<() => void> = [];

	// The granted supervisor offers the host role before spawning, in the same reservation generation.
	const grantHost =
		launch.reservation && admittedLaunch && publicSecret
			? await offerReservedHost(launch, launch.reservation, publicSecret, admittedLaunch.self)
			: undefined;
	// The Revision 7 pre-action check before the spawn (design 4.2a "Descriptor-loss detection"): a failed check is
	// terminal. The fenced state this supervisor can commit is the cancellation of the generation it offered the host
	// in; it then performs no further action and exits, leaving its guard to the kernel.
	try {
		admittedLaunch?.presence?.preActionCheck();
	} catch (cause: unknown) {
		await grantHost?.cancel().catch(() => {});
		throw cause;
	}
	const child = spawnHostChild({
		// A host with no offered role is launched the legacy way: no reservation locator reaches it.
		launch: grantHost ? launch : { ...launch, reservation: undefined },
		internalSocket,
		internal,
		...hop.transport,
		supervisorStart: hop.supervisorStart,
		lifetimeFifo: hop.lifetimeFifo,
		daemonDir: paths.dir,
		instanceId,
		cleanupPaths: hostCrashCleanupPaths({
			pointerFile: paths.pointerFile,
			generationPidFile: generation.pidFile,
			settingsFile: paths.settingsFile,
			publicSocket,
			successor: Boolean(successor),
			platform: process.platform,
		}),
		publicSocket,
	});
	const childStartedAt = Date.now();
	// Nothing is ever written; the pipe exists purely so its EOF is a reliable
	// death notification. Errors on it must not crash the supervisor.
	child.stdio[HOST_CHILD_WATCH_FD]?.on("error", () => {});
	// The CHILD's own identity, so a reader can tell "supervisor gone, child still running" apart. A reservation-admitted
	// supervisor records it through the bridge (creation FILETIME and SID on one handle), the domain the recovery census
	// observes in (#4199 design 4.2a "OS identity").
	if (child.pid !== undefined)
		void recordChildPid(
			generation.childPidFile,
			child.pid,
			() => child.exitCode === null && child.signalCode === null,
			admittedLaunch?.identity,
		);
	/** The granted host's handle (Revision 8 clause (ii)), retained while this supervisor observes its child. */
	let grantedHost: GrantedParticipant | undefined;
	let childExitSeen = false;
	/**
	 * The host's end, recorded once, from whichever observation comes first: on Windows the granted host's process object
	 * (design 4.2a: "process-object signalling for exit ... not wrapper exit"), armed below once the host is granted and
	 * answering with the object's exit code; everywhere the ChildProcess exit event, the only signal off the bridge and a
	 * secondary one on it.
	 */
	const onChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
		if (childExitSeen) return;
		childExitSeen = true;
		grantedHost?.release();
		// Recorded BEFORE any shutdown it triggers: `shutdown` ends in `process.exit`. A stop the
		// supervisor is performing itself is recorded too, as the engine stop it is.
		const reason = state.shutdownReason;
		state.childExitRecorded = noteChildExit({
			daemonDir: paths.dir,
			generation,
			instanceId,
			code,
			signal,
			childStartedAt,
			...(state.shuttingDown && reason !== undefined
				? { shutdown: { reason, supervisor: supervisorSender(instanceId) } }
				: {}),
		});
		if (state.shuttingDown) return;
		const verdict = classifyChildExit(code, signal);
		void state.childExitRecorded.then(() => shutdown(verdict.reason, verdict.exitCode));
	};
	child.once("exit", onChildExit);

	const admission = new HostAdmission({ protocolVersion: 1, serverVersion: VERSION, capabilities: [], instanceId });
	const drain = new SupervisorDrain(
		child,
		() => state.shuttingDown,
		() => admission.stop(),
		{ file: generation.childDrainRequestFile, sender: supervisorSender(instanceId) },
	);
	const server = createPublicProxy({
		internalSocket,
		...hop.transport,
		...(publicSecret ? { publicSecret } : {}),
		...(publicEndpoint ? { publicEndpoint } : {}),
		clients: activity.clients,
		admission,
		onDetach: () => activity.refresh(),
		onAdmit: () => owner.activity(),
	});
	server.once("error", (cause) => {
		if (!state.shuttingDown) void shutdown(`public socket listener failed: ${errorMessage(cause)}`, 1);
	});
	watchers.push(
		startSupervisorTicker({
			idleExitMs: policy.idleExitMs,
			activity,
			owner,
			draining: () => drain.active,
			shuttingDown: () => state.shuttingDown,
			shutdown,
		}),
	);

	const reservedPresence = admittedLaunch?.presence;
	const teardown: SupervisorShutdown = {
		paths,
		generation,
		instanceId,
		publicSocket,
		server,
		internalDir: internal.dir,
		child,
		activity,
		drain,
		admission,
		state,
		...(publicEndpoint ? { publicEndpoint } : {}),
		stopWatchers: () => {
			for (const stop of watchers.splice(0)) stop();
		},
		// The supervisor holds its presence lock from before its claim through every spawn and bind it makes, and gives
		// it up only once the shutdown has observed its child's exit and closed its listener.
		...(reservedPresence ? { afterQuiescence: () => reservedPresence.releaseAfterQuiescence() } : {}),
	};
	let shutdownPromise: Promise<never> | undefined;
	// Single-flight: concurrent triggers (listener error, child exit, signals) must not process.exit
	// mid-cleanup. Late callers park on this promise while the first shutdown finishes and exits.
	function shutdown(reason: string, exitCode: number): Promise<never> {
		shutdownPromise ??= performShutdown(teardown, reason, exitCode);
		return shutdownPromise;
	}

	// Registered before the startup handshake, not after it: the private internal directory already
	// exists, so a SIGTERM arriving during host startup must run the same cleanup instead of Node's
	// default kill, which would leave that directory behind.
	registerSupervisorSignals(shutdown, () => drain.drain());
	try {
		grantedHost = await grantHost?.grant();
		if (grantedHost) {
			// The authority on the host's death: its process object, waited on through the retained handle. The wait ends
			// with the shutdown's watcher stop or the handle's release; a cancelled or unavailable wait decides nothing.
			const watch = new AbortController();
			watchers.push(() => watch.abort());
			void grantedHost.waitExit(watch.signal).then((wait) => {
				if (wait.kind === "exited") onChildExit(wait.exitCode, null);
			});
		}
		// Direct supervisor launches predate owner records and may have no generation directory.
		// Ensured starts create it before spawning and always carry an explicit owner/null record.
		if (launch.ownerFd !== undefined || (await readSettingsFile(generation.settingsFile))) {
			await owner.start(launch.ownerFd);
		}
		await waitForListener(internalSocket, HOST_STARTUP_BUDGET_MS, internalSecret, internalKey);
		await activity.openObserver();
		// The pre-listen intent (design 4.2a step 4): one short transaction that revalidates this supervisor's grant
		// immediately before the public bind, so a cancellation recorded since the grant ends the start here.
		await admittedLaunch?.commitListenIntent();
		await prepareSocketPath(bindSocket);
		// The pre-action check before the public bind; a failure lands in the catch below, which fences the generation.
		admittedLaunch?.presence?.preActionCheck();
		await listen(server, bindSocket, publicSecret);
		await publicEndpoint?.publish();
		state.publicSocketOwned = true;
		if (successor) await adoptPublicSocket(bindSocket, publicSocket, launch.replaceIdentity);
		state.publicSocketIdentity = await statSocketIdentity(publicSocket);
		// Publish the ownership token inside this supervisor's private scratch
		// directory (which no replacement supervisor writes): the host child's
		// crash-path cleanup compares the public path against THIS entry only.
		if (state.publicSocketIdentity && internal.dir) {
			await writeSocketIdentityFile(join(internal.dir, PUBLIC_SOCKET_IDENTITY_FILE), state.publicSocketIdentity);
		}
		watchers.push(
			drainOnPublicSocketLoss(
				publicSocket,
				state.publicSocketIdentity,
				() => state.shuttingDown || drain.active,
				drain,
				() => {
					state.endpointReplaced = true;
				},
				{ file: paths.pointerFile, instanceId },
			),
		);
		watchers.push(await drain.acceptRequests(generation));
	} catch (cause) {
		// A failed start fences the generation it offered the host in (design 4.2a "Crash, cancellation and commit"): a
		// granted host, or a wrapper descendant still claiming, cannot commit a pre-listen intent afterwards. The fence's
		// own failure is reported beside the cause, never instead of it.
		const fence = await grantHost?.cancel().then(
			() => undefined,
			(error: unknown) => ` (reservation fence also failed: ${errorMessage(error)})`,
		);
		await shutdown(`startup failed: ${errorMessage(cause)}${fence ?? ""}`, 1);
	}
	if (process.platform === "win32") {
		watchers.push(
			await watchWin32ChildIdentity(
				child,
				() => state.shuttingDown,
				() => void shutdown("rpc host child exit observed by identity watchdog", 0),
			),
		);
	}
	writeHostReady(publicSocket, policy.coldStart, policy.idleExitMs);
	await new Promise<never>(() => {});
}

if (!isBundledNode && isCliModuleEntry(import.meta.url)) {
	const launch = parseSupervisorArgs(process.argv.slice(2));
	if (!launch) {
		writeStderrLine("usage: host-lifecycle.ts --socket <path> [host cli args...]");
		process.exit(2);
	}
	void runHostSupervisor(launch);
}

/** How long a parent-admitted supervisor waits for its grant before giving up its start; its own identity read counts. */
const SUPERVISOR_GRANT_DEADLINE_MS = 10_000;
/** Store contention on the expected-roles read is retried inside this bound; the read itself is short. */
const EXPECTED_ROLES_BUSY_RETRY_MS = 2_000;

/** Runs `read` again while it reports `store_busy`, until `budgetMs` is spent; every other error propagates at once. */
async function retryWhileBusy<T>(read: () => T, budgetMs: number): Promise<T> {
	const until = Date.now() + budgetMs;
	for (;;) {
		try {
			return read();
		} catch (error: unknown) {
			const busy = error instanceof Error && "reason" in error && error.reason === "store_busy";
			if (!busy || Date.now() >= until) throw error;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
}

/**
 * The parent-admitted supervisor's entry (design 4.2a steps 2-3): read this process's own identity (PID, creation
 * FILETIME and SID on one handle of itself through the bridge, as the issuer will verify it; PID and start time with
 * the bounded retry elsewhere), claim, wait for the grant and verify the parent's secret against it. Returns the
 * pre-listen intent (step 4) the startup commits immediately before the public bind.
 */
async function admitReservedLaunch(
	reservation: StoreLocator,
	publicSocket: string,
): Promise<{
	credential: Buffer | undefined;
	self: LaunchIdentity;
	presence: ParticipantRelease | undefined;
	/** The bridge's read of a pid on one handle, for the host child's record; absent off the bridge (the reader records). */
	identity: ((pid: number) => Promise<LaunchIdentity | undefined>) | undefined;
	commitListenIntent: () => Promise<void>;
}> {
	const {
		admitClaimedParticipant,
		commitListenIntent,
		IDENTITY_OBSERVATION_PROBE_MS,
		LaunchReservationError,
		readClaimantIdentity,
	} = await import("./host-launch-reservation.ts");
	const { bridgeProcessIdentity } = await import("./process-evidence.ts");
	const { loadPresencePlacement } = await import("./socket-secret-native.ts");
	if (reservation.role !== "supervisor") {
		throw new LaunchReservationError("locator_incomplete", "the supervisor entry requires a supervisor reservation");
	}
	const until = Date.now() + SUPERVISOR_GRANT_DEADLINE_MS;
	const credential = await readSocketSecret(socketSecretPath(publicSocket)).catch(() => undefined);
	const native = loadPresencePlacement();
	const self =
		(await bridgeProcessIdentity(native, process.pid)) ??
		(await readClaimantIdentity(
			process.pid,
			(pid) => readProcessStartTime(pid, process.platform, IDENTITY_OBSERVATION_PROBE_MS),
			SUPERVISOR_GRANT_DEADLINE_MS,
		));
	const presence = await admitClaimedParticipant(reservation, self, credential, {
		deadlineMs: Math.max(0, until - Date.now()),
		presence: native,
	});
	return {
		credential,
		self,
		presence,
		identity: native.status === "available" ? (pid) => bridgeProcessIdentity(native, pid) : undefined,
		commitListenIntent: async () => {
			if (!credential) throw new LaunchReservationError("commitment_mismatch", "no established public secret");
			await commitListenIntent(reservation, self, credential);
		},
	};
}

/**
 * Reservation-only lazy boundary: direct supervisors never load SQLite or the reservation helpers. The offer is made
 * before the spawn; `grant` verifies and grants the claimant inside the host's startup budget, and `cancel` is the
 * durable fence a failed start leaves behind. Returns nothing when the reserving owner expects no host role: it
 * classified the host legacy, which keeps the legacy launch (#4199 design section 5, "Mixed versions").
 */
async function offerReservedHost(
	launch: SupervisorLaunch,
	reservation: StoreLocator,
	secret: Buffer,
	issuer: LaunchIdentity,
): Promise<{ grant: () => Promise<GrantedParticipant>; cancel: () => Promise<void> } | undefined> {
	const { openEndpointReservationStore } = await import("./endpoint-reservation-store.ts");
	const {
		grantClaimedParticipant,
		IDENTITY_OBSERVATION_PROBE_MS,
		LaunchReservationError,
		offerHostRole,
		ownLaunchRoute,
		selectLaunchRoute,
	} = await import("./host-launch-reservation.ts");
	const { processEvidence } = await import("./process-evidence.ts");
	const { loadPresencePlacement } = await import("./socket-secret-native.ts");
	const native = loadPresencePlacement();
	const store = await openEndpointReservationStore(reservation.storePath);
	try {
		// An unreadable expected set is not a legacy classification: the offer below refuses it. A store briefly busy
		// with another writer's short transaction is retried inside the startup budget, like every other read here.
		const expected = await retryWhileBusy(
			() => store.expectedRoles(reservation.generation),
			EXPECTED_ROLES_BUSY_RETRY_MS,
		);
		if (expected?.includes("host") === false) return undefined;
		// The host receives the locator only once its launch-capability result names both capabilities: an explicit child
		// command is another runtime and answers the probe; the default host is this build and reports its own. A legacy
		// answer here cannot downgrade a generation that expects its host. The probe's deadline sits inside the ensure's
		// readiness window, so a host that never answers is refused typed rather than reported as a readiness timeout.
		const route = launch.childCommand
			? await selectLaunchRoute(
					{ command: launch.childCommand, args: launch.childArgs ?? [] },
					{ deadlineMs: HOST_CAPABILITY_PROBE_DEADLINE_MS },
				)
			: ownLaunchRoute();
		if (route !== "reservation") {
			throw new LaunchReservationError(
				"launch_capability_missing",
				"the reservation expects a host role the selected host command does not support",
			);
		}
		// The host's presence object is predeclared in the root the reserving owner recorded, before the spawn.
		offerHostRole(store, reservation.generation, issuer, native);
	} finally {
		store.close();
	}
	// The host is verified on one retained handle through the bridge (PID, creation FILETIME, SID), by its start time
	// (each probe given the time a loaded runner's CIM read needs) elsewhere; the handle stays open while this supervisor
	// observes its child.
	return {
		grant: async () => {
			const store = await openEndpointReservationStore(reservation.storePath);
			try {
				return await grantClaimedParticipant(
					store,
					reservation.generation,
					"host",
					issuer,
					secret,
					processEvidence(native, (pid) =>
						readProcessStartTime(pid, process.platform, IDENTITY_OBSERVATION_PROBE_MS),
					),
					{ deadlineMs: HOST_STARTUP_BUDGET_MS },
				);
			} finally {
				store.close();
			}
		},
		cancel: async () => {
			const store = await openEndpointReservationStore(reservation.storePath);
			try {
				store.cancel(reservation.generation);
			} finally {
				store.close();
			}
		},
	};
}
