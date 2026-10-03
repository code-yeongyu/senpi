/**
 * HOW an ensure starts a generation: settings before the spawn, the supervisor launch, its
 * registration, and the readiness gate - with every teardown of a start that failed going through
 * the recorded stop path (senpi#2566). Split out of `host-ensure.ts`.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type DaemonPidFile,
	ProcessIdentityUnreadableError,
	processMatchesPidFile,
	readProcessStartTime,
	waitForStartTime,
} from "../app-server/daemon/process.ts";
import { generationPaths, type HostDaemonPaths } from "./host-daemon-paths.ts";
import { clearHostRegistration, writeHostRegistration } from "./host-daemon-registration.ts";
import { writeHostSettings } from "./host-daemon-state.ts";
import { HOST_PROTOCOL_VERSION, REQUIRED_HOST_CAPABILITIES } from "./host-decision.ts";
import { hostChildArgv, isCompatible } from "./host-ensure-client.ts";
import {
	announceStop,
	DEFAULT_STOP_TIMEOUT_MS,
	delay,
	ensureSender,
	recordEscalation,
	SIGKILL_GRACE_MS,
	type StopTarget,
	signalPid,
	stopSpawnedChild,
} from "./host-ensure-stop.ts";
import type { EnsuredHost, EnsureHostOptions } from "./host-ensure-types.ts";
import { defaultHostLaunch, PINNED_HOST_CLIENT_CAPABILITIES } from "./host-launch.ts";
import { DEFAULT_HOST_IDLE_EXIT_MS } from "./host-lifecycle-policy.ts";
import { type ChildExit, pollProtocolInfo } from "./host-readiness.ts";
import { initialHostEnvironment } from "./host-spawn-environment.ts";
import { hostLaunchProfile } from "./protocol-identity.ts";
import { createSocketSecret, socketSecretPath } from "./socket-transport.ts";

const DEFAULT_READINESS_TIMEOUT_MS = 10_000;

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
	// records the policy before the spawn instead of beside the pidfile.
	if (process.platform === "win32") await createSocketSecret(socketSecretPath(socket));
	await writeHostSettings(paths, {
		socket,
		capabilities: PINNED_HOST_CLIENT_CAPABILITIES,
		coldStart: options.policy?.coldStart ?? "transient",
		idleExitMs: options.policy?.idleExitMs ?? DEFAULT_HOST_IDLE_EXIT_MS,
		generation,
		instanceId,
	});
	// A stranded generation is still writing its diagnostics here; only a fresh endpoint starts over.
	const stderr = await open(paths.stderrLog, generation === 0 ? "w" : "a", 0o600);
	let pidFile: DaemonPidFile | undefined;
	let child: ReturnType<typeof spawn> | undefined;
	let exitedEarly: ChildExit | undefined;
	let childExit: Promise<ChildExit> | undefined;
	try {
		const supervisorArgs = ["--socket", socket, ...(options.hostArgs ?? [])];
		const launch = testOptions?.spawn ?? testOptions?.launch?.(supervisorArgs) ?? defaultHostLaunch(supervisorArgs);
		const spawned = spawn(launch.command, [...launch.args], {
			detached: true,
			windowsHide: true,
			env: initialHostEnvironment({ agentDir: options.agentDir, env: options.env, paths, instanceId, generation }),
			stdio: ["ignore", "ignore", stderr.fd],
		});
		child = spawned;
		childExit = new Promise((resolveExit) => {
			spawned.once("exit", (code, signal) => {
				exitedEarly = { code, signal };
				resolveExit(exitedEarly);
			});
		});
		if (spawned.pid === undefined) throw new Error("failed to spawn RPC socket host");
		const probe = testOptions?.readProcessStartTime ?? readProcessStartTime;
		const observedStartTime = await Promise.race([
			waitForStartTime(spawned.pid, 10_000, probe),
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
		const processStartTime = observedStartTime ?? (await unhurriedProbe(spawned.pid).catch(() => undefined));
		// Still unreadable: the host is ours, alive, and about to prove itself on the socket, so it is
		// registered WITHOUT an ownership guard instead of being torn down for a starved probe. A
		// guard-less record never claims ownership and never authorizes a signal - every later caller
		// reads it as unknown - so the worst case is a fresh host next time, not a killed healthy one.
		pidFile = { pid: spawned.pid, processStartTime: processStartTime ?? null };
		await testOptions?.beforePidFileWrite?.();
		await writeHostRegistration(paths, {
			record: pidFile,
			socket,
			instanceId,
			generation,
			launchProfileId: hostLaunchProfile(hostChildArgv(options.hostArgs ?? []), process.cwd()).profile_id,
		});
		spawned.unref();
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
	const result = await pollProtocolInfo(socket, readinessTimeoutMs, isCompatible, childExit);
	if (result.ready) return { pid: pidFile.pid, socket, reused: false, release: result.hold.release };
	await testOptions?.beforeReadinessTeardown?.();
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
	const diagnostic = await appendStderr(
		paths,
		stopFailure === undefined ? message : `${message} (teardown also reported: ${stopFailure})`,
	);
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
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return message;
		throw error;
	}
}

export async function reapOrphanedInternalHostDirs(): Promise<void> {
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
