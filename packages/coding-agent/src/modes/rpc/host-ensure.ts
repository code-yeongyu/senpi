import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ENV_AGENT_DIR, getAgentDir } from "../../config.ts";
import { engineBuildIdentity } from "../../core/engine-build-identity.ts";
import {
	type DaemonPidFile,
	ProcessIdentityUnreadableError,
	processIsLive,
	processMatchesPidFile,
	readProcessStartTime,
	waitForStartTime,
} from "../app-server/daemon/process.ts";
import { RPC_CLIENT_CAPABILITIES_ENV } from "./custom-capability.ts";
import {
	createDaemonDirectories,
	createHostDaemonPaths,
	HOST_DAEMON_DIR_ENV,
	type HostDaemonPaths,
} from "./host-daemon-paths.ts";
import {
	clearHostRegistration,
	legacyHostIsLive,
	type RegisteredHost,
	readHostRegistration,
	writeHostRegistration,
	writtenByThisProcess,
} from "./host-daemon-registration.ts";
import { writeHostSettings } from "./host-daemon-state.ts";
import {
	decideHostAction,
	HOST_PROTOCOL_VERSION,
	type HostDecision,
	type HostDecisionClient,
	HostEnsureRefusedError,
	type HostProtocolInfo,
	REQUIRED_HOST_CAPABILITIES,
} from "./host-decision.ts";
import { handoffHost } from "./host-handoff.ts";
import { defaultHostLaunch, PINNED_HOST_CLIENT_CAPABILITIES } from "./host-launch.ts";
import { DEFAULT_HOST_IDLE_EXIT_MS, type HostColdStart, type HostLifecyclePolicyInput } from "./host-lifecycle.ts";
import { probeProtocolInfo, probeSocketReachable } from "./host-probe.ts";
import { acquireOwnershipSafeLock } from "./ownership-safe-lock.ts";
import { HOST_GENERATION_ENV, HOST_INSTANCE_ID_ENV, hostLaunchProfile } from "./protocol-identity.ts";
import { createSocketSecret, resolveSocketTransportAddress, socketSecretPath } from "./socket-transport.ts";

export {
	createHostDaemonPaths,
	daemonDirectoryName,
	type HostDaemonPaths,
	HostDaemonStateError,
	type HostGenerationPaths,
} from "./host-daemon-paths.ts";
export { defaultHostLaunch, PINNED_HOST_CLIENT_CAPABILITIES } from "./host-launch.ts";
export { type ProbeHostOptions, probeHost } from "./host-probe.ts";
export type { HostColdStart, HostLifecyclePolicyInput };

/**
 * What an ensure may do to a host that is already running.
 *
 * `never` (the default) attaches or starts, and touches nothing that is already serving the
 * socket. `if-engine-differs` additionally allows a GENERATION HANDOFF when `decideHostAction`
 * finds this build strictly newer and its extension set a superset of the running host's - the
 * running host then drains instead of dying, so no session is ever ended by an upgrade.
 */
export type HostUpgradePolicy = "never" | "if-engine-differs";

export interface EnsureHostOptions {
	readonly socket: string;
	readonly agentDir?: string;
	/** Host lifecycle policy recorded in settings.json (env overrides win at runtime). */
	readonly policy?: HostLifecyclePolicyInput;
	/** Extra CLI arguments forwarded through the supervisor to the host process. */
	readonly hostArgs?: readonly string[];
	/** Environment for the spawned host; a `null` value removes an inherited variable. */
	readonly env?: Readonly<Record<string, string | null>>;
	/** Whether a newer build may take the socket over from the running host. Defaults to `never`. */
	readonly upgrade?: HostUpgradePolicy;
	readonly _test?: {
		readonly readinessTimeoutMs?: number;
		readonly stopTimeoutMs?: number;
		readonly spawn?: { readonly command: string; readonly args: readonly string[] };
		/** Builds the spawnable command from supervisor argv; tests point it at the source entry. */
		readonly launch?: (args: readonly string[]) => { readonly command: string; readonly args: readonly string[] };
		/** Runs after endpoint ownership is locked; deterministic concurrency-test gate. */
		readonly afterLockAcquired?: () => Promise<void>;
		/**
		 * Runs after the child is spawned but before its pidfile is registered, so a
		 * test can force the startup failure a loaded runner produces without having
		 * to stall the real process-identity probe.
		 */
		readonly beforePidFileWrite?: () => Promise<void>;
		/** Overrides the process-identity probe so a test can force its failure. */
		readonly readProcessStartTime?: (pid: number) => Promise<string | undefined>;
	};
}

export interface EnsuredHost {
	readonly pid: number;
	readonly socket: string;
	readonly reused: boolean;
}

const SPAWNED_HOST_PROBE_TIMEOUT_MS = 10_000;
const EXISTING_HOST_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const SIGKILL_GRACE_MS = 2_000;
/**
 * A lock waiter must outlast the longest critical section a holder can run:
 * probing an existing host, stopping an incompatible one (SIGTERM wait plus the
 * SIGKILL grace), then spawning the replacement and waiting for it to answer.
 * Each SQLite busy wait stays short because it blocks the event loop; this
 * cumulative budget is what covers the whole section, with headroom for a slow
 * runner. A waiter that gives up early surfaces as a raw "database is locked"
 * failure on the second of two concurrent starts.
 */
const ENSURE_LOCK_WAIT_MS =
	EXISTING_HOST_PROBE_TIMEOUT_MS + DEFAULT_STOP_TIMEOUT_MS + SIGKILL_GRACE_MS + DEFAULT_READINESS_TIMEOUT_MS + 10_000;
const LOCK_BUSY_WAIT_MS = 100;
const lockOptions = {
	retries: { retries: ENSURE_LOCK_WAIT_MS / LOCK_BUSY_WAIT_MS, minTimeout: 20, maxTimeout: LOCK_BUSY_WAIT_MS },
} as const;
export async function ensureHost(options: EnsureHostOptions): Promise<EnsuredHost> {
	const socket = normalizeSocketPath(options.socket);
	const paths = createHostDaemonPaths({ socket, ...(options.agentDir ? { agentDir: options.agentDir } : {}) });
	await createDaemonDirectories(paths);
	// The public socket is the shared resource; agent directories are not a
	// sufficient lock scope when two installations target the same endpoint.
	const lockTarget = join(tmpdir(), "senpi-rpc-host-locks", createSocketLockName(socket));
	await mkdir(dirname(lockTarget), { recursive: true });
	await writeFile(lockTarget, "", { flag: "a", mode: 0o600 });
	// Opportunistic GC of other installs' leftovers stays OUTSIDE the endpoint lock.
	// Its cost scales with the whole tmpdir and, on win32, adds a ~1s process probe per
	// candidate; inside the critical section that inflated the hold for every concurrent
	// ensureHost until a waiter exhausted its budget and surfaced a raw "database is
	// locked". Its own guards (60s age, dead owner pid) already make it safe unlocked.
	await reapOrphanedInternalHostDirs();
	const release = await acquireOwnershipSafeLock(`${lockTarget}.lock`, lockOptions);
	try {
		await options._test?.afterLockAcquired?.();
		return await ensureHostLocked(paths, socket, options);
	} finally {
		await release();
	}
}

async function ensureHostLocked(
	paths: HostDaemonPaths,
	socket: string,
	options: EnsureHostOptions,
): Promise<EnsuredHost> {
	const testOptions = options._test;
	const registered = await readHostRegistration(paths);
	// A record naming ANOTHER endpoint is not about this ensure's host. The per-socket directory
	// makes that structural, and the field stays as the second guard for a directory that was
	// somehow reused: a second socket must never read the first socket's daemon as its own.
	const registeredHere = registersSocket(registered, socket);
	const protocol = await probeProtocolInfo(socket, EXISTING_HOST_PROBE_TIMEOUT_MS);
	const startedByUs = registeredHere && (await writtenByThisProcess(registered?.writer));
	const attachedPid = registeredHere ? (registered?.record.pid ?? 0) : 0;
	const decision = decide(options, startedByUs, protocol);
	switch (decision.action) {
		case "reuse":
			// A compatible socket is attachable even when another client surface
			// started it. Only hosts we spawned are eligible for lifecycle management.
			return { pid: attachedPid, socket, reused: true };
		case "refuse":
			throw new HostEnsureRefusedError(socket, decision.reason, protocol);
		case "handoff":
			return upgradeGeneration(paths, socket, options, attachedPid);
		case "start":
			break;
		default:
			return assertNever(decision);
	}
	const probe = testOptions?.readProcessStartTime ?? readProcessStartTime;
	const pidMatches = registeredHere && registered ? await matchesPidFileOrUnknown(registered.record, probe) : false;
	if (registered && pidMatches) {
		// I1: the socket is silent, but the process behind it is alive. Only the process that WROTE
		// this record may end it - anyone else refuses rather than signalling somebody else's host.
		if (!startedByUs) throw new HostEnsureRefusedError(socket, "foreign_writer", protocol);
		// ... and silent is not the same as gone. A host serving many sessions can miss a probe
		// budget while its event loop is busy; its socket still ACCEPTS the connection. Ending it
		// then would destroy every live session to replace a host that was never broken, so a
		// reachable socket is refused instead of signalled - the caller retries or falls back.
		if (await probeSocketReachable(socket, EXISTING_HOST_PROBE_TIMEOUT_MS)) {
			throw new HostEnsureRefusedError(socket, "host_busy", protocol);
		}
		await stopManagedHost(registered.record, testOptions?.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS, probe);
	}
	// A host from before this layout registered itself in the FLAT directory. Its files are another
	// process's state: never read as ours, never signalled, never removed - and while it is alive,
	// this ensure refuses instead of binding a socket it may still be serving.
	if (await legacyHostIsLive(paths, probe)) throw new HostEnsureRefusedError(socket, "legacy_host", protocol);
	if (registeredHere) await clearHostRegistration(paths);
	return startHost(paths, socket, options);
}

/** `fallback` belongs to clients that can live without a host; an ensure must produce one or fail. */
function decide(
	options: EnsureHostOptions,
	startedByUs: boolean,
	protocol: HostProtocolInfo | undefined,
): Exclude<HostDecision, { action: "fallback" }> {
	if (options.upgrade !== "if-engine-differs") {
		return decideHostAction(ensureClient(options, startedByUs), protocol, "never");
	}
	const decision = decideHostAction(ensureClient(options, startedByUs), protocol, "upgrade");
	return decision.action === "fallback" ? { action: "reuse", reason: "compatible", upgradeable: false } : decision;
}

/**
 * The upgrade, when the decision allows one: a new generation takes the socket and the running
 * host drains. A refused handoff ATTACHES - an upgrade that cannot happen must never become a stop.
 */
async function upgradeGeneration(
	paths: HostDaemonPaths,
	socket: string,
	options: EnsureHostOptions,
	attachedPid: number,
): Promise<EnsuredHost> {
	const result = await handoffHost({
		socket,
		agentDir: options.agentDir ?? getAgentDir(),
		hostArgs: options.hostArgs ?? [],
		...(options.env ? { env: options.env } : {}),
		...(options.policy ? { policy: options.policy } : {}),
		_test: {
			...(options._test?.launch ? { launch: options._test.launch } : {}),
			...(options._test?.readinessTimeoutMs ? { readinessTimeoutMs: options._test.readinessTimeoutMs } : {}),
		},
	});
	if (result.action === "handoff") return { pid: result.pid, socket, reused: false };
	await appendStderr(
		paths,
		`generation handoff refused: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`,
	);
	return { pid: attachedPid, socket, reused: true };
}

/** This build as a client: which protocol it speaks, what it needs from a host, and which build it is. */
function ensureClient(options: EnsureHostOptions, startedByUs: boolean): HostDecisionClient {
	return {
		protocolVersion: HOST_PROTOCOL_VERSION,
		requiredCapabilities: REQUIRED_HOST_CAPABILITIES,
		identity: engineBuildIdentity(),
		// An ensure that may upgrade has to say what it would launch: the superset rule refuses to
		// hand off to a generation that would drop what the running host loads. An ensure that may
		// not upgrade declares nothing, and therefore can never be the newer candidate.
		...(options.upgrade === "if-engine-differs"
			? { launchProfile: hostLaunchProfile(hostChildArgv(options.hostArgs ?? []), process.cwd()) }
			: {}),
		startedByUs,
		platform: process.platform,
	};
}

/** The argv the supervisor gives its host child; the launch profile has to describe THAT host. */
function hostChildArgv(hostArgs: readonly string[]): string[] {
	return ["--mode", "rpc", "--multi-session", ...hostArgs];
}

/** Whether a registration is about this endpoint. A record written before the field existed is. */
function registersSocket(registered: RegisteredHost | undefined, socket: string): boolean {
	if (registered === undefined) return false;
	return registered.socket === undefined || registered.socket === socket;
}

async function startHost(paths: HostDaemonPaths, socket: string, options: EnsureHostOptions): Promise<EnsuredHost> {
	const testOptions = options._test;
	// The generation this ensure is about to spawn, chosen HERE so its directory exists before the
	// host boots and the pointer can name it the moment the host is registered.
	const instanceId = randomUUID();
	// The settings file must exist before the supervisor reads it at boot, so it
	// records the policy before the spawn instead of beside the pidfile.
	if (process.platform === "win32") await createSocketSecret(socketSecretPath(socket));
	await writeHostSettings(paths, {
		socket,
		capabilities: PINNED_HOST_CLIENT_CAPABILITIES,
		coldStart: options.policy?.coldStart ?? "transient",
		idleExitMs: options.policy?.idleExitMs ?? DEFAULT_HOST_IDLE_EXIT_MS,
		generation: 0,
		instanceId,
	});
	const stderr = await open(paths.stderrLog, "w", 0o600);
	let pidFile: DaemonPidFile | undefined;
	let child: ReturnType<typeof spawn> | undefined;
	let exitedEarly: ChildExit | undefined;
	let childExit: Promise<ChildExit> | undefined;
	try {
		const supervisorArgs = ["--socket", socket, ...(options.hostArgs ?? [])];
		const launch = testOptions?.spawn ?? testOptions?.launch?.(supervisorArgs) ?? defaultHostLaunch(supervisorArgs);
		child = spawn(launch.command, [...launch.args], {
			detached: true,
			windowsHide: true,
			env: hostEnv(options, { paths, instanceId }),
			stdio: ["ignore", "ignore", stderr.fd],
		});
		childExit = new Promise((resolveExit) => {
			child!.once("exit", (code, signal) => {
				exitedEarly = { code, signal };
				resolveExit(exitedEarly);
			});
		});
		if (child.pid === undefined) throw new Error("failed to spawn RPC socket host");
		const probe = testOptions?.readProcessStartTime ?? readProcessStartTime;
		const observedStartTime = await Promise.race([
			waitForStartTime(child.pid, 10_000, probe),
			childExit.then(() => {
				throw new Error("RPC socket host exited before its start time could be read");
			}),
		]);
		// UNKNOWN identity on a live child: the probe was starved, not the host. Give the CIM table
		// one unhurried read (the per-attempt win32 default is 1s, which a loaded runner exceeds on
		// every attempt) before deciding.
		const unhurriedProbe = testOptions?.readProcessStartTime
			? testOptions.readProcessStartTime
			: (pid: number) => readProcessStartTime(pid, process.platform, 15_000);
		const processStartTime = observedStartTime ?? (await unhurriedProbe(child.pid).catch(() => undefined));
		// Still unreadable: the host is ours, alive, and about to prove itself on the socket, so it is
		// registered WITHOUT an ownership guard instead of being torn down for a starved probe. A
		// guard-less record never claims ownership and never authorizes a signal - every later caller
		// reads it as unknown - so the worst case is a fresh host next time, not a killed healthy one.
		pidFile = { pid: child.pid, processStartTime: processStartTime ?? null };
		await testOptions?.beforePidFileWrite?.();
		await writeHostRegistration(paths, {
			record: pidFile,
			socket,
			instanceId,
			generation: 0,
			launchProfileId: hostLaunchProfile(hostChildArgv(options.hostArgs ?? []), process.cwd()).profile_id,
		});
		child.unref();
	} catch (error: unknown) {
		// Whether the child died on its own decides which diagnostic is true, and the
		// cleanup kill below records an `exitedEarly` indistinguishable from a real
		// self-exit. Latch it before killing, or the catch reports the SIGTERM it is
		// about to send and discards the actual startup failure.
		const exitedBeforeCleanup = exitedEarly;
		// Keep the ChildProcess handle owned until registration succeeds. If startup
		// fails before the pidfile is written, terminate this exact child through
		// its still-attached handle rather than leaving an unmanaged daemon behind.
		if (!exitedBeforeCleanup && child && child.exitCode === null && child.signalCode === null) {
			try {
				child.kill("SIGTERM");
			} catch {}
			if (childExit) await Promise.race([childExit, delay(2_000)]);
			if (child.exitCode === null && child.signalCode === null) {
				try {
					child.kill("SIGKILL");
				} catch {}
			}
		}
		if (!exitedBeforeCleanup) {
			await clearHostRegistration(paths);
			throw error;
		}
		const diagnostic = await appendStderr(
			paths,
			`RPC socket host exited with code ${exitedBeforeCleanup.code ?? "null"}${exitedBeforeCleanup.signal ? ` (${exitedBeforeCleanup.signal})` : ""} before answering get_protocol_info`,
		);
		await clearHostRegistration(paths);
		throw new Error(diagnostic);
	} finally {
		await stderr.close();
	}
	const readinessTimeoutMs = testOptions?.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
	const result = await pollProtocolInfo(socket, readinessTimeoutMs, childExit);
	if (isCompatible(result.protocol)) return { pid: pidFile.pid, socket, reused: false };
	// Teardown runs for the diagnostic's sake, so it must never replace it: a stop
	// failure here (unreadable identity, a host that outlives SIGKILL) would other-
	// wise propagate instead of the readiness message and skip cleanupState below,
	// leaving the pidfile and socket behind. Record it and keep going.
	// This child is ours and its handle is still attached: stop it through the handle.
	// Validating ownership through the pidfile would re-run the identity probe whose
	// failure is the very thing a loaded runner produces here.
	const stopFailure = await stopSpawnedChild(
		child,
		childExit,
		testOptions?.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
	).then(
		() => undefined,
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
	const message = result.protocol
		? `RPC socket host answered get_protocol_info with protocolVersion ${result.protocol.protocolVersion}, serverVersion ${result.protocol.serverVersion} and capabilities ${JSON.stringify(result.protocol.capabilities)}, but is incompatible with protocol version ${HOST_PROTOCOL_VERSION} and required capabilities ${JSON.stringify(REQUIRED_HOST_CAPABILITIES)}`
		: result.exited
			? `RPC socket host exited with code ${result.exited.code ?? "null"}${result.exited.signal ? ` (${result.exited.signal})` : ""} before answering get_protocol_info`
			: `spawned RPC socket host did not answer get_protocol_info within ${readinessTimeoutMs}ms`;
	const diagnostic = await appendStderr(
		paths,
		stopFailure === undefined ? message : `${message} (teardown also reported: ${stopFailure})`,
	);
	await clearHostRegistration(paths);
	// The supervisor may have failed before binding, or another owner may have
	// appeared while readiness was being checked. Never unlink an endpoint we
	// cannot prove this start owned.
	throw new Error(diagnostic);
}

/**
 * Ownership for the reuse decision. An identity we cannot read proves nothing: it can neither
 * claim the host nor authorize a kill, so it reads as "not ours" and the caller starts fresh
 * rather than failing the whole ensure on an observation gap.
 */
async function matchesPidFileOrUnknown(
	pidFile: DaemonPidFile,
	probe: (pid: number) => Promise<string | undefined>,
): Promise<boolean> {
	try {
		return await processMatchesPidFile(pidFile, probe);
	} catch (error: unknown) {
		if (error instanceof ProcessIdentityUnreadableError) return false;
		throw error;
	}
}

async function stopSpawnedChild(
	child: ChildProcess,
	childExit: Promise<ChildExit>,
	termTimeoutMs: number,
): Promise<void> {
	const exited = () => child.exitCode !== null || child.signalCode !== null;
	if (exited()) return;
	const signal = (name: NodeJS.Signals) => {
		try {
			child.kill(name);
		} catch (error: unknown) {
			if (!isNodeErrorCode(error, "ESRCH")) throw error;
		}
	};
	const waitFor = (ms: number) => Promise.race([childExit.then(() => true), delay(ms).then(() => exited())]);
	signal("SIGTERM");
	if (await waitFor(termTimeoutMs)) return;
	signal("SIGKILL");
	if (!(await waitFor(SIGKILL_GRACE_MS))) {
		throw new Error(`RPC socket host pid ${child.pid ?? "?"} remained alive after SIGKILL`);
	}
}

async function stopManagedHost(
	pidFile: DaemonPidFile,
	termTimeoutMs: number,
	readStartTime: (pid: number) => Promise<string | undefined> = readProcessStartTime,
): Promise<void> {
	await signalValidated(pidFile, "SIGTERM", readStartTime);
	if (await waitForGone(pidFile, termTimeoutMs, readStartTime)) return;
	await signalValidated(pidFile, "SIGKILL", readStartTime);
	if (!(await waitForGone(pidFile, SIGKILL_GRACE_MS, readStartTime))) {
		throw new Error(`RPC socket host pid ${pidFile.pid} remained alive after SIGKILL`);
	}
}

type PidFileOwnership = "owns" | "gone" | "unknown";

// One probe per call: the teardown loops below are themselves the retry, so the
// budget inside processMatchesPidFile would only multiply their wall time. A probe
// that fails against a LIVE pid is "unknown" — it proves nothing about ownership, so
// signalling on it would be unsafe and treating it as "gone" would abandon a host that
// may still be running. A failed probe against a dead pid is "gone".
async function resolvePidFileOwnership(
	pidFile: DaemonPidFile,
	readStartTime: (pid: number) => Promise<string | undefined>,
): Promise<PidFileOwnership> {
	try {
		return (await processMatchesPidFile(pidFile, readStartTime, processIsLive, { attempts: 1 })) ? "owns" : "gone";
	} catch (error: unknown) {
		if (error instanceof ProcessIdentityUnreadableError) return "unknown";
		throw error;
	}
}

async function signalValidated(
	pidFile: DaemonPidFile,
	signal: NodeJS.Signals,
	readStartTime: (pid: number) => Promise<string | undefined> = readProcessStartTime,
): Promise<void> {
	if ((await resolvePidFileOwnership(pidFile, readStartTime)) !== "owns") return;
	try {
		process.kill(pidFile.pid, signal);
	} catch (error: unknown) {
		if (!isNodeErrorCode(error, "ESRCH")) throw error;
	}
}

async function waitForGone(
	pidFile: DaemonPidFile,
	timeoutMs: number,
	readStartTime: (pid: number) => Promise<string | undefined> = readProcessStartTime,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if ((await resolvePidFileOwnership(pidFile, readStartTime)) === "gone") return true;
		await delay(50);
	}
	return (await resolvePidFileOwnership(pidFile, readStartTime)) === "gone";
}

type ChildExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

type ProtocolPollResult = { readonly protocol?: HostProtocolInfo; readonly exited?: ChildExit };

async function pollProtocolInfo(
	socket: string,
	timeoutMs: number,
	childExit?: Promise<ChildExit>,
): Promise<ProtocolPollResult> {
	const deadline = Date.now() + timeoutMs;
	let lastProtocol: HostProtocolInfo | undefined;
	while (Date.now() <= deadline) {
		const probe = probeProtocolInfo(
			socket,
			Math.min(SPAWNED_HOST_PROBE_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
		);
		const raced = childExit ? await Promise.race([probe, childExit]) : await probe;
		if (isChildExit(raced)) {
			// A supervisor exit can be triggered by the Windows identity watchdog
			// while a named-pipe client is still composing its protocol reply. Do
			// not terminate the host based solely on that exit until this probe has
			// had a chance to deliver an answer. A host that never answers still
			// resolves through probeProtocolInfo's bounded timeout/close handling.
			const info = await probe;
			if (info) {
				lastProtocol = info;
				if (isCompatible(info)) return { protocol: info };
			} else {
				return { protocol: lastProtocol, exited: raced };
			}
		} else if (raced) {
			lastProtocol = raced;
			if (isCompatible(raced)) return { protocol: raced };
		}
		await delay(50);
	}
	return { protocol: lastProtocol };
}

function isChildExit(value: HostProtocolInfo | ChildExit | undefined): value is ChildExit {
	return !!value && "code" in value && "signal" in value;
}

/**
 * Compatibility, for the attach decision and the readiness gate alike: a host is compatible exactly
 * when a client that is forbidden to upgrade would attach to it. Never a version-string comparison (I2).
 */
function isCompatible(protocol: HostProtocolInfo | undefined): boolean {
	return decideHostAction(ensureClient({ socket: "" }, false), protocol, "never").action === "reuse";
}

/** The environment a spawned host inherits: this process's, the caller's overrides, then the fixed wiring. */
function hostEnv(
	options: EnsureHostOptions,
	generation: { readonly paths: HostDaemonPaths; readonly instanceId: string },
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const [key, value] of Object.entries(options.env ?? {})) {
		if (value === null) delete env[key];
		else env[key] = value;
	}
	env[ENV_AGENT_DIR] = options.agentDir ?? getAgentDir();
	env[RPC_CLIENT_CAPABILITIES_ENV] = PINNED_HOST_CLIENT_CAPABILITIES.join(",");
	// Always SET, never inherited: an ensure run from inside a daemon session would otherwise hand
	// its own host's identity to the one it spawns, and two hosts claiming one instance id make a
	// handoff - which completes exactly when the instance id changes - impossible to observe.
	env[HOST_INSTANCE_ID_ENV] = generation.instanceId;
	env[HOST_GENERATION_ENV] = "0";
	env[HOST_DAEMON_DIR_ENV] = generation.paths.dir;
	return env;
}

async function reapOrphanedInternalHostDirs(): Promise<void> {
	try {
		const entries = await readdir(tmpdir(), { withFileTypes: true });
		await Promise.all(
			entries
				.filter((entry) => entry.isDirectory() && entry.name.startsWith("senpi-rpc-host-internal-"))
				.map(async (entry) => {
					try {
						const owner = JSON.parse(await readFile(join(tmpdir(), entry.name, ".owner"), "utf8")) as {
							pid?: unknown;
							processStartTime?: unknown;
							createdAt?: unknown;
						};
						if (
							typeof owner.pid === "number" &&
							typeof owner.processStartTime === "string" &&
							typeof owner.createdAt === "number" &&
							owner.processStartTime.length > 0 &&
							owner.createdAt < Date.now() - 60_000 &&
							(await readdir(join(tmpdir(), entry.name))).length === 1 &&
							!(await processMatchesPidFile({ pid: owner.pid, processStartTime: owner.processStartTime }).catch(
								(error: unknown) => {
									// Unreadable but live: assume the owner is alive rather than steal its lock.
									if (error instanceof ProcessIdentityUnreadableError) return true;
									throw error;
								},
							))
						)
							await rm(join(tmpdir(), entry.name), { recursive: true, force: true });
					} catch {}
				}),
		);
	} catch {}
}

async function appendStderr(paths: HostDaemonPaths, message: string): Promise<string> {
	try {
		const stderr = (await readFile(paths.stderrLog, "utf8")).trim();
		return stderr ? `${message}\n${stderr}` : message;
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT")) return message;
		throw error;
	}
}

function createSocketLockName(socket: string): string {
	return createHash("sha256")
		.update(resolveSocketTransportAddress(socket, process.platform), "utf8")
		.digest("hex")
		.slice(0, 32);
}

function normalizeSocketPath(value: string): string {
	if (value.startsWith("unix://")) return value.slice("unix://".length);
	return value;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function assertNever(value: never): never {
	throw new Error(`unreachable host decision: ${JSON.stringify(value)}`);
}
