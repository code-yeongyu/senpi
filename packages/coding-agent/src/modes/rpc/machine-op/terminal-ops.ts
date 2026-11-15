/**
 * The run step of exec_command, write_stdin, wait_for_command and kill_terminal (the relay host's `terminal-ops.ts`,
 * ported onto the engine's terminals). Each answers the relay host's shapes: TerminalResult (lastSeq, totalBytes byte
 * offsets), and the kill result {handleId, state: "task-failed", reason: "killed", lifecycle}. An unknown handle fails
 * unknown_handle; a last_seq older than the retained output fails replay_gap naming the retained offset.
 */
import { type After, ENDED, ended } from "./live-handle.ts";
import type { MachineTerminals } from "./machine-terminals.ts";
import { spawnPathIn } from "./real-path.ts";
import type { ExecArgs, KillArgs, WaitArgs, WriteStdinArgs } from "./terminal-args.ts";
import { createInputQueues } from "./terminal-input.ts";
import { lifecycleOf, replayGap, terminalResult, waitForHandle } from "./terminal-wait.ts";
import type { OpOutcome } from "./wire.ts";

export interface TerminalRun {
	readonly sender: string;
	readonly root: string;
	readonly confined: boolean;
	readonly signal: AbortSignal;
	readonly envOverlay: Readonly<Record<string, string>>;
}

const fail = (code: string, message: string): OpOutcome => ({ state: "failed", error: { code, message } });
const applied = (response: Readonly<Record<string, unknown>>): OpOutcome => ({ state: "applied", response });

export const createTerminalOps = (terminals: MachineTerminals, after: After) => {
	const input = createInputQueues(after);
	const now = (): number => Date.now();
	// A handle no longer in memory answers from its summary row, as the relay host answers from its handle table.
	const gone = (id: string): OpOutcome => {
		const r = terminals.record(id);
		if (r === undefined) return fail("unknown_handle", `no handle ${id} on this host`);
		return applied({
			handleId: id,
			output: "",
			state: ended(r.state) ? "completed" : "running",
			lifecycle: lifecycleOf(r.state, { exitCode: r.exitCode, signal: null }, "agent_restarted"),
			lastSeq: 0,
			truncated: false,
			omittedBytes: 0,
			totalBytes: 0,
			...(r.exitCode === null ? {} : { exitCode: r.exitCode }),
			startedAtMs: r.startedMs,
			reason: "exited",
		});
	};

	return {
		execCommand: async (d: ExecArgs, call: TerminalRun): Promise<OpOutcome> => {
			const cwd = d.cwd === undefined ? call.root : await spawnPathIn(call.root, d.cwd, call.confined);
			const h = await terminals.spawn({
				sender: call.sender,
				command: d.command,
				cwd,
				env: call.envOverlay,
				...(d.cols === undefined ? {} : { cols: d.cols }),
				...(d.rows === undefined ? {} : { rows: d.rows }),
			});
			const reason = await waitForHandle(h, { yieldMs: d.yieldMs, until: { states: ENDED } }, call.signal, after);
			return applied(terminalResult(h, 0, now(), { pid: h.pid, reason }));
		},
		writeStdin: async (d: WriteStdinArgs, call: TerminalRun): Promise<OpOutcome> => {
			const h = terminals.get(d.handle);
			if (h === undefined) return gone(d.handle);
			if (ended(h.state())) return fail("stdin_closed", `handle ${d.handle} has ended`);
			const before = h.produced();
			const effect = await input.write(
				h,
				{
					...(d.data === undefined ? {} : { data: new TextEncoder().encode(d.data) }),
					...(d.keys === undefined ? {} : { keys: d.keys }),
					paste: d.paste,
				},
				d.expectMs,
			);
			const reason = await waitForHandle(h, { yieldMs: d.yieldMs }, call.signal, after);
			const observed = effect.observed ?? h.produced() > before;
			return applied(
				terminalResult(h, d.lastSeq ?? before, now(), {
					stdinEffect: { acceptedBytes: effect.acceptedBytes, observed },
					reason,
				}),
			);
		},
		waitForCommand: async (d: WaitArgs, call: TerminalRun): Promise<OpOutcome> => {
			const h = terminals.get(d.handle);
			if (h === undefined) return gone(d.handle);
			const gap = replayGap(h, d.lastSeq);
			if (gap !== undefined) return fail("replay_gap", gap);
			const reason = await waitForHandle(
				h,
				{
					yieldMs: d.yieldMs,
					...(d.lastSeq === undefined ? {} : { lastSeq: d.lastSeq }),
					...(d.until === undefined ? {} : { until: d.until }),
				},
				call.signal,
				after,
			);
			// A wait without last_seq answers with the newest retained page, never only what follows it (#1172, #1217).
			return applied(
				terminalResult(h, d.lastSeq ?? 0, now(), { reason }, d.lastSeq === undefined ? "newest" : "oldest"),
			);
		},
		killTerminal: async (d: KillArgs): Promise<OpOutcome> => {
			const h = terminals.get(d.handle);
			if (h === undefined) {
				const r = terminals.record(d.handle);
				if (r === undefined) return fail("unknown_handle", `no handle ${d.handle} on this host`);
				return applied({
					handleId: d.handle,
					state: "task-failed",
					reason: "killed",
					lifecycle: lifecycleOf(r.state, { exitCode: r.exitCode, signal: null }, "agent_restarted"),
				});
			}
			await terminals.kill(h);
			return applied({
				handleId: h.id,
				state: "task-failed",
				reason: "killed",
				lifecycle: lifecycleOf(h.state(), h.exit()),
			});
		},
	};
};
export type TerminalOps = ReturnType<typeof createTerminalOps>;
