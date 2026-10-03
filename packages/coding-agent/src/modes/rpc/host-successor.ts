/**
 * Bringing up the SUCCESSOR generation: where it binds, what it is launched with, and the single
 * observation that proves it took the socket over.
 *
 * The successor binds `<public>.next-<gen>` - never the live public path, which it has no right to
 * unlink - and renames its own entry over the public path only while that path still holds the exact
 * socket this handoff was decided against (`--replace <dev>:<ino>`). Its own answer ON THE PUBLIC
 * SOCKET, reporting an `instanceId` different from the generation being replaced, is the only proof
 * the rename landed; an exit instead means it refused to replace a path that changed underneath and
 * left both sockets alone. The predecessor is asked to drain only AFTER that proof and after the
 * successor is registered - whether it may be asked at all was decided in `host-handoff.ts`, which
 * proved the owner and checked that the running host advertises it can survive the signal.
 *
 * A REFUSED handoff leaves the endpoint as it found it: the successor is killed and, once it has
 * exited, its generation record and directory are released, and the boot `settings.json` it
 * overwrote before spawning is put back byte for byte - so neither `status --all` nor the running
 * generation's next restart ever sees the successor that did not happen.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, rm, writeFile } from "node:fs/promises";
import { waitForStartTime } from "../app-server/daemon/process.ts";
import { generationPaths, HOST_STATE_FILE_MODE, type HostDaemonPaths } from "./host-daemon-paths.ts";
import { releaseGeneration, writeGenerationRecord, writeHostRegistration } from "./host-daemon-registration.ts";
import { readFileOrUndefined, readHostSettings, writeHostSettings } from "./host-daemon-state.ts";
import { announceStop, recordEscalation, type StopTarget, signalPid } from "./host-ensure-stop.ts";
import type { HandoffHostOptions, HandoffRefusal, HandoffResult } from "./host-handoff.ts";
import { defaultHostLaunch, PINNED_HOST_CLIENT_CAPABILITIES } from "./host-launch.ts";
import { DEFAULT_HOST_IDLE_EXIT_MS } from "./host-lifecycle.ts";
import { probeProtocolInfo } from "./host-probe.ts";
import type { HostProtocolInfo } from "./host-protocol-info.ts";
import { successorHostEnvironment } from "./host-spawn-environment.ts";
import { signalGeneration } from "./host-stop.ts";
import { hostLaunchProfile } from "./protocol-identity.ts";
import {
	generationBindPath,
	MAX_SOCKET_PATH_BYTES,
	type SocketFileIdentity,
	statSocketIdentity,
} from "./socket-ownership.ts";

/** How long the successor has to answer on the PUBLIC socket before the handoff is abandoned. */
const DEFAULT_HANDOFF_READINESS_MS = 30_000;

/** How long a refused handoff waits for the successor it killed to exit before releasing its record. */
const SUCCESSOR_EXIT_WAIT_MS = 5_000;

/** The longest `startSuccessor` runs: its start-time read, the readiness window, one last probe and a refusal's exit wait. */
export const SUCCESSOR_START_BUDGET_MS = 10_000 + DEFAULT_HANDOFF_READINESS_MS + 2_000 + SUCCESSOR_EXIT_WAIT_MS;

export async function startSuccessor(context: {
	options: HandoffHostOptions;
	paths: HostDaemonPaths;
	host: HostProtocolInfo;
	owner: { pid: number; processStartTime: string; instanceId: string };
}): Promise<HandoffResult> {
	const { options, paths, host, owner } = context;
	const generation = (host.generation ?? 0) + 1;
	// The successor's identity, chosen here so its generation directory holds its settings before it
	// boots and the pointer can name it the instant it answers on the public socket.
	const instanceId = randomUUID();
	const bindSocket = generationBindPath(options.socket, generation);
	if (Buffer.byteLength(bindSocket) > MAX_SOCKET_PATH_BYTES) {
		return { action: "refuse", reason: "socket_path_too_long", upgradeable: true, detail: bindSocket };
	}
	const replaced = await statSocketIdentity(options.socket);
	if (!replaced) return { action: "refuse", reason: "socket_replaced", upgradeable: true };
	// A handoff replaces the ENGINE, not the operator's lifecycle policy: the successor inherits
	// what the running generation was started with unless this caller states its own.
	const running = await readHostSettings(paths);
	const bootSettings = await readFileOrUndefined(paths.settingsFile);
	await writeHostSettings(paths, {
		socket: options.socket,
		capabilities: PINNED_HOST_CLIENT_CAPABILITIES,
		coldStart: options.policy?.coldStart ?? running?.coldStart ?? "transient",
		idleExitMs: options.policy?.idleExitMs ?? running?.idleExitMs ?? DEFAULT_HOST_IDLE_EXIT_MS,
		generation,
		instanceId,
	});
	// From the overwrite on, every exit is a refusal that puts the boot settings back: a failure BEFORE
	// the successor existed (the hook, the launch build, the stderr open, the spawn itself) has nothing
	// to kill or release, but the settings it already overwrote are not the successor's to keep.
	let child: ChildProcess | undefined;
	let exited: Promise<void> | undefined;
	try {
		await options._test?.beforeSpawn?.();
		const argv = [
			"--socket",
			options.socket,
			"--bind",
			bindSocket,
			"--replace",
			`${replaced.dev}:${replaced.ino}`,
			...(options.hostArgs ?? []),
		];
		const launch = (options._test?.launch ?? options.launch)?.(argv) ?? defaultHostLaunch(argv);
		const stderr = await open(paths.stderrLog, "a", 0o600);
		const spawned = spawn(launch.command, [...launch.args], {
			detached: true,
			windowsHide: true,
			env: successorHostEnvironment({
				agentDir: options.agentDir,
				env: options.env,
				expectedRuntimeBuildId: options.expectedRuntimeBuildId,
				paths,
				generation,
				instanceId,
			}),
			stdio: ["ignore", "ignore", stderr.fd],
		});
		await stderr.close();
		child = spawned;
		exited = new Promise<void>((resolve) => spawned.once("exit", () => resolve()));
		if (child.pid === undefined) throw new Error("failed to spawn the successor generation");
		const processStartTime = (await waitForStartTime(child.pid, 10_000).catch(() => undefined)) ?? null;
		const registration = {
			record: { pid: child.pid, processStartTime },
			socket: options.socket,
			instanceId,
			generation,
			launchProfileId: hostLaunchProfile(
				["--mode", "rpc", "--multi-session", ...(options.hostArgs ?? [])],
				process.cwd(),
			).profile_id,
		};
		// The successor is running from this instant, long before it binds anything: its own record says
		// so, so `host gc` never judges the endpoint by a predecessor that died meanwhile. The pointer is
		// NOT moved here - the predecessor still owns the socket until the rename lands.
		await writeGenerationRecord(paths, registration);
		await options._test?.afterSpawn?.(child.pid);
		const answer = await awaitSuccessor(options, host, exited);
		if (!answer) {
			const reason = await abortReason(options.socket, replaced);
			const cleanupFailure = await abandonSuccessor({
				child,
				exited,
				paths,
				instanceId,
				bootSettings,
				reason: "successor_readiness_timeout",
			});
			return { action: "refuse", reason, upgradeable: true, ...(cleanupFailure && { detail: cleanupFailure }) };
		}
		// The pointer moves to the successor only now: until the rename landed, the generation the
		// clients reach is still the predecessor, and the pointer has to name whoever owns the socket.
		await options._test?.beforeRegistration?.();
		await writeHostRegistration(paths, registration);
		child.unref();
		// The successor owns the socket now: the predecessor may drain. SIGUSR1 is sent only here,
		// to a pid the record proved and a host that advertised it can survive the signal. A
		// predecessor that exited on its own in the meantime is already drained, and the handoff it
		// was being asked to make room for has already happened.
		signalGeneration(owner.pid, "SIGUSR1");
		return {
			action: "handoff",
			pid: child.pid,
			socket: options.socket,
			generation: answer.generation ?? generation,
			instanceId: answer.instanceId ?? "",
		};
	} catch (cause) {
		const cleanupFailure = await abandonSuccessor({
			child,
			exited,
			paths,
			instanceId,
			bootSettings,
			reason: "successor_start_failed",
		});
		const detail = cause instanceof Error ? cause.message : String(cause);
		return {
			action: "refuse",
			reason: "successor_unavailable",
			upgradeable: true,
			detail: cleanupFailure ? `${detail}; ${cleanupFailure}` : detail,
		};
	}
}

/**
 * Undoes what a refused handoff left: kills the successor, releases its generation once it has exited
 * (a successor that never got a pid never ran, so its directory goes at once; one that outlives the wait
 * keeps its record until pruning finds it dead), and puts the boot settings back as they were. A
 * successor that was never spawned leaves only the boot settings to undo. A cleanup that fails is
 * answered, not thrown: the handoff still refused, and the caller is told why
 * the endpoint may not be as it was.
 */
async function abandonSuccessor(context: {
	/** Undefined when the successor was never spawned: nothing to kill or release. */
	child: ChildProcess | undefined;
	exited: Promise<void> | undefined;
	paths: HostDaemonPaths;
	instanceId: string;
	bootSettings: string | undefined;
	/** Why the successor is being killed: the stop intent and the record name it. */
	reason: string;
}): Promise<string | undefined> {
	const { child, exited, paths, instanceId, bootSettings } = context;
	const target: StopTarget = {
		daemonDir: paths.dir,
		generation: generationPaths(paths, instanceId),
		instanceId,
		sender: { pid: process.pid, kind: "successor" },
		reason: context.reason,
	};
	// A successor that cannot be asked to stop is killed outright; it runs no exit handler, so the
	// record of it is this process's to write, BEFORE its generation is released below.
	const killed =
		child?.pid !== undefined && child.exitCode === null && child.signalCode === null
			? await announceStop(target, child.pid)
			: undefined;
	if (killed !== undefined && child?.pid !== undefined) signalPid(child.pid, "SIGKILL");
	try {
		if (bootSettings === undefined) await rm(paths.settingsFile, { force: true });
		else await writeFile(paths.settingsFile, bootSettings, { mode: HOST_STATE_FILE_MODE });
		if (child?.pid === undefined) await rm(generationPaths(paths, instanceId).dir, { recursive: true, force: true });
		else if (exited !== undefined && (await exitedWithin(exited, SUCCESSOR_EXIT_WAIT_MS))) {
			if (killed !== undefined) await recordEscalation(target, killed);
			await releaseGeneration(paths, { instanceId, pid: child.pid });
		}
		return undefined;
	} catch (cause) {
		return `successor cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`;
	}
}

async function exitedWithin(exited: Promise<void>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([exited.then(() => true), timedOut]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The successor's own answer on the PUBLIC socket is the only proof the rename landed: it
 * reports a different `instanceId` than the generation being replaced. An exit instead means
 * the successor refused to replace the path (a foreign socket, a live bind path) and left it alone.
 */
async function awaitSuccessor(
	options: HandoffHostOptions,
	previous: HostProtocolInfo,
	exited: Promise<void>,
): Promise<HostProtocolInfo | undefined> {
	const deadline = Date.now() + (options._test?.readinessTimeoutMs ?? DEFAULT_HANDOFF_READINESS_MS);
	let childGone = false;
	void exited.then(() => {
		childGone = true;
	});
	while (Date.now() <= deadline) {
		const answer = await probeProtocolInfo(options.socket, 2_000);
		if (answer && answer.instanceId !== undefined && answer.instanceId !== previous.instanceId) return answer;
		if (childGone) return undefined;
		await delay(50);
	}
	return undefined;
}

/**
 * What actually stopped the handoff, read from the endpoint rather than guessed: a public path
 * that no longer holds the socket this handoff was decided against was taken by somebody else,
 * and the successor correctly refused to rename over it.
 */
async function abortReason(socket: string, replaced: SocketFileIdentity): Promise<HandoffRefusal> {
	const current = await statSocketIdentity(socket).catch(() => undefined);
	return current === undefined || current.dev !== replaced.dev || current.ino !== replaced.ino
		? "socket_replaced"
		: "successor_unavailable";
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
