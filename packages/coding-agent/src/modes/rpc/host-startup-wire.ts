/**
 * The startup-event wire (senpi#4602, A-amended sections 1-2), shared by the producers (the supervisor and
 * its host child) and the launcher's controller. Dependency-free on purpose: it is in the supervisor's
 * startup import graph, which is a budget (`test/supervisor-import-graph.test.ts`).
 *
 * Each producer writes LF-terminated JSON records to the dedicated startup pipe at `STARTUP_EVENT_FD`.
 * The supervisor relays its host child's records inside a `relay` frame, so the launcher feeds them to the
 * host role's ingress and a supervisor record can never complete a host phase.
 */
import type { StartupPhase } from "./host-startup-policy.ts";

/** Above `ADOPTABLE_MAX` of the private descriptor table (`private-fds.ts`), which forwards 5..15 by number. */
export const STARTUP_EVENT_FD = 16;
export const STARTUP_EVENT_PROTOCOL_VERSION = 1;
export const MAX_STARTUP_EVENT_BYTES = 4096;
/** In the candidate's own generation directory: its attempt nonce and identity, for a later holder's recovery. */
export const STARTUP_ATTEMPT_FILE = "startup-attempt.json";

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
}

export function encodeStartupHandOff(handOff: StartupHandOff): string {
	return JSON.stringify(handOff);
}

export function parseStartupHandOff(value: string | undefined): StartupHandOff | undefined {
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const { binding, role, budgetMs } = parsed as Record<string, unknown>;
		if (role !== "supervisor" && role !== "host") return undefined;
		if (typeof budgetMs !== "number" || !Number.isFinite(budgetMs) || budgetMs <= 0) return undefined;
		if (typeof binding !== "object" || binding === null) return undefined;
		const fields = binding as Record<string, unknown>;
		if (typeof fields.attempt !== "string" || typeof fields.instanceId !== "string") return undefined;
		return { binding: binding as StartupBinding, role, budgetMs };
	} catch {
		return undefined;
	}
}

/** The stdio slots from `nextSlot` up to and including the startup pipe: unused slots stay closed. */
export function startupEventStdio(nextSlot: number): ("ignore" | "pipe")[] {
	return [...Array.from({ length: STARTUP_EVENT_FD - nextSlot }, () => "ignore" as const), "pipe"];
}

export function startupEventLine(
	binding: StartupBinding,
	role: StartupProducerRole,
	seq: number,
	milestone: StartupMilestone,
): string {
	return `${JSON.stringify({ v: STARTUP_EVENT_PROTOCOL_VERSION, binding, role, seq, milestone })}\n`;
}

/** The supervisor's frame around one host-child record line (without its LF). */
export function relayStartupLine(line: string): string {
	return `${JSON.stringify({ relay: "host", line })}\n`;
}

/** The host-child record a relay frame carries, or undefined for the supervisor's own records. */
export function unwrapStartupRelay(line: string): string | undefined {
	if (!line.startsWith('{"relay":')) return undefined;
	try {
		const frame: unknown = JSON.parse(line);
		if (typeof frame !== "object" || frame === null) return undefined;
		const { relay, line: inner } = frame as Record<string, unknown>;
		return relay === "host" && typeof inner === "string" ? inner : undefined;
	} catch {
		return undefined;
	}
}
