import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getAgentDir } from "../../config.ts";
import { readProcessStartTime } from "../app-server/daemon/process.ts";
import {
	createDaemonDirectories,
	createHostDaemonPaths,
	ensureEndpointIdentity,
	generationPaths,
	type HostDaemonPaths,
	sameEndpoint,
} from "./host-daemon-paths.ts";
import {
	clearHostRegistration,
	type RegisteredHost,
	readHostRegistration,
	writtenByThisProcess,
} from "./host-daemon-registration.ts";
import { claimHostOwner } from "./host-daemon-state.ts";
import { decideHostAction, type HostDecision, HostEnsureRefusedError, type HostProtocolInfo } from "./host-decision.ts";
import { ensureClient } from "./host-ensure-client.ts";
import { publicEndpointAccepts, refuseIfStalled } from "./host-ensure-liveness.ts";
import { hostEnsureLockOptions, hostEnsureLockTarget } from "./host-ensure-lock.ts";
import { appendStderr, DEFAULT_READINESS_TIMEOUT_MS, DEFAULT_STOP_TIMEOUT_MS, startHost } from "./host-ensure-start.ts";
import { ensureSender, matchesPidFileOrUnknown, STOP_WAIT_BUDGET_MS, stopManagedHost } from "./host-ensure-stop.ts";
import type { EnsuredHost, EnsureHostOptions } from "./host-ensure-types.ts";
import { scheduleOpportunisticHostGc } from "./host-gc-pass.ts";
import { HANDOFF_LOCK_HOLD_MS, handoffHostLocked } from "./host-handoff.ts";
import { reapOrphanedInternalHostDirs } from "./host-internal-dir-reaper.ts";
import { retireIdleLegacyHost } from "./host-legacy.ts";
import type { HostColdStart, HostLifecyclePolicyInput } from "./host-lifecycle.ts";
import { holdProtocolInfo, probeSocketReachable } from "./host-probe.ts";
import { isHostGenerationProcess } from "./host-process-role.ts";
import { acquireOwnershipSafeLock } from "./ownership-safe-lock.ts";

export {
	createHostDaemonPaths,
	daemonDirectoryName,
	type HostDaemonPaths,
	HostDaemonStateError,
	type HostGenerationPaths,
} from "./host-daemon-paths.ts";
export { hostEnsureLockTarget } from "./host-ensure-lock.ts";
export type { EnsuredHost, EnsureHostOptions, HostUpgradePolicy } from "./host-ensure-types.ts";
export { defaultHostLaunch, PINNED_HOST_CLIENT_CAPABILITIES } from "./host-launch.ts";
export { type ProbeHostOptions, probeHost } from "./host-probe.ts";
export type { HostColdStart, HostLifecyclePolicyInput };

const EXISTING_HOST_PROBE_TIMEOUT_MS = 10_000;
/**
 * A lock waiter must outlast the longest critical section a holder can run:
 * probing an existing host, then either stopping an incompatible one (SIGTERM wait
 * plus the SIGKILL grace, or a supervisor's reported stall wait) and spawning the replacement and waiting for it to answer,
 * or handing it off (an upgrade) - which is also as long as a forced handoff holds it.
 * Each SQLite busy wait stays short because it blocks the event loop; this
 * cumulative budget is what covers the whole section, with headroom for a slow
 * runner. A waiter that gives up early surfaces as a raw "database is locked"
 * failure on the second of two concurrent starts.
 */
const ENSURE_LOCK_WAIT_MS =
	EXISTING_HOST_PROBE_TIMEOUT_MS +
	Math.max(STOP_WAIT_BUDGET_MS + DEFAULT_READINESS_TIMEOUT_MS, HANDOFF_LOCK_HOLD_MS) +
	10_000;
const lockOptions = hostEnsureLockOptions(ENSURE_LOCK_WAIT_MS);
export async function ensureHost(options: EnsureHostOptions): Promise<EnsuredHost> {
	const socket = normalizeSocketPath(options.socket);
	const paths = createHostDaemonPaths({ socket, ...(options.agentDir ? { agentDir: options.agentDir } : {}) });
	await createDaemonDirectories(paths);
	// The public socket is the shared resource; agent directories are not a
	// sufficient lock scope when two installations target the same endpoint.
	const lockTarget = hostEnsureLockTarget(socket);
	await mkdir(dirname(lockTarget), { recursive: true });
	await writeFile(lockTarget, "", { flag: "a", mode: 0o600 });
	// Opportunistic GC of other installs' leftovers stays OUTSIDE the endpoint lock.
	// Its cost scales with the whole tmpdir and, on win32, adds a ~1s process probe per
	// candidate; inside the critical section that inflated the hold for every concurrent
	// ensureHost until a waiter exhausted its budget and surfaced a raw "database is
	// locked". Its own guards (60s age, dead owner pid) already make it safe unlocked.
	await reapOrphanedInternalHostDirs();
	const release = await acquireOwnershipSafeLock(`${lockTarget}.lock`, lockOptions);
	let ensured: EnsuredHost;
	try {
		await options._test?.afterLockAcquired?.();
		ensured = await ensureHostLocked(paths, socket, options);
	} finally {
		await release();
	}
	// Off the awaited path and outside the lock: the caller gets its host first, then dead endpoint
	// records under this agent dir are reaped in the background on `host gc`'s own evidence.
	scheduleOpportunisticHostGc({ agentDir: options.agentDir ?? getAgentDir(), exclude: socket });
	return ensured;
}

async function ensureHostLocked(
	paths: HostDaemonPaths,
	socket: string,
	options: EnsureHostOptions,
): Promise<EnsuredHost> {
	// Under the lock, so a torn or foreign `endpoint.json` is repaired rather than left unaddressable.
	await ensureEndpointIdentity(paths, socket, { repair: true });
	const testOptions = options._test;
	const registered = await readHostRegistration(paths);
	// A record naming ANOTHER endpoint is not about this ensure's host. The per-socket directory
	// makes that structural, and the field stays as the second guard for a directory that was
	// somehow reused: a second socket must never read the first socket's daemon as its own.
	const registeredHere = registersSocket(registered, socket);
	// A reusable host is held from the connection that proved it compatible, never re-probed later.
	const held = await holdProtocolInfo(socket, EXISTING_HOST_PROBE_TIMEOUT_MS);
	const protocol = held?.info;
	const startedByUs =
		registeredHere && (await writtenByThisProcess(registered?.writer, testOptions?.readProcessStartTime));
	const attachedPid = registeredHere ? (registered?.record.pid ?? 0) : 0;
	const decision = decide(options, startedByUs, protocol);
	if (options.owner && held && (decision.action === "reuse" || decision.action === "handoff")) {
		try {
			if (!registeredHere || !registered || registered.instanceId !== held.info.instanceId)
				throw new Error("RPC host has no matching registered owner-lifetime generation");
			await claimHostOwner(generationPaths(paths, registered.instanceId).dir);
		} catch (cause) {
			held.hold.release();
			throw cause;
		}
	}
	if (decision.action === "reuse" && held) {
		// A compatible socket is attachable even when another client surface
		// started it. Only hosts we spawned are eligible for lifecycle management.
		return { pid: attachedPid, socket, reused: true, release: held.hold.release };
	}
	held?.hold.release();
	switch (decision.action) {
		case "reuse":
			throw new Error(`host at ${socket} was reused without answering its probe`);
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
	// The generation this start leaves RUNNING beside the new one, when there is one.
	let stranded: RegisteredHost | undefined;
	if (registered && pidMatches) {
		if (!startedByUs) {
			// I1: the socket is silent, but the process behind it is alive. Only the process that WROTE
			// this record may end it - anyone else refuses rather than signalling somebody else's host.
			if (await publicEndpointAccepts(socket)) throw new HostEnsureRefusedError(socket, "foreign_writer", protocol);
			await refuseIfStalled(paths, registered.instanceId, socket, protocol);
			// A foreign record whose public endpoint accepts NOTHING names a generation nobody can reach:
			// its entry was replaced (so it is already draining, #1893) or removed, or a dead listener
			// left the entry behind. Refusing here locked every client out until that process happened
			// to exit (#1936). Binding a fresh generation there signals nothing, so that is what happens -
			// the stranded one keeps its record.
			stranded = registered;
		} else {
			// Silent is not the same as gone. A host serving many sessions can miss a probe budget
			// while its event loop is busy; its socket still ACCEPTS the connection. Ending it then
			// would destroy every live session to replace a host that was never broken, so a
			// reachable socket is refused instead of signalled - the caller retries or falls back.
			if (await probeSocketReachable(socket, EXISTING_HOST_PROBE_TIMEOUT_MS)) {
				throw new HostEnsureRefusedError(socket, "host_busy", protocol);
			}
			await refuseIfStalled(paths, registered.instanceId, socket, protocol);
			await stopManagedHost(
				registered.record,
				testOptions?.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
				{
					daemonDir: paths.dir,
					generation: generationPaths(paths, registered.instanceId),
					instanceId: registered.instanceId,
					sender: ensureSender(),
					reason: "replace_unreachable",
				},
				probe,
			);
		}
	}
	// A host from before this layout registered itself in the FLAT directory. Its files are another
	// process's state: never read as ours, never removed. While it is alive this ensure never starts
	// beside it: an idle one is drained and waited out (#2423), a busy or unprovable one is refused.
	const legacyRefusal = await retireIdleLegacyHost(
		paths,
		probe,
		testOptions?.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
	);
	if (legacyRefusal !== undefined) throw new HostEnsureRefusedError(socket, "legacy_host", protocol, legacyRefusal);
	if (stranded !== undefined) return startHost(paths, socket, options, stranded.generation + 1);
	if (registeredHere) await clearHostRegistration(paths);
	return startHost(paths, socket, options);
}

/** `fallback` belongs to clients that can live without a host; an ensure must produce one or fail. */
function decide(
	options: EnsureHostOptions,
	startedByUs: boolean,
	protocol: HostProtocolInfo | undefined,
): Exclude<HostDecision, { action: "fallback" }> {
	if (options.upgrade !== "if-engine-differs" || isHostGenerationProcess()) {
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
	const result = await handoffHostLocked({
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
	if (result.action === "handoff")
		return { pid: result.pid, socket, reused: false, release: await holdEnsured(socket) };
	await appendStderr(
		paths,
		`generation handoff refused: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`,
	);
	return { pid: attachedPid, socket, reused: true, release: await holdEnsured(socket) };
}

/** The attach hold for a host another step already proved ready (a handoff successor, a refused handoff). */
async function holdEnsured(socket: string): Promise<() => void> {
	const held = await holdProtocolInfo(socket, EXISTING_HOST_PROBE_TIMEOUT_MS);
	if (!held) throw new Error(`RPC socket host at ${socket} stopped answering before this ensure could hold it`);
	return held.hold.release;
}

/** Whether a registration is about this endpoint. A record written before the field existed is. */
function registersSocket(registered: RegisteredHost | undefined, socket: string): boolean {
	if (registered === undefined) return false;
	return registered.socket === undefined || sameEndpoint(registered.socket, socket);
}

function normalizeSocketPath(value: string): string {
	if (value.startsWith("unix://")) return value.slice("unix://".length);
	return value;
}

function assertNever(value: never): never {
	throw new Error(`unreachable host decision: ${JSON.stringify(value)}`);
}
