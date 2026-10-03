/**
 * HOW A GENERATION'S END IS READ: the exit verdict, and the terminal record of it (senpi#2566).
 *
 * Split out of `host-lifecycle.ts` because that file is far past the per-file ceiling and this is
 * one cohesive unit - deciding whether the host stopped, was stopped, or died, and recording it.
 */
import { crashingRuntimeVersions } from "../../core/process-crash-record.ts";
import { type HostCrashRecord, type HostStopSender, recordTerminalHostRecord } from "./host-crash-record.ts";
import type { HostGenerationPaths } from "./host-daemon-paths.ts";
import { recentStall, STOP_STALL_EVIDENCE_MAX_AGE_MS } from "./host-stalled-evidence.ts";
import { consumeStopIntent, type HostStopIntent } from "./host-stop-intent.ts";

/**
 * The RPC host exits 0 only through its own clean shutdown path - including its idle/empty-host
 * policy - so that is an intentional stop, not a crash: the supervisor mirrors its own idle exit
 * instead of reporting failure. Any non-zero code or signal stays a crash.
 */
export function classifyChildExit(
	code: number | null,
	signal: NodeJS.Signals | null,
): { reason: string; exitCode: number } {
	if (code === 0 && signal === null) return { reason: "rpc host exited on its own idle policy", exitCode: 0 };
	return { reason: `rpc host process exited unexpectedly (${code ?? signal})`, exitCode: 1 };
}

export interface ChildExitContext {
	readonly daemonDir: string;
	readonly generation: HostGenerationPaths;
	readonly instanceId: string;
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly childStartedAt: number;
	/** Set while the supervisor is shutting down: the stop is the engine's even without an intent file. */
	readonly shutdown?: { readonly reason: string; readonly supervisor: HostStopSender };
	readonly now?: number;
}

/**
 * Record how the host child ended. A fresh stop intent for THIS generation makes it an `engine_stop`
 * naming the intent's sender; a supervisor shutdown without one is the supervisor's own stop; a signal
 * nobody announced is `external`; any other non-zero exit is the supervisor's observation of a crash.
 * A clean exit the host chose itself writes nothing. Never throws.
 */
export async function noteChildExit(context: ChildExitContext): Promise<void> {
	const now = context.now ?? Date.now();
	const intent = await consumeStopIntent(context.generation, now).catch(() => undefined);
	const outcome = describeExit(context, intent);
	if (outcome === undefined) return;
	const stall = await recentStall(context.generation, now, STOP_STALL_EVIDENCE_MAX_AGE_MS).catch(() => undefined);
	await recordTerminalHostRecord(context.daemonDir, {
		at: new Date(now).toISOString(),
		...(context.signal === null ? { code: context.code ?? undefined } : { signal: context.signal }),
		uptimeMs: Math.max(0, now - context.childStartedAt),
		kind: "rpc-host",
		generation: context.instanceId,
		...outcome,
		...(stall ? { stall: { driftMs: stall.driftMs, at: stall.at, attributedSessionId: stall.sessionId } } : {}),
		...crashingRuntimeVersions(),
	}).catch(() => undefined);
}

type ExitOutcome = Pick<HostCrashRecord, "detection" | "sender" | "chain" | "reason" | "stopIntent">;

function describeExit(context: ChildExitContext, intent: HostStopIntent | undefined): ExitOutcome | undefined {
	if (intent !== undefined) {
		return {
			detection: "engine_stop",
			sender: intent.sender,
			...(intent.chain ? { chain: intent.chain } : {}),
			reason: intent.reason,
			stopIntent: true,
		};
	}
	if (context.shutdown !== undefined) {
		return {
			detection: "engine_stop",
			sender: context.shutdown.supervisor,
			reason: context.shutdown.reason,
			stopIntent: false,
		};
	}
	if (classifyChildExit(context.code, context.signal).exitCode === 0) return undefined;
	const selfInflicted = context.signal === null || SELF_INFLICTED_SIGNALS.has(context.signal);
	return { detection: selfInflicted ? "supervisor" : "external", stopIntent: false };
}

/** Signals a process raises against itself when it crashes; anything else was sent from outside. */
const SELF_INFLICTED_SIGNALS: ReadonlySet<string> = new Set([
	"SIGSEGV",
	"SIGBUS",
	"SIGABRT",
	"SIGILL",
	"SIGFPE",
	"SIGTRAP",
	"SIGSYS",
]);

/**
 * The terminal record a CALLER writes after it had to SIGKILL a supervisor: a SIGKILLed supervisor
 * runs no exit handler, so the caller is the only process guaranteed to survive this path. It writes
 * BEFORE it releases or clears the registration, whose recursive removal takes the intent with it.
 */
export async function noteEscalatedStop(
	daemonDir: string,
	instanceId: string,
	intent: HostStopIntent,
	now: number = Date.now(),
): Promise<void> {
	await recordTerminalHostRecord(daemonDir, {
		at: new Date(now).toISOString(),
		signal: "SIGKILL",
		uptimeMs: 0,
		kind: "rpc-host",
		generation: instanceId,
		detection: "engine_stop",
		sender: intent.sender,
		...(intent.chain ? { chain: intent.chain } : {}),
		reason: `${intent.reason}; supervisor_escalated`,
		stopIntent: true,
	}).catch(() => undefined);
}
