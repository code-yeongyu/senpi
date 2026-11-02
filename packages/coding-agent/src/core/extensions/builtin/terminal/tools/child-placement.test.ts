// senpi#3566 todo 9 / senpi#3740 review: a child's session ids carry its generation (`bash_c<gen>_<n>`), so they never
// match the server's own; each call is placed with the session's owner, a later generation reports the session lost,
// and the child's background start/exit reach the server's hooks.
import { describe, expect, it } from "vitest";
import {
	childTerminalIdScope,
	isChildSessionId,
	TERMINAL_CHILD_JOB_KINDS,
	terminalChildJob,
} from "./child-placement.ts";
import type { TerminalExitView, TerminalToolContext } from "./context.ts";

const ctx = {} as TerminalToolContext;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

describe("terminal child job result", () => {
	it("reports a child session lost once a later generation answers for it", () => {
		const output = terminalChildJob(ctx, TERMINAL_CHILD_JOB_KINDS.output);
		const id = `bash_${childTerminalIdScope(1)}_1`;
		const same = text("still running");
		expect(output.result?.({ bash_id: id }, same, 1)).toBe(same);
		const lost = output.result?.({ bash_id: id }, text(`unknown bash_id ${id}`), 2);
		expect(lost?.details).toEqual({ bash_id: id, lost: true, generation: 1 });
	});

	it("passes through results for server ids and for calls without an id", () => {
		const kill = terminalChildJob(ctx, TERMINAL_CHILD_JOB_KINDS.kill);
		const value = text("unknown bash_id zz");
		expect(kill.result?.({ bash_id: "bash_3" }, value, 3)).toBe(value);
		expect(kill.result?.({ all: true }, value, 3)).toBe(value);
	});
});

describe("terminal child job placement", () => {
	it("places each call with the owner its id names", () => {
		expect(isChildSessionId("bash_c2_1")).toBe(true);
		expect(isChildSessionId("bash_1")).toBe(false);
		const output = terminalChildJob(ctx, TERMINAL_CHILD_JOB_KINDS.output);
		expect(output.placement?.({ bash_id: "bash_c2_1" })).toBe("child");
		expect(output.placement?.({ bash_id: "bash_1" })).toBe("server");
		expect(output.placement?.({ bash_id: "mon_abc" })).toBe("server");
		expect(output.placement?.({ bash_id: "watch_1" })).toBe("server");
		const kill = terminalChildJob(ctx, TERMINAL_CHILD_JOB_KINDS.kill);
		expect(kill.placement?.({ all: true })).toBe("both");
		expect(terminalChildJob(ctx, TERMINAL_CHILD_JOB_KINDS.bash).placement).toBeUndefined();
	});
});

describe("terminal child background relay", () => {
	it("hands the child's start and exit to the server hooks, and ends a session lost with its generation", () => {
		const started: string[] = [];
		const exits: Array<{ id: string; output: string; code: number | null | undefined }> = [];
		const hooks = {
			onBackgroundStart: (id: string) => started.push(id),
			onBackgroundExit: (id: string, runtime: TerminalExitView) =>
				exits.push({ id, output: runtime.fullOutput(), code: runtime.exitResult?.exitCode }),
		} as Partial<TerminalToolContext> as TerminalToolContext;
		const bash = terminalChildJob(hooks, TERMINAL_CHILD_JOB_KINDS.bash);
		bash.wake?.({ event: "background_start", id: "bash_c1_1", description: "a", startedAtMs: 1 }, 1);
		bash.wake?.({ event: "background_start", id: "bash_c1_2", description: "b", startedAtMs: 2 }, 1);
		bash.wake?.(
			{
				event: "background_exit",
				id: "bash_c1_1",
				exit: { exitCode: 0, signal: null, cancelled: false, timedOut: false },
				output: "done",
			},
			1,
		);
		bash.wake?.({ event: "background_start", id: "bash_1", description: "server id", startedAtMs: 3 }, 1);
		expect(started).toEqual(["bash_c1_1", "bash_c1_2"]);
		expect(exits).toEqual([{ id: "bash_c1_1", output: "done", code: 0 }]);

		bash.childExited?.(1);
		expect(exits.map((exit) => exit.id)).toEqual(["bash_c1_1", "bash_c1_2"]);
		expect(exits[1]?.output).toContain("tool child (generation 1) exited");
		bash.childExited?.(1);
		expect(exits).toHaveLength(2);
	});
});
