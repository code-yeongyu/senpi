/** Starting a fresh generation for `ensureHost`: settings first, then the supervisor, its pidfile, its readiness. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { engineBuildIdentity } from "../../core/engine-build-identity.ts";
import { type DaemonPidFile, readProcessStartTime, waitForStartTime } from "../../utils/process-identity.ts";
import { generationPaths, type HostDaemonPaths } from "./host-daemon-paths.ts";
import { clearHostRegistration, writeHostRegistration } from "./host-daemon-registration.ts";
import { callerHostOwner, writeHostOwner, writeHostSettings } from "./host-daemon-state.ts";
import { HOST_PROTOCOL_VERSION, REQUIRED_HOST_CAPABILITIES } from "./host-decision.ts";
import { hostChildArgv, isCompatible } from "./host-ensure-client.ts";
import {
	announceStop,
	DEFAULT_STOP_TIMEOUT_MS,
	delay,
	ensureSender,
	isNodeErrorCode,
	recordEscalation,
	SIGKILL_GRACE_MS,
	type StopTarget,
	signalPid,
	stopSpawnedChild,
} from "./host-ensure-stop.ts";
import type { EnsuredHost, EnsureHostOptions } from "./host-ensure-types.ts";
import { defaultHostLaunch, PINNED_HOST_CLIENT_CAPABILITIES } from "./host-launch.ts";
import { DEFAULT_HOST_IDLE_EXIT_MS } from "./host-lifecycle.ts";
import { keepOwnerPipe, OWNER_WATCH_FD } from "./host-lifecycle-launch.ts";
import { type ChildExit, pollProtocolInfo } from "./host-readiness.ts";
import { initialHostEnvironment } from "./host-spawn-environment.ts";
import { hostLaunchProfile } from "./protocol-identity.ts";
import { ensureSocketSecret, socketSecretPath } from "./socket-transport.ts";
import { relayPresenterBootstrap } from "./mcp-presenter-bootstrap.ts";
import { type EndpointReservationStore, openEndpointReservationStore } from "./endpoint-reservation-store.ts";
import { hostEnsureLockTarget } from "./host-ensure-lock.ts";
import {
	grantClaimedParticipant,
	IDENTITY_OBSERVATION_PROBE_MS,
	offerSupervisorLaunch,
	reservationStorePath,
} from "./host-launch-reservation.ts";
import { resolvePresenceRoot } from "./presence-placement.ts";
import { loadPresencePlacement } from "./socket-secret-native.ts";

export const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
export { DEFAULT_STOP_TIMEOUT_MS };

/**
 * `generation` is 0 for a fresh endpoint; a start that leaves a stranded generation running beside
 * the new one numbers it after that generation, as a handoff would.
 */
export async function startHost(
	paths: HostDaemonPaths,
	socket: string,
	options: EnsureHostOptions,
	generation = 0,
): Promise<EnsuredHost> {
	const testOptions = options._test;
	const lifetimeOwner = options.owner ? await callerHostOwner() : null;
	// The generation this ensure is about to spawn, chosen HERE so its directory exists before the
	// host boots and the pointer can name it the moment the host is registered.
	const instanceId = randomUUID();
	const stopTarget = (reason: string): StopTarget => ({
		daemonDir: paths.dir,
		generation: generationPaths(paths, instanceId),
		instanceId,
		sender: ensureSender(),
		reason,
	});
	// The settings file must exist before the supervisor reads it at boot, so it
	// records the policy before the spawn instead of beside the pidfile. A valid public
	// secret belongs to the endpoint, not to this start: clients that already read it
	// derive the pipe name from it, so a start reuses it and never rotates it.
	const publicSecret = process.platform === "win32" ? await ensureSocketSecret(socketSecretPath(socket)) : undefined;
	await writeHostSettings(paths, {
		socket,
		capabilities: PINNED_HOST_CLIENT_CAPABILITIES,
		coldStart: options.policy?.coldStart ?? "transient",
		idleExitMs: options.policy?.idleExitMs ?? DEFAULT_HOST_IDLE_EXIT_MS,
		generation,
		instanceId,
	});
	await writeHostOwner(generationPaths(paths, instanceId).dir, lifetimeOwner);
	// A stranded generation is still writing its diagnostics here; only a fresh endpoint starts over.
	const stderr = await open(paths.stderrLog, generation === 0 ? "w" : "a", 0o600);
	let pidFile: DaemonPidFile | undefined;
	let child: ReturnType<typeof spawn> | undefined;
	let exitedEarly: ChildExit | undefined;
	let childExit: Promise<ChildExit> | undefined;
	let presenterEnrollment: Promise<void> | undefined;
	let reservation: Awaited<ReturnType<typeof reserveSupervisorLaunch>> | undefined;
	try {
		// A Windows public endpoint launches its supervisor through a reservation (#4199 design 4.2a): the supervisor
		// claims its role and starts only once this process, the issuer, has verified and granted it. Reserved inside
		// this try, so every failure after it, up to and including readiness, fences the generation it left behind.
		reservation = publicSecret ? await reserveSupervisorLaunch(socket) : undefined;
		const supervisorArgs = [
			"--socket",
			socket,
			...(options.owner ? ["--owner-fd", String(OWNER_WATCH_FD)] : []),
			...(options.presenterBootstrap ? ["--mcp-presenter-fd", "4"] : []),
			...(options.mcpPresenterEnforcement ? ["--mcp-presenter-enforcement"] : []),
			...(options.hostArgs ?? []),
			...(reservation?.args ?? []),
		];
		const launch = testOptions?.spawn ?? testOptions?.launch?.(supervisorArgs) ?? defaultHostLaunch(supervisorArgs);
		child = spawn(launch.command, [...launch.args], {
			detached: true,
			windowsHide: true,
			env: initialHostEnvironment({
				agentDir: options.agentDir,
				env: options.env,
				paths,
				instanceId,
				generation,
			}),
			stdio: options.presenterBootstrap
				? ["ignore", "ignore", stderr.fd, options.owner ? "pipe" : "ignore", "pipe"]
				: options.owner
					? ["ignore", "ignore", stderr.fd, "pipe"]
					: ["ignore", "ignore", stderr.fd],
		});
		if (options.presenterBootstrap) presenterEnrollment = relayPresenterBootstrap(options.presenterBootstrap, child);
		childExit = new Promise((resolveExit) => {
			child!.once("exit", (code, signal) => {
				exitedEarly = { code, signal };
				resolveExit(exitedEarly);
			});
		});
		if (options.owner) keepOwnerPipe(child);
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
		if (reservation && publicSecret) {
			// The claimant is observed with the bounded retry (two probes inside the claim deadline), each probe given the
			// time a loaded runner's CIM read needs; a test's probe keeps its own behavior. A failure here lands in the
			// catch below, which fences the generation and closes the store.
			await grantClaimedParticipant(
				reservation.store,
				reservation.generation,
				"supervisor",
				reservation.issuer,
				publicSecret,
				testOptions?.readProcessStartTime
					? (pid) => probe(pid)
					: (pid) => readProcessStartTime(pid, process.platform, IDENTITY_OBSERVATION_PROBE_MS),
				{ deadlineMs: SUPERVISOR_CLAIM_DEADLINE_MS },
			);
		}
		pidFile = { pid: child.pid, processStartTime: processStartTime ?? null };
		await testOptions?.beforePidFileWrite?.();
		await writeHostRegistration(paths, {
			record: pidFile,
			socket,
			instanceId,
			generation,
			launchProfileId: hostLaunchProfile(hostChildArgv(options.hostArgs ?? []), process.cwd()).profile_id,
			build: engineBuildIdentity(),
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
		if (!exitedBeforeCleanup && child?.pid !== undefined && childExit) {
			await stopUnregisteredStart(child, childExit, stopTarget("start_failed"));
		}
		// The durable fence of a failed start (design 4.2a "Crash, cancellation and commit"): stopping the spawned
		// wrapper proves nothing about a descendant that claimed, so the generation is cancelled, which revokes its
		// offers and refuses every later grant and pre-listen intent. The fence's own failure never replaces the error.
		const fence = reservation ? await fenceFailedStart(reservation) : undefined;
		if (!exitedBeforeCleanup) {
			await clearHostRegistration(paths);
			throw withFenceFailure(error, fence);
		}
		const diagnostic = await appendStderr(
			paths,
			`RPC socket host exited with code ${exitedBeforeCleanup.code ?? "null"}${exitedBeforeCleanup.signal ? ` (${exitedBeforeCleanup.signal})` : ""} before answering get_protocol_info`,
		);
		await clearHostRegistration(paths);
		throw new Error(fence === undefined ? diagnostic : `${diagnostic} (${fence})`);
	} finally {
		await stderr.close();
	}
	const readinessTimeoutMs = testOptions?.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
	const result = await pollProtocolInfo(socket, readinessTimeoutMs, isCompatible, childExit);
	if (result.ready) {
		if (reservation) {
			try {
				reservation.store.markServing(reservation.generation);
			} finally {
				reservation.store.close();
			}
		}
		await presenterEnrollment;
		return { pid: pidFile.pid, socket, reused: false, release: result.hold.release };
	}
	await testOptions?.beforeReadinessTeardown?.();
	// Readiness failed with the supervisor granted: its generation is fenced the same way, before the child is stopped,
	// so a granted descendant of the wrapper cannot bind after this start has reported failure.
	const fence = reservation ? await fenceFailedStart(reservation) : undefined;
	// Teardown runs for the diagnostic's sake, so it must never replace it: a stop failure here
	// (unreadable identity, a host that outlives SIGKILL) would otherwise propagate instead of the
	// readiness message and skip the registration cleanup below. This child is ours and its handle is
	// still attached: stop it through the handle, never through a re-probed pidfile identity.
	const stopFailure = await stopSpawnedChild(
		child,
		childExit,
		testOptions?.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
		stopTarget("readiness_timeout"),
	).then(
		() => undefined,
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
	const message = result.protocol
		? `RPC socket host answered get_protocol_info with protocolVersion ${result.protocol.protocolVersion}, serverVersion ${result.protocol.serverVersion} and capabilities ${JSON.stringify(result.protocol.capabilities)}, but is incompatible with protocol version ${HOST_PROTOCOL_VERSION} and required capabilities ${JSON.stringify(REQUIRED_HOST_CAPABILITIES)}`
		: result.exited
			? `RPC socket host exited with code ${result.exited.code ?? "null"}${result.exited.signal ? ` (${result.exited.signal})` : ""} before answering get_protocol_info`
			: `spawned RPC socket host did not answer get_protocol_info within ${readinessTimeoutMs}ms`;
	const notes = [
		...(stopFailure === undefined ? [] : [`teardown also reported: ${stopFailure}`]),
		...(fence === undefined ? [] : [fence]),
	];
	const diagnostic = await appendStderr(paths, notes.length === 0 ? message : `${message} (${notes.join("; ")})`);
	// The record of that teardown is already written: clearing the registration removes the
	// generation directory, and with it the intent the record cites.
	await clearHostRegistration(paths);
	// The supervisor may have failed before binding, or another owner may have
	// appeared while readiness was being checked. Never unlink an endpoint we
	// cannot prove this start owned.
	throw new Error(diagnostic);
}

/** A start that failed before its registration: SIGTERM, a 2 s grace, SIGKILL, and the record of it. */
async function stopUnregisteredStart(
	child: ReturnType<typeof spawn>,
	childExit: Promise<ChildExit>,
	target: StopTarget,
): Promise<void> {
	const pid = child.pid;
	const running = () => child.exitCode === null && child.signalCode === null;
	if (pid === undefined || !running()) return;
	const announced = await announceStop(target, pid);
	try {
		signalPid(pid, "SIGTERM");
	} catch {}
	await Promise.race([childExit, delay(2_000)]);
	if (!running()) return;
	try {
		signalPid(pid, "SIGKILL");
	} catch {}
	const gone = await Promise.race([childExit.then(() => true), delay(SIGKILL_GRACE_MS).then(() => false)]);
	if (gone) await recordEscalation(target, announced);
}

export async function appendStderr(paths: HostDaemonPaths, message: string): Promise<string> {
	try {
		const stderr = (await readFile(paths.stderrLog, "utf8")).trim();
		return stderr ? `${message}\n${stderr}` : message;
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT")) return message;
		throw error;
	}
}

/** How long the issuer waits for the launched supervisor to claim its role; the claimant's observation counts. */
const SUPERVISOR_CLAIM_DEADLINE_MS = 10_000;

/**
 * Cancels the generation of a failed start and closes its store. Returns the fence's own failure as text, for the
 * caller to report beside the start's diagnostic; it never throws, so no fence failure replaces the original error.
 */
async function fenceFailedStart(reservation: {
	readonly store: EndpointReservationStore;
	readonly generation: string;
}): Promise<string | undefined> {
	try {
		reservation.store.cancel(reservation.generation);
		return undefined;
	} catch (error: unknown) {
		return `reservation fence also failed: ${error instanceof Error ? error.message : String(error)}`;
	} finally {
		reservation.store.close();
	}
}

/** The original error, with a failed fence noted on its message; the error object itself is what callers compare. */
function withFenceFailure(error: unknown, fence: string | undefined): unknown {
	if (fence !== undefined && error instanceof Error) error.message = `${error.message} (${fence})`;
	return error;
}

/**
 * Opens the endpoint's reservation store beside its lock, resolves the presence root once (#4199 design 4.2a
 * "Placement."), reserves a generation recording it, and offers the supervisor role with its presence object
 * predeclared, all before the supervisor is spawned.
 */
async function reserveSupervisorLaunch(socket: string) {
	const target = hostEnsureLockTarget(socket);
	const store = await openEndpointReservationStore(reservationStorePath(socket));
	// An unreadable own start time is recorded as unverified; it never decides a grant, which checks the claimant.
	const issuer = {
		pid: process.pid,
		processStartTime: (await readProcessStartTime(process.pid).catch(() => undefined)) ?? null,
	};
	const native = loadPresencePlacement();
	// The lock target is named by the canonical endpoint identity, which also keys a relocated per-user root.
	const reservation = resolvePresenceRoot({ coordinationTarget: target, endpointKey: basename(target), native });
	try {
		const { generation, args } = offerSupervisorLaunch(store, socket, issuer, { reservation, native });
		return { store, issuer, generation, args };
	} catch (error: unknown) {
		// Nothing was offered to anyone (a failed predeclaration fenced its generation itself): the store is closed and
		// the error is the start's.
		store.close();
		throw error;
	}
}
