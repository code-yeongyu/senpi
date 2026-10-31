/**
 * The startup-event wire (senpi#4602, A-amended sections 1-2), shared by the producers (the supervisor and
 * its host child) and the launcher's controller. Dependency-free on purpose: it is in the supervisor's
 * startup import graph, which is a budget (`test/supervisor-import-graph.test.ts`).
 *
 * Each producer writes LF-terminated JSON records to the dedicated startup pipe at `STARTUP_EVENT_FD`.
 * The supervisor relays its host child's records inside a `relay` frame, so the launcher feeds them to the
 * host role's ingress and a supervisor record can never complete a host phase.
 */
import { closeSync } from "node:fs";
import type { StartupPhase } from "./host-startup-policy.ts";

/** Above `ADOPTABLE_MAX` of the private descriptor table (`private-fds.ts`), which forwards 5..15 by number. */
export const STARTUP_EVENT_FD = 16;
/** Equal to `HOST_STARTUP_EVENTS_ENV` (host-identity-env.ts); kept here so the wire stays import-free. */
const HOST_STARTUP_EVENTS_ENV_NAME = "SENPI_RPC_HOST_STARTUP_EVENTS";
export const STARTUP_EVENT_PROTOCOL_VERSION = 1;
export const MAX_STARTUP_EVENT_BYTES = 4096;
/** In the candidate's own generation directory: its attempt nonce and identity, for a later holder's recovery. */
export const STARTUP_ATTEMPT_FILE = "startup-attempt.json";
/**
 * In a successor's own generation directory: the launcher's grant to take the public name, for one attempt. The
 * supervisor re-reads it inside the endpoint fence right before the adoption rename; the launcher's cleanup removes
 * it inside the same fence, so a revoked grant can never be followed by an adoption (senpi#4602 N1).
 */
export const ADOPTION_GRANT_FILE = "adoption-grant.json";

export type StartupProducerRole = "supervisor" | "host";
/** `host_opaque`: the supervisor's declaration, made before it spawns a host child that cannot report. */
export type StartupMilestone = StartupPhase | "host_opaque";

export interface StartupBinding {
	readonly attempt: string;
	readonly endpoint: string;
	readonly instanceId: string;
	readonly generation: number;
	readonly launchKind: "initial" | "successor";
	readonly predecessor: string | null;
}

/** What a producer is told through its environment: who it is reporting for, and the attempt's budget. */
export interface StartupHandOff {
	readonly binding: StartupBinding;
	readonly role: StartupProducerRole;
	/** G of this attempt: the supervisor's own backstop for retries the controller would otherwise bound. */
	readonly budgetMs: number;
	/** The filler slots this process inherited (see `withStartupPipe`); its startup stub closes them first. */
	readonly fillers?: readonly number[];
}

export function encodeStartupHandOff(handOff: StartupHandOff): string {
	return JSON.stringify(handOff);
}

export function parseStartupHandOff(value: string | undefined): StartupHandOff | undefined {
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const { binding, role, budgetMs, fillers } = parsed as Record<string, unknown>;
		if (role !== "supervisor" && role !== "host") return undefined;
		if (typeof budgetMs !== "number" || !Number.isFinite(budgetMs) || budgetMs <= 0) return undefined;
		if (typeof binding !== "object" || binding === null) return undefined;
		const fields = binding as Record<string, unknown>;
		if (typeof fields.attempt !== "string" || typeof fields.instanceId !== "string") return undefined;
		const slots = Array.isArray(fillers)
			? fillers.filter((slot): slot is number => Number.isInteger(slot) && slot >= 3 && slot < STARTUP_EVENT_FD)
			: [];
		return { binding: binding as StartupBinding, role, budgetMs, fillers: slots };
	} catch {
		return undefined;
	}
}

/**
 * The spawn's stdio with the startup pipe at `STARTUP_EVENT_FD`, and the slots it had to fill on the way.
 *
 * Every unused slot from 3 to 15 becomes a FILLER pipe rather than "ignore": on macOS, Node's libuv `uv_spawn`
 * calls abort() - killing the spawning process, not the child - when a libuv-created pipe sits at a high slot
 * above an unfilled one and the parent has free descriptors below it (reproduced on Node 24 and 26, never on
 * Bun). Slots the spawn already uses, including the #4749 private descriptors `spawnWithPrivateFds` places at
 * their own numbers afterwards, are left alone. The child never reads a filler: no fd 3..15 is opened by number
 * without a flag naming it, and Node marks inherited descriptors close-on-exec, so they end with the child.
 * Pass the returned `fillers` to `releaseStartupFillers` right after the spawn.
 */
export function withStartupPipe<T>(base: readonly T[]): { readonly stdio: (T | "pipe")[]; readonly fillers: number[] } {
	const stdio: (T | "pipe")[] = [...base];
	const fillers: number[] = [];
	for (let slot = 3; slot < STARTUP_EVENT_FD; slot += 1) {
		const entry = stdio[slot];
		if (entry === undefined || entry === null || entry === "ignore") {
			stdio[slot] = "pipe";
			fillers.push(slot);
		}
	}
	stdio[STARTUP_EVENT_FD] = "pipe";
	return { stdio, fillers };
}

/** Closes the parent's end of every filler pipe; a slot a private descriptor took over has no stream. */
export function releaseStartupFillers(child: { readonly stdio: readonly unknown[] }, fillers: readonly number[]): void {
	for (const slot of fillers) {
		const stream = child.stdio[slot];
		if (typeof stream === "object" && stream !== null && "destroy" in stream && typeof stream.destroy === "function")
			stream.destroy();
	}
}

/**
 * Closes the filler pipes this process inherited (they only kept libuv from aborting the spawn that created
 * them, see `withStartupPipe`) and removes their list from the hand-off, so a process this one re-executes or
 * spawns never closes a descriptor that is not a filler. A slot the #4749 private table names is that
 * channel's, never a filler, and stays open. Called first by every entry that can receive a hand-off.
 */
export function releaseInheritedStartupFillers(env: NodeJS.ProcessEnv): void {
	const handOff = parseStartupHandOff(env[HOST_STARTUP_EVENTS_ENV_NAME]);
	if (!handOff?.fillers?.length) return;
	const privateSlots = new Set<number>();
	try {
		const table: unknown = JSON.parse(env.SENPI_PRIVATE_FDS ?? "{}");
		if (typeof table === "object" && table !== null)
			for (const entry of Object.values(table))
				for (const fd of [entry].flat()) if (typeof fd === "number") privateSlots.add(fd);
	} catch {
		// An unparseable table names no channel this process can adopt; every filler is still ours to close.
	}
	for (const slot of handOff.fillers) {
		if (privateSlots.has(slot)) continue;
		try {
			closeSync(slot);
		} catch {
			// Already closed by an earlier entry of this same process: nothing left to release.
		}
	}
	env[HOST_STARTUP_EVENTS_ENV_NAME] = encodeStartupHandOff({ ...handOff, fillers: [] });
}

export function startupEventLine(
	binding: StartupBinding,
	role: StartupProducerRole,
	seq: number,
	milestone: StartupMilestone,
): string {
	return `${JSON.stringify({ v: STARTUP_EVENT_PROTOCOL_VERSION, binding, role, seq, milestone })}\n`;
}

/** The launcher's wake-up to a successor supervisor on the same pipe, in the other direction: P7 resolved. */
export function startupGrantLine(attempt: string): string {
	return `${JSON.stringify({ grant: "public_published", attempt })}\n`;
}

/** The supervisor's frame around one host-child record line (without its LF). */
export function relayStartupLine(line: string): string {
	return `${JSON.stringify({ relay: "host", line })}\n`;
}
