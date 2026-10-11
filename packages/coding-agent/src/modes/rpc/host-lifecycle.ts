#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, isBundledNode } from "../../config.ts";
import { classifyChildExit, noteChildExit } from "./host-child-exit.ts";
import { hostCrashCleanupPaths } from "./host-cleanup-paths.ts";
import { createHostDaemonPaths, generationPaths } from "./host-daemon-paths.ts";
import { HOST_INSTANCE_ID_ENV } from "./host-identity-env.ts";
import { SupervisorActivity, SupervisorOwner } from "./host-lifecycle-activity.ts";
import { drainOnPublicSocketLoss, SupervisorDrain, watchWin32ChildIdentity } from "./host-lifecycle-drain.ts";
import {
	HOST_CHILD_WATCH_FD,
	parseSupervisorArgs,
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
import { createInternalSocketPath, readSettingsFile, recordChildPid } from "./host-lifecycle-scratch.ts";
import {
	performShutdown,
	registerSupervisorSignals,
	type SupervisorShutdown,
	type SupervisorState,
	supervisorSender,
} from "./host-lifecycle-shutdown.ts";
import { errorMessage, writeStderrLine } from "./host-supervisor-log.ts";
import { PUBLIC_SOCKET_IDENTITY_FILE, statSocketIdentity, writeSocketIdentityFile } from "./socket-ownership.ts";
import { createSocketSecret, socketSecretPath } from "./socket-transport.ts";

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
	const publicSecret = process.platform === "win32" ? await ensurePublicSocketSecret(publicSocket) : undefined;
	const internal = await createInternalSocketPath(paths.dir);
	const internalSocket = internal.socket;
	const internalSecretPath = internal.secretPath ?? socketSecretPath(internalSocket);
	const internalSecret = process.platform === "win32" ? await createSocketSecret(internalSecretPath) : undefined;
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
		...(internalSecret ? { internalSecret } : {}),
		settled: () => state.shuttingDown,
		onActivity: () => owner.activity(),
	});
	const watchers: Array<() => void> = [];

	const child = spawnHostChild({
		launch,
		internalSocket,
		internal: { ...internal, secretPath: internalSecretPath },
		...(internalSecret ? { internalSecret } : {}),
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
	// The CHILD's own identity, so a reader can tell "supervisor gone, child still running" apart.
	if (child.pid !== undefined) void recordChildPid(generation.childPidFile, child.pid);
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

	const drain = new SupervisorDrain(child, () => state.shuttingDown);
	const server = createPublicProxy({
		internalSocket,
		...(internalSecret ? { internalSecret } : {}),
		...(publicSecret ? { publicSecret } : {}),
		clients: activity.clients,
		refusing: () => state.shuttingDown || drain.active,
		onDetach: () => activity.refresh(),
		onAdmit: () => owner.activity(),
	});
	server.once("error", (cause) => {
		if (!state.shuttingDown) void shutdown(`public socket listener failed: ${errorMessage(cause)}`, 1);
	});
	const tickIntervalMs = Math.max(20, Math.min(1_000, policy.idleExitMs / 4));
	let ownerCheck = false;
	const ticker = setInterval(() => {
		if (!drain.active && activity.refresh() === "exit" && activity.clients.unclassifiedCount === 0)
			void shutdown("idle", 0);
		if (!ownerCheck && !state.shuttingDown && !drain.active) {
			ownerCheck = true;
			void owner
				.shouldExit(activity)
				.then((exit) => {
					if (exit && !state.shuttingDown && !drain.active) void shutdown("owner_gone", 0);
				})
				.finally(() => {
					ownerCheck = false;
				});
		}
	}, tickIntervalMs);
	watchers.push(() => clearInterval(ticker));
	watchers.push(() => owner.stop());

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
		state,
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
	try {
		// Direct supervisor launches predate owner records and may have no generation directory.
		// Ensured starts create it before spawning and always carry an explicit owner/null record.
		if (launch.ownerFd !== undefined || (await readSettingsFile(generation.settingsFile))) {
			await owner.start(launch.ownerFd);
		}
		await waitForListener(internalSocket, 30_000, internalSecret);
		await activity.openObserver();
		await prepareSocketPath(bindSocket);
		await listen(server, bindSocket, publicSecret);
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
			),
		);
	} catch (cause) {
		await shutdown(`startup failed: ${errorMessage(cause)}`, 1);
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
	writeStderrLine(
		`senpi rpc host ready on unix://${publicSocket} (coldStart=${policy.coldStart}, idleExitMs=${
			policy.coldStart === "persistent" ? "never" : String(policy.idleExitMs)
		})`,
	);
	await new Promise<never>(() => {});
}

function isEntryScript(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return fileURLToPath(import.meta.url) === realpathSync(entry);
	} catch {
		return false;
	}
}

if (!isBundledNode && isEntryScript()) {
	const launch = parseSupervisorArgs(process.argv.slice(2));
	if (!launch) {
		writeStderrLine("usage: host-lifecycle.ts --socket <path> [host cli args...]");
		process.exit(2);
	}
	void runHostSupervisor(launch);
}
