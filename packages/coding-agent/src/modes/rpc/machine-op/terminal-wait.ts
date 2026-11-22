/**
 * The relay host's `wait_for_command` and TerminalResult (its `wait.ts`, ported): a wait holds at most `yieldMs` and
 * answers on the first event, never by polling. Without `until`: a lifecycle change, the exit, or retained output past
 * `lastSeq` (at once). `until.states`: the lifecycle reaching one of them; `until.output`: that text in output produced
 * after the wait began (the last WAIT_SEEN_MAX bytes are matched); `until.idle`: a settled quiet period. An ended
 * handle answers at once. `lastSeq` and `totalBytes` are byte offsets.
 */
import { constants } from "node:os";
import { MachineOpError } from "@code-yeongyu/senpi-machine-ops";
import {
	type After,
	ended,
	type HandleEvent,
	type HandleExit,
	type LiveHandle,
	type MachineLifecycle,
} from "./live-handle.ts";

const WAIT_SEEN_MAX = 64 * 1024;
/** The most output one result carries; the rest stays retained and `lastSeq` stops where this output ends. */
const RESULT_OUTPUT_MAX = 32 * 1024;

export type WaitUntil = Readonly<{ states?: readonly MachineLifecycle[]; output?: string; idle?: true }>;
export type WaitAsk = Readonly<{ yieldMs: number; lastSeq?: number; until?: WaitUntil }>;
export type WaitReason = "exited" | "state" | "output" | "matched" | "idle" | "timeout";

/** The relay host's replay_gap message (it names the offset replay resumes at), when `lastSeq` precedes the retained output. */
export const replayGap = (h: LiveHandle, lastSeq: number | undefined): string | undefined =>
	lastSeq !== undefined && lastSeq < h.retainedFrom()
		? `last_seq ${lastSeq} precedes retained output at ${h.retainedFrom()} (${h.retainedFrom() - lastSeq} bytes omitted)`
		: undefined;

const immediate = (h: LiveHandle, ask: WaitAsk): WaitReason | undefined => {
	const state = h.state();
	if (ended(state)) return "exited";
	const until = ask.until;
	if (until?.states?.includes(state) === true) return "state";
	if (until?.idle === true && h.quiet()) return "idle";
	if (until === undefined && ask.lastSeq !== undefined && ask.lastSeq < h.produced()) return "output";
	return undefined;
};

export const waitForHandle = (h: LiveHandle, ask: WaitAsk, signal: AbortSignal, after: After): Promise<WaitReason> => {
	const now = immediate(h, ask);
	if (now !== undefined) return Promise.resolve(now);
	if (signal.aborted) return Promise.reject(new MachineOpError("aborted", "the wait was cancelled"));
	const until = ask.until;
	return new Promise<WaitReason>((resolve, reject) => {
		const decoder = new TextDecoder();
		let seen = "";
		const finish = (reason: WaitReason): void => {
			cancel();
			unsubscribe();
			signal.removeEventListener("abort", aborted);
			resolve(reason);
		};
		const aborted = (): void => {
			cancel();
			unsubscribe();
			reject(new MachineOpError("aborted", "the wait was cancelled"));
		};
		const onEvent = (e: HandleEvent): void => {
			if (e.kind === "state") {
				if (ended(e.state)) return finish("exited");
				if (until === undefined || until.states?.includes(e.state) === true) finish("state");
				return;
			}
			if (e.kind === "idle") {
				if (until?.idle === true) finish("idle");
				return;
			}
			if (until?.output === undefined) return;
			seen = (seen + decoder.decode(e.bytes, { stream: true })).slice(-WAIT_SEEN_MAX);
			if (seen.includes(until.output)) finish("matched");
		};
		const unsubscribe = h.on(onEvent);
		const cancel = after(ask.yieldMs, () => finish("timeout"));
		signal.addEventListener("abort", aborted, { once: true });
	});
};

type Lifecycle =
	| Readonly<{ state: "starting" | "running" | "waiting_input"; stdinOpen: true; outputClosed: false }>
	| Readonly<{ state: "exited"; exitCode: number; stdinOpen: false; outputClosed: true }>
	| Readonly<{ state: "killed"; stdinOpen: false; outputClosed: true }>
	| Readonly<{
			state: "lost";
			reason: "agent_restarted" | "exit_status_unavailable";
			stdinOpen: false;
			outputClosed: true;
	  }>;

/** A program ended by a signal reports 128 + the signal number, as a shell does. */
const exitCodeOf = (exit: HandleExit): number => {
	if (exit.exitCode !== null) return exit.exitCode;
	const signal = exit.signal;
	if (signal === null) return -1;
	const named = constants.signals[(signal.startsWith("SIG") ? signal : `SIG${signal}`) as NodeJS.Signals];
	const number = named ?? (/^\d+$/.test(signal) ? Number(signal) : undefined);
	return number === undefined ? -1 : 128 + number;
};

export const lifecycleOf = (
	state: MachineLifecycle,
	exit: HandleExit | null,
	lostReason: "agent_restarted" | "exit_status_unavailable" = "exit_status_unavailable",
): Lifecycle => {
	switch (state) {
		case "starting":
		case "running":
		case "waiting_input":
			return { state, stdinOpen: true, outputClosed: false };
		case "exited":
			return {
				state,
				exitCode: exitCodeOf(exit ?? { exitCode: null, signal: null }),
				stdinOpen: false,
				outputClosed: true,
			};
		case "killed":
			return { state, stdinOpen: false, outputClosed: true };
		case "lost":
			return { state, reason: lostReason, stdinOpen: false, outputClosed: true };
	}
};

/**
 * The relay host's TerminalResult for a live handle, carrying at most RESULT_OUTPUT_MAX bytes of output.
 * - "oldest" (a wait with a cursor, exec, write_stdin): the output from `fromSeq`, paging forward.
 * - "newest" (a wait without a cursor, #1217): the last RESULT_OUTPUT_MAX bytes, so `lastSeq` reaches totalBytes. The
 *   page starts on a UTF-8 character boundary, stepping past at most 3 continuation bytes, so output that is not UTF-8
 *   still yields its newest bytes.
 */
export const terminalResult = (
	h: LiveHandle,
	fromSeq: number,
	nowMs: number,
	extra: Readonly<Record<string, unknown>> = {},
	window: "oldest" | "newest" = "oldest",
): Readonly<Record<string, unknown>> => {
	const retained = Math.min(Math.max(fromSeq, h.retainedFrom()), h.produced());
	const span = h.since(retained);
	let skip = window === "newest" ? Math.max(0, span.byteLength - RESULT_OUTPUT_MAX) : 0;
	const boundaryLimit = skip + 3;
	while (skip > 0 && skip < boundaryLimit && skip < span.byteLength && ((span[skip] ?? 0) & 0xc0) === 0x80) skip += 1;
	const from = retained + skip;
	const all = span.subarray(skip);
	const bytes = all.subarray(0, RESULT_OUTPUT_MAX);
	const state = h.state();
	const lifecycle = lifecycleOf(state, h.exit());
	return {
		handleId: h.id,
		output: new TextDecoder().decode(bytes),
		state: ended(state) ? "completed" : "running",
		lifecycle,
		lastSeq: from + bytes.byteLength,
		truncated: from > fromSeq || bytes.byteLength < all.byteLength,
		omittedBytes: Math.max(0, from - fromSeq),
		totalBytes: h.produced(),
		...(lifecycle.state === "exited" ? { exitCode: lifecycle.exitCode } : {}),
		startedAtMs: h.startedMs,
		elapsedMs: Math.max(0, nowMs - h.startedMs),
		...extra,
	};
};
