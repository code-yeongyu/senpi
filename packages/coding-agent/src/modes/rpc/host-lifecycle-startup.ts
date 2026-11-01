/**
 * The supervisor's part in a coordinated startup (senpi#4602, A-amended sections 1-3): it reports its own
 * milestones on the startup pipe, relays its host child's, records the attempt nonce in its own generation
 * directory for recovery, and - because the launcher's controller now decides when a start has failed -
 * retries a silent internal-readiness probe or a failed first observer connection inside the attempt's
 * budget instead of ending the generation on the first 10 s / 5 s miss. An uncoordinated supervisor keeps
 * its original limits exactly.
 */
import type { ChildProcess } from "node:child_process";
import { read } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Server } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { adoptEndpoint, claimEndpoint, endpointOwnerToken } from "./host-endpoint-owner.ts";
import type { SupervisorLaunch } from "./host-lifecycle-launch.ts";
import { relayHostStartupEvents, reportStartupMilestone, startupHandOff } from "./host-startup-beacon.ts";
import { listen, prepareSocketPath, waitForListener } from "./host-lifecycle-proxy.ts";
import { writeJsonAtomic } from "./host-state-json.ts";
import { withStartupPipe } from "../../private-fd-startup-fillers.ts";
import {
	ADOPTION_GRANT_FILE,
	MAX_STARTUP_EVENT_BYTES,
	STARTUP_ATTEMPT_FILE,
	STARTUP_EVENT_FD,
	startupGrantLine,
} from "./host-startup-wire.ts";
import type { RpcPublicEndpoint } from "./rpc-public-key.ts";

const UNCOORDINATED_LISTENER_TIMEOUT_MS = 30_000;
const OBSERVER_RETRY_DELAY_MS = 250;

/** Declared before the host child is spawned: a custom child command cannot report its own progress. */
export function declareHostChild(childCommand: string | undefined): void {
	if (childCommand) reportStartupMilestone("host_opaque");
}

/** Whether the host child gets the startup pipe: only a coordinated launch of the engine's own host. */
export function hostChildReportsStartup(childCommand: string | undefined): boolean {
	return startupHandOff() !== undefined && !childCommand;
}

export async function hostChildSpawned(
	child: ChildProcess,
	generationDir: string,
	supervisorStartTime: string | undefined,
): Promise<void> {
	const handOff = startupHandOff();
	if (!handOff) return;
	const stream: unknown = (child.stdio as readonly unknown[])[STARTUP_EVENT_FD];
	relayHostStartupEvents(stream instanceof Readable ? stream : undefined);
	await writeJsonAtomic(join(generationDir, STARTUP_ATTEMPT_FILE), {
		attempt: handOff.binding.attempt,
		pid: process.pid,
		processStartTime: supervisorStartTime ?? null,
	});
	reportStartupMilestone("supervisor_setup");
}

export async function awaitInternalStartup(options: {
	readonly internalSocket: string;
	readonly internalSecret: Uint8Array | undefined;
	readonly internalKey: Buffer | undefined;
	readonly openObserver: () => Promise<void>;
}): Promise<void> {
	const handOff = startupHandOff();
	const deadline = performance.now() + (handOff?.budgetMs ?? 0);
	await waitForListener(
		options.internalSocket,
		handOff?.budgetMs ?? UNCOORDINATED_LISTENER_TIMEOUT_MS,
		options.internalSecret,
		options.internalKey,
		{ retrySilent: handOff !== undefined },
	);
	reportStartupMilestone("internal_ready");
	for (;;) {
		try {
			await options.openObserver();
			break;
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : "";
			const unproven = reason === "host_identity_unproven" || reason === "auth_failed";
			if (!handOff || unproven || performance.now() + OBSERVER_RETRY_DELAY_MS >= deadline) throw cause;
			await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, OBSERVER_RETRY_DELAY_MS));
		}
	}
	reportStartupMilestone("observer_ready");
}

export function supervisorPublished(): void {
	reportStartupMilestone("public_published");
}

/**
 * Binds and publishes this generation's public endpoint (senpi#4602, A-amended section 4). An initial start binds
 * the public name and claims its owner token in one fence. A successor stages its own `.next-<gen>` listener, then -
 * on a coordinated launch - waits for the launcher's publication grant, which comes only after its presenter (P7)
 * resolved; only then does it publish its key and adopt the public name, under the fence, re-checking the grant,
 * the predecessor's owner token and the entry it was decided against.
 */
export async function publishSupervisorEndpoint(options: {
	readonly launch: SupervisorLaunch;
	readonly server: Server;
	readonly publicSecret: Uint8Array | undefined;
	readonly publicEndpoint: RpcPublicEndpoint | undefined;
	readonly generationDir: string;
	readonly instanceId: string;
	/** This generation's settings as read at boot: the generation number the owner token names. */
	readonly settings: unknown;
	/** Marked the moment this generation's key is published: its teardown owns the public entry from then on. */
	readonly state: { publicSocketOwned: boolean };
}): Promise<void> {
	const { launch, server, publicSecret } = options;
	const generation =
		typeof options.settings === "object" && options.settings !== null
			? Reflect.get(options.settings, "generation")
			: undefined;
	const token = endpointOwnerToken(launch.socket, options.instanceId, typeof generation === "number" ? generation : 0);
	const bindSocket = launch.bindSocket;
	if (bindSocket === undefined) {
		await claimEndpoint(launch.socket, token, async () => {
			await prepareSocketPath(launch.socket);
			await listen(server, launch.socket, publicSecret);
		});
		await options.publicEndpoint?.publish();
		options.state.publicSocketOwned = true;
		return;
	}
	await prepareSocketPath(bindSocket);
	await listen(server, bindSocket, publicSecret);
	const granted = await awaitPublicationGrant(options.generationDir);
	await options.publicEndpoint?.publish();
	options.state.publicSocketOwned = true;
	await adoptEndpoint({
		bindSocket,
		publicSocket: launch.socket,
		expected: launch.replaceIdentity,
		expectedOwner: launch.replaceOwner,
		token: token,
		...(granted ? { granted } : {}),
	});
}

/**
 * A coordinated successor's wait for its launcher's publication grant: one line on the startup pipe, read with a
 * blocking read that leaves the descriptor's mode alone (the beacon writes it synchronously). Returns the check the
 * adoption re-runs inside the endpoint fence; `undefined` for an initial or uncoordinated launch, which is never
 * granted and publishes at once.
 */
async function awaitPublicationGrant(generationDir: string): Promise<(() => Promise<boolean>) | undefined> {
	const handOff = startupHandOff();
	if (handOff?.binding.launchKind !== "successor") return undefined;
	const { attempt } = handOff.binding;
	await readGrantLine(startupGrantLine(attempt).trimEnd(), handOff.budgetMs);
	return async () => {
		try {
			const grant: unknown = JSON.parse(await readFile(join(generationDir, ADOPTION_GRANT_FILE), "utf8"));
			return typeof grant === "object" && grant !== null && Reflect.get(grant, "attempt") === attempt;
		} catch {
			return false;
		}
	};
}

const GRANT_READ_RETRY_MS = 50;

function readGrantLine(expected: string, budgetMs: number): Promise<void> {
	return new Promise((resolveGrant, reject) => {
		const buffer = Buffer.alloc(MAX_STARTUP_EVENT_BYTES);
		let pending = "";
		let settled = false;
		const settle = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolveGrant();
		};
		const timer = setTimeout(() => settle(new Error(`no publication grant within ${budgetMs}ms`)), budgetMs);
		const next = (): void => {
			read(STARTUP_EVENT_FD, buffer, 0, buffer.length, null, (error, bytes) => {
				if (settled) return;
				if (error?.code === "EAGAIN") {
					setTimeout(next, GRANT_READ_RETRY_MS);
					return;
				}
				if (error || bytes === 0) return settle(new Error("the startup pipe closed before the publication grant"));
				pending += buffer.toString("utf8", 0, bytes);
				for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
					if (pending.slice(0, newline) === expected) return settle();
					pending = pending.slice(newline + 1);
				}
				if (pending.length > MAX_STARTUP_EVENT_BYTES) return settle(new Error("oversized startup grant record"));
				next();
			});
		};
		next();
	});
}

/**
 * The host child's stdio: stdin for the internal key, inherited stderr, the lifetime pipe at 3, the presenter
 * channel at 4 when bootstrapped, and on a coordinated start the startup pipe at 16 with its fillers.
 */
export function hostChildStdio(bootstrap: boolean, reportsStartup: boolean) {
	const base = [
		process.platform === "win32" ? "ignore" : "pipe",
		"ignore",
		"inherit",
		"pipe",
		...(bootstrap ? ["pipe" as const] : []),
	] as const;
	return reportsStartup ? withStartupPipe(base) : { stdio: [...base], fillers: [] as number[] };
}
