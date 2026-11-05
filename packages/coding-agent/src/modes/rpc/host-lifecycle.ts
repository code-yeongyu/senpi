#!/usr/bin/env node
// First: report the coordinated start before the lifecycle graph loads (senpi#4602).
import "./host-startup-beacon.ts";
import "../../private-fds.ts";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, isBundledNode, VERSION } from "../../config.ts";
import { readProcessStartTime } from "../../utils/process-identity.ts";
import { HostAdmission } from "./host-admission.ts";
import { classifyChildExit, noteChildExit } from "./host-child-exit.ts";
import { hostCrashCleanupPaths } from "./host-cleanup-paths.ts";
import { isCliModuleEntry } from "./host-cli-entry.ts";
import {
	createGenerationDirectory,
	createHostDaemonPaths,
	generationPaths,
	HostDaemonStateError,
} from "./host-daemon-paths.ts";
import { HOST_INSTANCE_ID_ENV } from "./host-identity-env.ts";
import type { LaunchIdentity } from "./host-launch-reservation.ts";
import { SupervisorActivity, SupervisorOwner } from "./host-lifecycle-activity.ts";
import { drainOnPublicSocketLoss, SupervisorDrain, watchWin32ChildIdentity } from "./host-lifecycle-drain.ts";
import { prepareInternalHop } from "./host-lifecycle-internal-key.ts";
import {
	HOST_CHILD_WATCH_FD,
	HOST_STARTUP_BUDGET_MS,
	parseSupervisorArgs,
	type StoreLocator,
	type SupervisorLaunch,
	spawnHostChild,
} from "./host-lifecycle-launch.ts";
import { resolveHostPolicy } from "./host-lifecycle-policy.ts";
import {
	awaitInternalStartup,
	declareHostChild,
	hostChildReportsStartup,
	hostChildSpawned,
	publishSupervisorEndpoint,
	supervisorPublished,
} from "./host-lifecycle-startup.ts";
import { createPublicProxy, ensurePublicSocketSecret } from "./host-lifecycle-proxy.ts";
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
export { HOST_CHILD_LISTEN_MS } from "./host-lifecycle-startup.ts";

export async function runHostSupervisor(launch: SupervisorLaunch): Promise<void> {
	const paths = createHostDaemonPaths({ socket: launch.socket, agentDir: launch.agentDir ?? getAgentDir() });
	// Which generation this supervisor is: the ensure that spawned it says so, and a DIRECT launch
	// (the hidden supervisor route, with no ensure behind it) names itself so its child agrees.
	const told = process.env[HOST_INSTANCE_ID_ENV];
	const instanceId = told !== undefined && told.trim() !== "" ? told : randomUUID();
	const generation = generationPaths(paths, instanceId);
	const created = await mkdir(generation.dir, { recursive: true, mode: 0o700 }).catch((cause) => {
		throw new HostDaemonStateError(generation.dir, cause);
	});
	let startupRegistered = false;
	await using _generationStartup = {
		async [Symbol.asyncDispose]() {
			// An ensured directory is not ours to discard. Until shutdown owns a new one,
			// every failed startup must remove it, including failures after child spawn.
			if (created !== undefined && !startupRegistered) {
				await rm(generation.dir, { recursive: true, force: true });
			}
		},
	};
	// A direct launch has no ensure to provision its records before the child can write them.
	await createGenerationDirectory(generation);
	const settings = await readSettingsFile(paths.settingsFile);
	const policy = resolveHostPolicy(settings, process.env);
	const publicSocket = launch.socket;
	const publicEndpoint =
		process.platform === "win32" ? undefined : new RpcPublicEndpoint(launch.agentDir ?? getAgentDir(), publicSocket);
	// A successor generation binds its own name and adopts the public one by rename; an ordinary
	// start binds the public name directly. Everything downstream - the child's environment, the
	// ownership token, the teardown - is expressed in terms of the PUBLIC path either way.
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
		startupComplete: Promise.resolve(),
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
			? await offerReservedHost(launch.reservation, publicSecret, admittedLaunch.self)
			: undefined;
	declareHostChild(launch.childCommand);
	const child = spawnHostChild({
		launch,
		reportsStartup: hostChildReportsStartup(launch.childCommand),
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
			successor: launch.bindSocket !== undefined,
			platform: process.platform,
		}),
		publicSocket,
	});
	const childStartedAt = Date.now();
	await hostChildSpawned(child, generation.dir, hop.supervisorStart?.time);
	// Nothing is ever written; the pipe exists purely so its EOF is a reliable
	// death notification. Errors on it must not crash the supervisor.
	child.stdio[HOST_CHILD_WATCH_FD]?.on("error", () => {});
	// The CHILD's own identity, so a reader can tell "supervisor gone, child still running" apart.
	if (child.pid !== undefined)
		void recordChildPid(
			generation.childPidFile,
			child.pid,
			() => child.exitCode === null && child.signalCode === null,
		);
	child.once("exit", (code, signal) => {
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
	});

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
	startupRegistered = true;
	try {
		await grantHost?.grant();
		// Direct supervisor launches predate owner records and may have no generation settings.
		// Ensured starts create it before spawning and always carry an explicit owner/null record.
		if (launch.ownerFd !== undefined || (await readSettingsFile(generation.settingsFile))) {
			await owner.start(launch.ownerFd);
		}
		await awaitInternalStartup({
			internalSocket,
			internalSecret,
			internalKey,
			openObserver: () => activity.openObserver(),
		});
		if (state.shuttingDown) return;
		// Shutdown stops the child immediately, but joins these writes before removing their directories.
		state.startupComplete = (async () => {
			// The pre-listen intent (design 4.2a step 4): one short transaction that revalidates this supervisor's grant
			// immediately before the public bind, so a cancellation recorded since the grant ends the start here.
			await admittedLaunch?.commitListenIntent();
			await publishSupervisorEndpoint({
				launch,
				server,
				publicSecret,
				publicEndpoint,
				generationDir: generation.dir,
				instanceId,
				settings,
				state,
			});
			state.publicSocketIdentity = await statSocketIdentity(publicSocket);
			// The child's crash cleanup compares the public entry against this generation's private token.
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
		})();
		await state.startupComplete;
		supervisorPublished();
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
	if (state.shuttingDown) return;
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

/**
 * The parent-admitted supervisor's entry (design 4.2a steps 2-3): read this process's own identity with the bounded
 * retry, claim, wait for the grant and verify the parent's secret against it. Returns the pre-listen intent (step 4)
 * the startup commits immediately before the public bind.
 */
async function admitReservedLaunch(
	reservation: StoreLocator,
	publicSocket: string,
): Promise<{ credential: Buffer | undefined; self: LaunchIdentity; commitListenIntent: () => Promise<void> }> {
	const {
		admitClaimedParticipant,
		commitListenIntent,
		IDENTITY_OBSERVATION_PROBE_MS,
		LaunchReservationError,
		readClaimantIdentity,
	} = await import("./host-launch-reservation.ts");
	if (reservation.role !== "supervisor") {
		throw new LaunchReservationError("locator_incomplete", "the supervisor entry requires a supervisor reservation");
	}
	const until = Date.now() + SUPERVISOR_GRANT_DEADLINE_MS;
	const credential = await readSocketSecret(socketSecretPath(publicSocket)).catch(() => undefined);
	const self = await readClaimantIdentity(
		process.pid,
		(pid) => readProcessStartTime(pid, process.platform, IDENTITY_OBSERVATION_PROBE_MS),
		SUPERVISOR_GRANT_DEADLINE_MS,
	);
	await admitClaimedParticipant(reservation, self, credential, { deadlineMs: Math.max(0, until - Date.now()) });
	return {
		credential,
		self,
		commitListenIntent: async () => {
			if (!credential) throw new LaunchReservationError("commitment_mismatch", "no established public secret");
			await commitListenIntent(reservation, self, credential);
		},
	};
}

/**
 * Reservation-only lazy boundary: direct supervisors never load SQLite or the reservation helpers. The offer is made
 * before the spawn; `grant` verifies and grants the claimant inside the host's startup budget, and `cancel` is the
 * durable fence a failed start leaves behind.
 */
async function offerReservedHost(
	reservation: StoreLocator,
	secret: Buffer,
	issuer: LaunchIdentity,
): Promise<{ grant: () => Promise<void>; cancel: () => Promise<void> }> {
	const { openEndpointReservationStore } = await import("./endpoint-reservation-store.ts");
	const { grantClaimedParticipant, IDENTITY_OBSERVATION_PROBE_MS, offerHostRole } =
		await import("./host-launch-reservation.ts");
	const store = await openEndpointReservationStore(reservation.storePath);
	try {
		// The host's presence object is predeclared in the root the reserving owner recorded, before the spawn.
		offerHostRole(store, reservation.generation, issuer);
	} finally {
		store.close();
	}
	return {
		grant: async () => {
			const store = await openEndpointReservationStore(reservation.storePath);
			try {
				await grantClaimedParticipant(
					store,
					reservation.generation,
					"host",
					issuer,
					secret,
					(pid) => readProcessStartTime(pid, process.platform, IDENTITY_OBSERVATION_PROBE_MS),
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
