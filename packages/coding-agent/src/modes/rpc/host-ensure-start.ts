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
import { keepOwnerPipe, OWNER_WATCH_FD, parseSupervisorArgs } from "./host-lifecycle-launch.ts";
import { type ChildExit, pollProtocolInfo } from "./host-readiness.ts";
import { initialHostEnvironment } from "./host-spawn-environment.ts";
import { hostLaunchProfile } from "./protocol-identity.ts";
import { ensureSocketSecret, socketSecretPath } from "./socket-transport.ts";
import { relayPresenterBootstrap } from "./mcp-presenter-bootstrap.ts";
import { type EndpointReservationStore, openEndpointReservationStore } from "./endpoint-reservation-store.ts";
import { hostEnsureLockTarget } from "./host-ensure-lock.ts";
import {
	acquireOwnerPresence,
	grantClaimedParticipant,
	IDENTITY_OBSERVATION_PROBE_MS,
	type LaunchRoute,
	offerSupervisorLaunch,
	ownLaunchRoute,
	releaseReservingOwner,
	reservationStorePath,
	selectLaunchRoute,
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
	// A Windows public endpoint launches its supervisor through a reservation (#4199 design 4.2a), and its reserving
	// owner holds its own presence lock before it mutates the credential and before it persists the reservation
	// ("Acquire before authority"). A busy or unknown acquisition ends the start here. The supervisor is this build, which
	// reports both launch capabilities on Windows only; the route of an explicit host command is settled first, before
	// anything is locked, mutated or reserved (design section 5, "Mixed versions").
	const reserving = ownLaunchRoute() === "reservation";
	const hostRoute = reserving ? await hostLaunchRoute(socket, options.hostArgs ?? []) : undefined;
	const owner = reserving ? acquireReservingOwner(socket) : undefined;
	// The settings file must exist before the supervisor reads it at boot, so it
	// records the policy before the spawn instead of beside the pidfile. A valid public
	// secret belongs to the endpoint, not to this start: clients that already read it
	// derive the pipe name from it, so a start reuses it and never rotates it.
	let publicSecret: Buffer | undefined;
	try {
		publicSecret = owner ? await ensureSocketSecret(socketSecretPath(socket)) : undefined;
	} catch (error: unknown) {
		// No reservation names the owner's object yet: its handle is unused.
		owner?.presence.release();
		throw error;
	}
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
		// The supervisor claims its role and starts only once this process, the issuer, has verified and granted it.
		// Reserved inside this try, so every failure after it, up to and including readiness, fences the generation it
		// left behind; a start that fails after the reservation persisted keeps the owner's lock until this process exits.
		reservation =
			owner && publicSecret
				? await reserveSupervisorLaunch(
						socket,
						owner,
						hostRoute === "reservation" ? ["supervisor", "host"] : ["supervisor"],
					)
				: undefined;
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
				// Serving is the owner's last action in this generation: it commits its `released`, then closes its guard.
				releaseReservingOwner(reservation.store, reservation.generation, reservation.issuer, reservation.presence);
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
 * Resolves the presence root once (#4199 design 4.2a "Placement.") and acquires the reserving owner's own presence
 * object in it. A root recorded `presence_unavailable` holds no lock and never refuses the start.
 */
function acquireReservingOwner(socket: string) {
	const target = hostEnsureLockTarget(socket);
	const native = loadPresencePlacement();
	// The lock target is named by the canonical endpoint identity, which also keys a relocated per-user root.
	const reservation = resolvePresenceRoot({ coordinationTarget: target, endpointKey: basename(target), native });
	return { target, native, reservation, presence: acquireOwnerPresence(reservation, native) };
}

/**
 * The host hop's route (#4199 design section 5, "Mixed versions"): the default host is this build, and an explicit
 * `--child-command` is another runtime whose own launch-capability result decides. A legacy host keeps its legacy launch
 * under a parent-admitted supervisor, so the generation does not expect its role; an unreadable result fails the start.
 */
async function hostLaunchRoute(socket: string, hostArgs: readonly string[]): Promise<LaunchRoute> {
	const launch = parseSupervisorArgs(["--socket", socket, ...hostArgs]);
	if (!launch?.childCommand) return ownLaunchRoute();
	return selectLaunchRoute({ command: launch.childCommand, args: launch.childArgs ?? [] });
}

/**
 * Opens the endpoint's reservation store beside its lock, reserves a generation recording the presence root and the
 * owner's held object, and offers the supervisor role with its presence object predeclared, all before the supervisor
 * is spawned.
 */
async function reserveSupervisorLaunch(
	socket: string,
	owner: ReturnType<typeof acquireReservingOwner>,
	expectedRoles: readonly ("supervisor" | "host")[],
) {
	const store = await openEndpointReservationStore(reservationStorePath(socket)).catch((error: unknown) => {
		owner.presence.release();
		throw error;
	});
	// An unreadable own start time is recorded as unverified; it never decides a grant, which checks the claimant.
	const issuer = {
		pid: process.pid,
		processStartTime: (await readProcessStartTime(process.pid).catch(() => undefined)) ?? null,
	};
	try {
		const { generation, args } = offerSupervisorLaunch(
			store,
			socket,
			issuer,
			{
				reservation: owner.reservation,
				native: owner.native,
				ownerPresence: owner.presence,
			},
			expectedRoles,
		);
		return { store, issuer, generation, args, presence: owner.presence };
	} catch (error: unknown) {
		// Nothing was offered to anyone (a failed reservation or predeclaration released or fenced its own authority):
		// the store is closed and the error is the start's.
		store.close();
		throw error;
	}
}
