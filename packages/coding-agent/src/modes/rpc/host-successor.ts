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
import { spawnWithPrivateFds } from "../../private-fd-spawn.ts";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { waitForStartTime } from "../../utils/process-identity.ts";
import { generationPaths, type HostDaemonPaths } from "./host-daemon-paths.ts";
import { type HostRegistration, writeGenerationRecord, writeHostRegistration } from "./host-daemon-registration.ts";
import {
	callerHostOwner,
	readFileOrUndefined,
	readHostOwner,
	readHostSettings,
	sameHostOwner,
	writeHostOwner,
	writeHostSettings,
} from "./host-daemon-state.ts";
import type { HandoffHostOptions, HandoffRefusal, HandoffResult } from "./host-handoff.ts";
import { defaultHostLaunch, PINNED_HOST_CLIENT_CAPABILITIES } from "./host-launch.ts";
import { DEFAULT_HOST_IDLE_EXIT_MS } from "./host-lifecycle.ts";
import { keepOwnerPipe, OWNER_WATCH_FD } from "./host-lifecycle-launch.ts";
import { probeProtocolInfo } from "./host-probe.ts";
import type { ChildExit } from "./host-readiness.ts";
import { settleCandidateAdoption } from "./host-endpoint-owner.ts";
import { abandonSuccessor } from "./host-successor-abandon.ts";
import { newStartupAttempt } from "./host-startup-events.ts";
import { beginStartupAttempt } from "./host-startup-run.ts";
import {
	adoptionGrant,
	driveSuccessorStartup,
	failureDetail,
	predecessorOwnerArgs,
	successorPresenter,
} from "./host-successor-startup.ts";
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

export async function startSuccessor(context: {
	options: HandoffHostOptions;
	paths: HostDaemonPaths;
	host: HostProtocolInfo;
	/** The predecessor's proven identity; `undefined` when nothing proves it, and then it is never signalled. */
	owner: { readonly pid: number } | undefined;
	/** Asked once the successor owns the socket: the drain request is sent only when it answers true. */
	drainGate?: () => Promise<boolean>;
}): Promise<HandoffResult> {
	const { options, paths, host, owner, drainGate } = context;
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
	const lifetimeOwner = host.instanceId ? await readHostOwner(generationPaths(paths, host.instanceId).dir) : null;
	const inheritOwnerPipe = lifetimeOwner?.pid === process.pid && sameHostOwner(lifetimeOwner, await callerHostOwner());
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
		await writeHostOwner(generationPaths(paths, instanceId).dir, lifetimeOwner ?? null);
		await options._test?.beforeSpawn?.();
		const argv = [
			"--socket",
			options.socket,
			"--bind",
			bindSocket,
			"--replace",
			`${replaced.dev}:${replaced.ino}`,
			...predecessorOwnerArgs(host),
			...(inheritOwnerPipe ? ["--owner-fd", String(OWNER_WATCH_FD)] : []),
			...(options.presenterBootstrap ? ["--mcp-presenter-fd", "4"] : []),
			// Preserve the running host's policy even when an older caller omits the deployment option.
			...(options.mcpPresenterEnforcement || host.capabilities.includes("mcp_form_presenter_v1")
				? ["--mcp-presenter-enforcement"]
				: []),
			...(options.hostArgs ?? []),
		];
		const launch = (options._test?.launch ?? options.launch)?.(argv) ?? {
			...defaultHostLaunch(argv),
			reportsStartup: true,
		};
		// The successor's own startup attempt (senpi#4602): its controller is created immediately before the spawn.
		const attempt = beginStartupAttempt({
			socket: options.socket,
			instanceId,
			generation,
			attempt: newStartupAttempt(),
			coordinated: launch.reportsStartup === true,
			successorOf: host.instanceId ?? null,
			...(options._test?.readinessTimeoutMs ? { decisionBudgetMs: options._test.readinessTimeoutMs } : {}),
		});
		const stderr = await open(paths.stderrLog, "a", 0o600);
		const stdio = attempt.stdio<"ignore" | "pipe" | number>(
			options.presenterBootstrap
				? ["ignore", "ignore", stderr.fd, inheritOwnerPipe ? "pipe" : "ignore", "pipe"]
				: inheritOwnerPipe
					? ["ignore", "ignore", stderr.fd, "pipe"]
					: ["ignore", "ignore", stderr.fd],
		);
		const spawned = spawnWithPrivateFds(spawn, launch.command, [...launch.args], {
			detached: true,
			windowsHide: true,
			env: {
				...successorHostEnvironment({
					agentDir: options.agentDir,
					env: options.env,
					expectedRuntimeBuildId: options.expectedRuntimeBuildId,
					paths,
					generation,
					instanceId,
				}),
				...attempt.env,
			},
			stdio,
		});
		const presenter = successorPresenter(options.presenterBootstrap, spawned, host, attempt.coordinated);
		child = spawned;
		const childExit = new Promise<ChildExit>((resolve) =>
			spawned.once("exit", (code, signal) => resolve({ code, signal })),
		);
		exited = childExit.then(() => {});
		attempt.attach(spawned, childExit);
		await stderr.close();
		if (inheritOwnerPipe) keepOwnerPipe(spawned);
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
		const grant = adoptionGrant(attempt.binding.attempt, generationPaths(paths, instanceId).dir, spawned);
		const childGone = exited;
		const run = await driveSuccessorStartup({
			attempt: { controller: attempt.controller, coordinated: attempt.coordinated, grant: grant.grant },
			presenter: attempt.coordinated ? presenter : undefined,
			awaitAnswer: (budgetMs) => awaitSuccessor(options.socket, host, childGone, budgetMs),
		});
		// A failed attempt first revokes its grant and reads who owns the public name, inside the endpoint fence: an
		// adoption that committed after its deadline is a completed handoff, never rolled back (senpi#4602).
		const adopted = run.ready
			? run.answer
			: (await settleCandidateAdoption(options.socket, instanceId, grant.revoke)) === "completed"
				? ((await probeProtocolInfo(options.socket, 2_000)) ?? null)
				: undefined;
		if (adopted === undefined) {
			const reason = await abortReason(options.socket, replaced);
			const cleanupFailure = await abandonSuccessor({
				child,
				exited,
				paths,
				instanceId,
				bootSettings,
				reason: "successor_readiness_timeout",
			});
			const detail = [run.ready ? undefined : failureDetail(run.outcome, cleanupFailure), cleanupFailure]
				.filter(Boolean)
				.join("; ");
			return { action: "refuse", reason, upgradeable: true, ...(detail && { detail }) };
		}
		// The pointer moves to the successor only now: until the rename landed, the generation the
		// clients reach is still the predecessor, and the pointer has to name whoever owns the socket.
		await options._test?.beforeRegistration?.();
		await writeHostRegistration(paths, { ...registration, ...(adopted ? successorBuild(adopted) : {}) });
		// An uncoordinated successor keeps today's order: its presenter result after the public answer.
		if (!attempt.coordinated) await presenter?.();
		child.unref();
		// The successor owns the socket now: the predecessor may drain. SIGUSR1 is sent only here,
		// to a pid the record proved and a host that advertised it can survive the signal. A
		// predecessor that exited on its own in the meantime is already drained, and the handoff it
		// was being asked to make room for has already happened.
		if (owner !== undefined && (drainGate === undefined || (await drainGate())))
			signalGeneration(owner.pid, "SIGUSR1");
		return {
			action: "handoff",
			pid: child.pid,
			socket: options.socket,
			generation: adopted?.generation ?? generation,
			instanceId: adopted?.instanceId ?? instanceId,
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

/** The successor's build as the successor itself reported it on the socket; never this process's build. */
function successorBuild(answer: HostProtocolInfo): Pick<HostRegistration, "build"> {
	if (answer.engineVersion === undefined || answer.engineOrdinal === undefined) return {};
	return { build: { text: answer.engineVersion, ordinal: answer.engineOrdinal } };
}

/**
 * The successor's own answer on the PUBLIC socket is the only proof the rename landed: it
 * reports a different `instanceId` than the generation being replaced. An exit instead means
 * the successor refused to replace the path (a foreign socket, a live bind path) and left it alone.
 */
async function awaitSuccessor(
	socket: string,
	previous: HostProtocolInfo,
	exited: Promise<void>,
	budgetMs: number,
): Promise<HostProtocolInfo | undefined> {
	const deadline = Date.now() + budgetMs;
	let childGone = false;
	void exited.then(() => {
		childGone = true;
	});
	while (Date.now() <= deadline) {
		const answer = await probeProtocolInfo(socket, Math.min(2_000, Math.max(1, deadline - Date.now())));
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
