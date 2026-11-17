/** Starting a fresh generation for `ensureHost`: settings first, then the supervisor, its pidfile, its readiness. */
import { spawn } from "node:child_process";
import { spawnWithPrivateFds } from "../../private-fd-spawn.ts";
import { randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { engineBuildIdentity } from "../../core/engine-build-identity.ts";
import { type DaemonPidFile, readProcessStartTime, waitForStartTime } from "../../utils/process-identity.ts";
import { generationPaths, type HostDaemonPaths } from "./host-daemon-paths.ts";
import { clearHostRegistration, writeHostRegistration } from "./host-daemon-registration.ts";
import { callerHostOwner, writeHostOwner, writeHostSettings } from "./host-daemon-state.ts";
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
import type { ChildExit } from "./host-readiness.ts";
import { newStartupAttempt } from "./host-startup-events.ts";
import { clearStartupIntent, settleStartupIntent, writeStartupIntent } from "./host-startup-intent.ts";
import { finalizeFailedStart } from "./host-startup-finalizer.ts";
import { beginStartupAttempt, driveStartupToReady, exitMessage, type StartupAttempt } from "./host-startup-run.ts";
import { initialHostEnvironment } from "./host-spawn-environment.ts";
import { hostLaunchProfile } from "./protocol-identity.ts";
import { ensureSocketSecret, socketSecretPath } from "./socket-transport.ts";
import { relayPresenterBootstrap } from "./mcp-presenter-bootstrap.ts";

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
	// A start that died holding this lock may have left a candidate running: settle it first (senpi#4602).
	await settleStartupIntent(paths, socket, testOptions?.readProcessStartTime);
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
	if (process.platform === "win32") await ensureSocketSecret(socketSecretPath(socket));
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
	let presenterEnrollment: Promise<unknown> | undefined;
	let attempt: StartupAttempt | undefined;
	try {
		const supervisorArgs = [
			"--socket",
			socket,
			...(options.owner ? ["--owner-fd", String(OWNER_WATCH_FD)] : []),
			...(options.presenterBootstrap ? ["--mcp-presenter-fd", "4"] : []),
			...(options.mcpPresenterEnforcement ? ["--mcp-presenter-enforcement"] : []),
			...(options.hostArgs ?? []),
		];
		const launch = testOptions?.spawn ??
			testOptions?.launch?.(supervisorArgs) ?? {
				...defaultHostLaunch(supervisorArgs),
				reportsStartup: true,
			};
		const nonce = newStartupAttempt();
		await writeStartupIntent(paths.dir, {
			attempt: nonce,
			instanceId,
			generation,
			launcher: { pid: process.pid, processStartTime: null },
			writtenAt: Date.now(),
		});
		attempt = beginStartupAttempt({
			socket,
			instanceId,
			generation,
			attempt: nonce,
			coordinated: "reportsStartup" in launch && launch.reportsStartup === true,
			...(testOptions?.readinessTimeoutMs ? { decisionBudgetMs: testOptions.readinessTimeoutMs } : {}),
		});
		// The fillers are decided by the stdio, and the hand-off in the environment names them: stdio first.
		const base: ("ignore" | "pipe" | number)[] = options.presenterBootstrap
			? ["ignore", "ignore", stderr.fd, options.owner ? "pipe" : "ignore", "pipe"]
			: options.owner
				? ["ignore", "ignore", stderr.fd, "pipe"]
				: ["ignore", "ignore", stderr.fd];
		const stdio = attempt.stdio(base);
		child = spawnWithPrivateFds(spawn, launch.command, [...launch.args], {
			detached: true,
			windowsHide: true,
			env: {
				...initialHostEnvironment({
					agentDir: options.agentDir,
					env: options.env,
					paths,
					instanceId,
					generation,
				}),
				...attempt.env,
			},
			stdio,
		});
		if (options.presenterBootstrap)
			presenterEnrollment = relayPresenterBootstrap(options.presenterBootstrap, child, {
				kind: "initial",
				predecessorHostInstance: null,
			});
		childExit = new Promise((resolveExit) => {
			child!.once("exit", (code, signal) => {
				exitedEarly = { code, signal };
				resolveExit(exitedEarly);
			});
		});
		attempt.attach(child, childExit);
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
		pidFile = { pid: child.pid, processStartTime: processStartTime ?? null };
		await writeStartupIntent(paths.dir, {
			attempt: attempt.binding.attempt,
			instanceId,
			generation,
			launcher: { pid: process.pid, processStartTime: null },
			child: pidFile,
			writtenAt: Date.now(),
		});
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
		const cause = error instanceof Error ? error : new Error(String(error));
		attempt?.controller.fail(cause);
		// Keep the ChildProcess handle owned until registration succeeds. If startup
		// fails before the pidfile is written, terminate this exact child through
		// its still-attached handle rather than leaving an unmanaged daemon behind.
		const spawned = child;
		const exit = childExit;
		const report = await finalizeFailedStart(
			{ kind: "failed", phase: "supervisor_bootstrap", cause, elapsedMs: 0 },
			() =>
				exitedBeforeCleanup || spawned?.pid === undefined || !exit
					? Promise.resolve()
					: stopUnregisteredStart(spawned, exit, stopTarget("start_failed")),
		);
		if (report.cleanup === "completed") await clearStartupIntent(paths.dir);
		await clearHostRegistration(paths);
		if (!exitedBeforeCleanup) {
			if (report.cleanup === "completed") throw error;
			throw new Error(report.detail, { cause: error });
		}
		throw new Error(await appendStderr(paths, exitMessage(exitedBeforeCleanup)));
	} finally {
		await stderr.close();
	}
	const result = await driveStartupToReady({ attempt, socket, childExit, presenterEnrollment, isCompatible });
	if (result.ready) {
		await clearStartupIntent(paths.dir);
		return { pid: pidFile.pid, socket, reused: false, release: result.hold.release };
	}
	await testOptions?.beforeReadinessTeardown?.();
	// Teardown runs for the diagnostic's sake, so it must never replace it: the finalizer keeps the original
	// cause first and appends a cleanup failure after it. This child is ours and its handle is still attached:
	// stop it through the handle, never through a re-probed pidfile identity.
	const spawned = child;
	const report = await finalizeFailedStart(result.outcome, () =>
		stopSpawnedChild(
			spawned,
			childExit,
			testOptions?.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
			stopTarget("readiness_timeout"),
		),
	);
	const diagnostic = await appendStderr(paths, report.detail);
	// The record of that teardown is already written: clearing the registration removes the generation
	// directory, and with it the intent the record cites. A child whose exit cleanup could not prove keeps its
	// registration and startup intent, so no later writer reads it as gone (A-amended section 6).
	if (report.cleanup === "completed") {
		await clearHostRegistration(paths);
		await clearStartupIntent(paths.dir);
	}
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
	if (!gone) throw new Error(`RPC socket host pid ${pid} remained alive after SIGKILL`);
	await recordEscalation(target, announced);
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
