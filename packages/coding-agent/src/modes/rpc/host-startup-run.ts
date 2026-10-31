/**
 * Drives one start attempt from its controller to READY or a terminal failure (senpi#4602, A-amended):
 * the producer milestones advance the phases on their own; this module completes the two phases the launcher
 * owns - the presenter result and the public `get_protocol_info` verification - each inside its phase's
 * remaining time, and turns a child exit or an incompatible answer into an explicit, latched failure.
 */
import type { ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import type { HostAttachHold } from "./host-attach-hold.ts";
import type { HostProtocolInfo } from "./host-decision.ts";
import { HOST_PROTOCOL_VERSION, REQUIRED_HOST_CAPABILITIES } from "./host-decision.ts";
import { HOST_STARTUP_EVENTS_ENV } from "./host-identity-env.ts";
import { type ChildExit, pollProtocolInfo } from "./host-readiness.ts";
import { attachStartupEvents } from "./host-startup-events.ts";
import {
	STARTUP_DECISION_BUDGET_MS,
	type StartupClock,
	type StartupController,
	type StartupLaunchKind,
	type StartupOutcome,
	startStartupController,
} from "./host-startup-policy.ts";
import {
	encodeStartupHandOff,
	releaseStartupFillers,
	STARTUP_EVENT_FD,
	type StartupBinding,
	withStartupPipe,
} from "./host-startup-wire.ts";

/** The launcher's monotonic clock: never the wall clock, never another process's timestamps. */
export function monotonicStartupClock(): StartupClock {
	return {
		now: () => performance.now(),
		scheduleAt: (at, fire) => setTimeout(fire, Math.max(0, at - performance.now())),
		cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
}

export interface StartupAttempt {
	readonly controller: StartupController;
	readonly binding: StartupBinding;
	readonly coordinated: boolean;
	/** The supervisor's hand-off variable, for a coordinated launch; read it after `stdio()`, which decides the fillers. */
	readonly env: Readonly<Record<string, string>>;
	/** `base` with the startup pipe and its fillers, for a coordinated launch; `base` unchanged otherwise. */
	stdio<T>(base: readonly T[]): (T | "pipe")[];
	attach(child: ChildProcess, childExit: Promise<ChildExit>): void;
}

/** Created immediately BEFORE the spawn: the controller's creation instant is the attempt's origin. */
export function beginStartupAttempt(options: {
	readonly socket: string;
	readonly instanceId: string;
	readonly generation: number;
	/** The supervisor command is the engine's own, known to report progress; anything else is legacy. */
	readonly coordinated: boolean;
	readonly decisionBudgetMs?: number;
	readonly clock?: StartupClock;
	/** The attempt nonce, allocated before the startup intent that names it is written. */
	readonly attempt: string;
	/** A successor generation: its own phase path (presenter before publication) and the instance it replaces. */
	readonly successorOf?: string | null;
}): StartupAttempt {
	const successor = options.successorOf !== undefined;
	const launchKind: StartupLaunchKind = !options.coordinated ? "legacy" : successor ? "successor" : "initial";
	const budgetMs = options.decisionBudgetMs ?? STARTUP_DECISION_BUDGET_MS;
	const binding: StartupBinding = {
		attempt: options.attempt,
		endpoint: options.socket,
		instanceId: options.instanceId,
		generation: options.generation,
		launchKind: successor ? "successor" : "initial",
		predecessor: options.successorOf ?? null,
	};
	const controller = startStartupController({
		launchKind,
		clock: options.clock ?? monotonicStartupClock(),
		decisionBudgetMs: budgetMs,
	});
	const coordinated = options.coordinated;
	let fillers: readonly number[] = [];
	return {
		controller,
		binding,
		coordinated,
		get env(): Readonly<Record<string, string>> {
			if (!coordinated) return {};
			return { [HOST_STARTUP_EVENTS_ENV]: encodeStartupHandOff({ binding, role: "supervisor", budgetMs, fillers }) };
		},
		stdio(base) {
			if (!coordinated) return [...base];
			const filled = withStartupPipe(base);
			fillers = filled.fillers;
			return filled.stdio;
		},
		attach(child, childExit) {
			releaseStartupFillers(child, fillers);
			const stream: unknown = (child.stdio as readonly unknown[])[STARTUP_EVENT_FD];
			if (coordinated && stream instanceof Readable) attachStartupEvents(stream, controller, binding);
			// Before public verification a supervisor exit ends the attempt; during it, the in-flight probe decides.
			void childExit.then((exit) => {
				if (!controller.terminal && controller.phase !== "public_verified")
					controller.fail(new Error(exitMessage(exit)));
			});
		},
	};
}

export function exitMessage(exit: ChildExit): string {
	return `RPC socket host exited with code ${exit.code ?? "null"}${exit.signal ? ` (${exit.signal})` : ""} before answering get_protocol_info`;
}

function incompatibleMessage(protocol: HostProtocolInfo): string {
	return `RPC socket host answered get_protocol_info with protocolVersion ${protocol.protocolVersion}, serverVersion ${protocol.serverVersion} and capabilities ${JSON.stringify(protocol.capabilities)}, but is incompatible with protocol version ${HOST_PROTOCOL_VERSION} and required capabilities ${JSON.stringify(REQUIRED_HOST_CAPABILITIES)}`;
}

export type StartupResult =
	| { readonly ready: true; readonly hold: HostAttachHold }
	| { readonly ready: false; readonly outcome: Exclude<StartupOutcome, { readonly kind: "ready" }> };

export async function driveStartupToReady(options: {
	readonly attempt: StartupAttempt;
	readonly socket: string;
	readonly childExit: Promise<ChildExit>;
	readonly presenterEnrollment: Promise<unknown> | undefined;
	readonly isCompatible: (protocol: HostProtocolInfo | undefined) => boolean;
}): Promise<StartupResult> {
	const { controller } = options.attempt;
	const failure = async (): Promise<StartupResult> => {
		const outcome = await controller.settled();
		if (outcome.kind === "ready") throw new Error("startup controller reported READY on a failure path");
		return { ready: false, outcome };
	};
	if (options.attempt.coordinated) {
		if (!(await controller.whenPhase("presenter_resolved"))) return failure();
		const presenter = await Promise.race([
			(options.presenterEnrollment ?? Promise.resolve()).then(() => "resolved" as const),
			controller.settled().then(() => "terminal" as const),
		]);
		if (presenter === "terminal" || controller.complete("presenter_resolved") !== "accepted") return failure();
	}
	const result = await pollProtocolInfo(
		options.socket,
		Math.max(1, controller.remainingMs()),
		options.isCompatible,
		options.childExit,
	);
	if (result.ready) {
		if (controller.complete("public_verified") !== "accepted") {
			result.hold.release();
			return failure();
		}
		// A legacy launch keeps today's order: the presenter result after the public answer.
		if (!options.attempt.coordinated) await options.presenterEnrollment;
		return { ready: true, hold: result.hold };
	}
	// An answer the host did give, or its exit, is an explicit cause: it is never relabelled as the timeout the
	// poll ran into while it kept retrying that incompatible answer (A-amended section 6).
	const explicit = result.protocol
		? new Error(incompatibleMessage(result.protocol))
		: result.exited
			? new Error(exitMessage(result.exited))
			: undefined;
	if (!explicit) return failure();
	controller.fail(explicit);
	const settled = await controller.settled();
	return {
		ready: false,
		outcome:
			settled.kind === "failed"
				? settled
				: { kind: "failed", phase: "public_verified", cause: explicit, elapsedMs: settled.elapsedMs },
	};
}
