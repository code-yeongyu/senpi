/**
 * A successor's startup, driven by its launcher (senpi#4602, A-amended sections 1 and 4, N1).
 *
 * The successor's path is P0..P5, then P7 (presenter), then P6 (publication), then P8 (public answer). The
 * presenter exchange starts only when P7 is entered, after internal and observer readiness, while the predecessor
 * still serves its unchanged public endpoint. Publication is granted only after a validated P7 result: an
 * enrollment that is rejected, closes or expires ends the candidate before it ever touched the predecessor's
 * public name, key or pointer. An uncoordinated successor (a command not known to report progress) keeps today's
 * order and waits for its public answer under the bounded legacy phase instead of a fixed 30 s.
 */
import type { ChildProcess } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { ENDPOINT_OWNER_FENCE_CAPABILITY, type HostProtocolInfo } from "./host-decision.ts";
import { type StartupController, type StartupOutcome, startupTimeoutDetail } from "./host-startup-policy.ts";
import { ADOPTION_GRANT_FILE, STARTUP_EVENT_FD, startupGrantLine } from "./host-startup-wire.ts";
import {
	MCP_PRESENTER_BOOTSTRAP_FD,
	type PresenterRelayResult,
	relayPresenterBootstrap,
} from "./mcp-presenter-bootstrap.ts";

export type PresenterResult = PresenterRelayResult;

export interface SuccessorAttempt {
	readonly controller: StartupController;
	readonly coordinated: boolean;
	/** Writes the publication grant: the authority file first, then the wake-up on the startup pipe. */
	grant(): Promise<void>;
}

export type SuccessorStartupResult =
	| { readonly ready: true; readonly answer: HostProtocolInfo }
	| { readonly ready: false; readonly outcome: Exclude<StartupOutcome, { readonly kind: "ready" }> };

export async function driveSuccessorStartup(options: {
	readonly attempt: SuccessorAttempt;
	/** Starts (or joins) the presenter exchange; called only once P7 is entered. */
	readonly presenter: (() => Promise<PresenterResult>) | undefined;
	/** The successor's own answer on the PUBLIC socket within `budgetMs`, or undefined. */
	readonly awaitAnswer: (budgetMs: number) => Promise<HostProtocolInfo | undefined>;
}): Promise<SuccessorStartupResult> {
	const { controller, coordinated } = options.attempt;
	const terminal = controller.settled().then(() => "terminal" as const);
	const failure = async (): Promise<SuccessorStartupResult> => {
		const outcome = await controller.settled();
		if (outcome.kind === "ready") throw new Error("startup controller reported READY on a failure path");
		return { ready: false, outcome };
	};
	if (coordinated) {
		if (!(await controller.whenPhase("presenter_resolved"))) return failure();
		if (options.presenter) {
			const result = await Promise.race([options.presenter(), terminal]);
			if (result === "terminal") return failure();
			if (result === "closed") {
				controller.fail(new Error("the successor's presenter channel closed before it enrolled"));
				return failure();
			}
		}
		if (controller.complete("presenter_resolved") !== "accepted") return failure();
		try {
			await options.attempt.grant();
		} catch (cause) {
			controller.fail(cause instanceof Error ? cause : new Error(String(cause)));
			return failure();
		}
		if (!(await controller.whenPhase("public_verified"))) return failure();
	}
	const answer = await Promise.race([options.awaitAnswer(Math.max(1, controller.remainingMs())), terminal]);
	if (answer !== "terminal" && answer !== undefined && controller.complete("public_verified") === "accepted")
		return { ready: true, answer };
	if (!controller.terminal) controller.fail(new Error("the successor never answered on the public socket"));
	return failure();
}

/**
 * The presenter exchange of one successor. A coordinated successor whose owner channel is DEFERRED (a running
 * host's idle handover) asks for the fresh permit only when called, at its P7. An eager owner channel, and every
 * channel of an uncoordinated launch, is relayed from the spawn as before; calling the result joins that relay.
 */
export function successorPresenter(
	bootstrap: Duplex | (() => Promise<Duplex | undefined>) | undefined,
	child: ChildProcess,
	predecessor: HostProtocolInfo,
	coordinated: boolean,
): (() => Promise<PresenterResult>) | undefined {
	if (bootstrap === undefined) return undefined;
	const relay = async (): Promise<PresenterResult> => {
		const stream = typeof bootstrap === "function" ? await bootstrap() : bootstrap;
		if (stream)
			return relayPresenterBootstrap(stream, child, {
				kind: "replacement",
				predecessorHostInstance: predecessor.instanceId,
			});
		const channel: unknown = (child.stdio as readonly unknown[])[MCP_PRESENTER_BOOTSTRAP_FD];
		if (
			typeof channel === "object" &&
			channel !== null &&
			"destroy" in channel &&
			typeof channel.destroy === "function"
		)
			channel.destroy();
		return "closed";
	};
	if (typeof bootstrap !== "function" || !coordinated) {
		const started = relay();
		return () => started;
	}
	let started: Promise<PresenterResult> | undefined;
	return () => {
		started ??= relay();
		return started;
	};
}

/** The refusal detail of a failed successor attempt, in the same machine-readable form an initial start reports. */
export function failureDetail(
	outcome: Exclude<StartupOutcome, { readonly kind: "ready" }>,
	cleanupFailure: string | undefined,
): string {
	return outcome.kind === "timeout"
		? startupTimeoutDetail(outcome, cleanupFailure ? "incomplete" : "completed")
		: outcome.cause.message;
}

/** The grant for one attempt: authority in the candidate's own generation directory, wake-up on its startup pipe. */
export function adoptionGrant(attempt: string, generationDir: string, child: ChildProcess) {
	const file = join(generationDir, ADOPTION_GRANT_FILE);
	return {
		async grant(): Promise<void> {
			await writeFile(file, `${JSON.stringify({ attempt })}\n`, { mode: 0o600 });
			const pipe: unknown = (child.stdio as readonly unknown[])[STARTUP_EVENT_FD];
			if (typeof pipe !== "object" || pipe === null || !("write" in pipe) || typeof pipe.write !== "function")
				throw new Error("the successor's startup pipe is gone");
			pipe.write(startupGrantLine(attempt));
		},
		revoke: () => rm(file, { force: true }),
	};
}

/**
 * Q1 (LEAD ruling, senpi#4602): the owner-token guard is claimed only against a predecessor that advertises it.
 * Without the capability the successor adopts the way it always did, and the old host's late-rename race remains.
 */
export function predecessorOwnerArgs(host: HostProtocolInfo): string[] {
	return host.instanceId !== undefined && host.capabilities.includes(ENDPOINT_OWNER_FENCE_CAPABILITY)
		? ["--replace-owner", host.instanceId]
		: [];
}
