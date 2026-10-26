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
 *
 * Publication is a one-shot commit point (code-yeongyu/oh-my-openagent#10091). The successor takes the
 * handoff's publication token as the last step before its rename (`host-publish-token.ts`); a handoff whose
 * readiness window closed revokes that token BEFORE it stops the successor, and follows one that took it
 * first. Once the successor answers on the public socket nothing stops it: a registration, enrollment or
 * drain step that fails afterwards is reported as `repair`, and the handoff still completes.
 */
import { type ChildProcess, spawn } from "node:child_process";
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
import type { HandoffHostOptions, HandoffResult } from "./host-handoff.ts";
import { defaultHostLaunch, PINNED_HOST_CLIENT_CAPABILITIES } from "./host-launch.ts";
import { DEFAULT_HOST_IDLE_EXIT_MS } from "./host-lifecycle.ts";
import { keepOwnerPipe, OWNER_WATCH_FD } from "./host-lifecycle-launch.ts";
import { createPublishToken } from "./host-publish-token.ts";
import { abandonSuccessor, SUCCESSOR_EXIT_WAIT_MS } from "./host-successor-abandon.ts";
import {
	abortReason,
	awaitSuccessor,
	followWithdrawnPublication,
	LATE_PUBLICATION_MS,
} from "./host-successor-readiness.ts";
import { relayPresenterBootstrap } from "./mcp-presenter-bootstrap.ts";
import type { HostProtocolInfo } from "./host-protocol-info.ts";
import { successorHostEnvironment } from "./host-spawn-environment.ts";
import { signalGeneration } from "./host-stop.ts";
import { hostLaunchProfile } from "./protocol-identity.ts";
import { generationBindPath, MAX_SOCKET_PATH_BYTES, statSocketIdentity } from "./socket-ownership.ts";

/** How long the successor has to answer on the PUBLIC socket before the handoff is abandoned. */
const DEFAULT_HANDOFF_READINESS_MS = 30_000;

/**
 * The longest `startSuccessor` runs: its start-time read, the readiness window, one last probe, the wait for a
 * publication that won the race against the window, and a refusal's exit wait.
 */
export const SUCCESSOR_START_BUDGET_MS =
	10_000 + DEFAULT_HANDOFF_READINESS_MS + 2_000 + LATE_PUBLICATION_MS + SUCCESSOR_EXIT_WAIT_MS;

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
	let published: Published;
	try {
		await writeHostOwner(generationPaths(paths, instanceId).dir, lifetimeOwner ?? null);
		const publishToken = await createPublishToken(generationPaths(paths, instanceId).dir);
		await options._test?.beforeSpawn?.();
		const argv = [
			"--socket",
			options.socket,
			"--bind",
			bindSocket,
			"--replace",
			`${replaced.dev}:${replaced.ino}`,
			"--publish-token",
			publishToken,
			...(inheritOwnerPipe ? ["--owner-fd", String(OWNER_WATCH_FD)] : []),
			...(options.presenterBootstrap ? ["--mcp-presenter-fd", "4"] : []),
			// Preserve the running host's policy even when an older caller omits the deployment option.
			...(options.mcpPresenterEnforcement || host.capabilities.includes("mcp_form_presenter_v1")
				? ["--mcp-presenter-enforcement"]
				: []),
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
			stdio: options.presenterBootstrap
				? ["ignore", "ignore", stderr.fd, inheritOwnerPipe ? "pipe" : "ignore", "pipe"]
				: inheritOwnerPipe
					? ["ignore", "ignore", stderr.fd, "pipe"]
					: ["ignore", "ignore", stderr.fd],
		});
		const presenterEnrollment = options.presenterBootstrap
			? relayPresenterBootstrap(options.presenterBootstrap, spawned)
			: undefined;
		child = spawned;
		const exit = new Promise<void>((resolve) => spawned.once("exit", () => resolve()));
		exited = exit;
		await stderr.close();
		if (inheritOwnerPipe) keepOwnerPipe(spawned);
		if (spawned.pid === undefined) throw new Error("failed to spawn the successor generation");
		const processStartTime = (await waitForStartTime(spawned.pid, 10_000).catch(() => undefined)) ?? null;
		const registration = {
			record: { pid: spawned.pid, processStartTime },
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
		await options._test?.afterSpawn?.(spawned.pid);
		const window = options._test?.readinessTimeoutMs ?? readinessWindow(options.deadline);
		const answer =
			(await awaitSuccessor(options.socket, host, exit, window)) ??
			(await followWithdrawnPublication(publishToken, options.socket, host, exit));
		if (answer === "unconfirmed") {
			// It took its token, so it may own the public path now: it is never stopped from here.
			return {
				action: "refuse",
				reason: "successor_unavailable",
				upgradeable: true,
				detail: "publication unconfirmed",
			};
		}
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
		published = { pid: spawned.pid, child: spawned, answer, registration, presenterEnrollment };
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
	// PUBLISHED: the successor answers on the public socket. Every step from here repairs forward - a
	// bookkeeping failure is reported, never answered by stopping the generation clients now reach
	// (code-yeongyu/oh-my-openagent#10091).
	const repair = await completePublication(published, { options, paths, owner, drainGate });
	if (repair !== undefined) process.stderr.write(`senpi rpc handoff: the successor serves the socket; ${repair}\n`);
	return {
		action: "handoff",
		pid: published.pid,
		socket: options.socket,
		generation: published.answer.generation ?? generation,
		instanceId: published.answer.instanceId ?? "",
		...(repair !== undefined && { repair }),
	};
}

/**
 * The readiness window a handoff with a deadline can afford: what is left once the late-publication follow and a
 * refusal's exit wait are reserved, never more than the default window (code-yeongyu/oh-my-openagent#10091).
 */
function readinessWindow(deadline: number | undefined): number {
	if (deadline === undefined) return DEFAULT_HANDOFF_READINESS_MS;
	const left = deadline - Date.now() - LATE_PUBLICATION_MS - SUCCESSOR_EXIT_WAIT_MS;
	return Math.max(0, Math.min(DEFAULT_HANDOFF_READINESS_MS, left));
}

interface Published {
	readonly pid: number;
	readonly child: ChildProcess;
	readonly answer: HostProtocolInfo;
	readonly registration: HostRegistration;
	readonly presenterEnrollment: Promise<unknown> | undefined;
}

/** Registration, presenter enrollment and the predecessor's drain, after publication: never throws. */
async function completePublication(
	published: Published,
	context: {
		readonly options: HandoffHostOptions;
		readonly paths: HostDaemonPaths;
		readonly owner: { readonly pid: number } | undefined;
		readonly drainGate: (() => Promise<boolean>) | undefined;
	},
): Promise<string | undefined> {
	const { options, paths, owner, drainGate } = context;
	const failures: string[] = [];
	const step = async (name: string, run: () => Promise<unknown>): Promise<void> => {
		try {
			await run();
		} catch (cause) {
			failures.push(`${name}: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
	};
	// The pointer moves to the successor only now: until the rename landed, the generation the
	// clients reach is still the predecessor, and the pointer has to name whoever owns the socket.
	// A pointer that could not be moved is elected back to this one proven generation (senpi#1911).
	await step("registration", async () => {
		await options._test?.beforeRegistration?.();
		await writeHostRegistration(paths, { ...published.registration, ...successorBuild(published.answer) });
	});
	await step("presenter enrollment", async () => published.presenterEnrollment);
	published.child.unref();
	// The successor owns the socket now: the predecessor may drain. SIGUSR1 is sent only here,
	// to a pid the record proved and a host that advertised it can survive the signal. A
	// predecessor that exited on its own in the meantime is already drained, and the handoff it
	// was being asked to make room for has already happened.
	await step("predecessor drain", async () => {
		if (owner !== undefined && (drainGate === undefined || (await drainGate())))
			signalGeneration(owner.pid, "SIGUSR1");
	});
	return failures.length === 0 ? undefined : failures.join("; ");
}

/** The successor's build as the successor itself reported it on the socket; never this process's build. */
function successorBuild(answer: HostProtocolInfo): Pick<HostRegistration, "build"> {
	if (answer.engineVersion === undefined || answer.engineOrdinal === undefined) return {};
	return { build: { text: answer.engineVersion, ordinal: answer.engineOrdinal } };
}
