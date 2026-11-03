// senpi#5349 / code-yeongyu/oh-my-openagent#12096 (L2): `__kill-guard check` is what the runtime shims ask. It decides
// the real, expanded argv from the vantage of the process that will send the signal; the rows below are the ones the
// design marks green only once the runtime layer exists. Synthetic process tables; nothing is signalled.
import { describe, expect, it } from "vitest";
import { KILL_GUARD_COMMAND, runKillGuardCheck } from "../../src/core/kill-guard/check-command.ts";
import { AGENT, fixture } from "./judge-fixtures.ts";

interface Outcome {
	readonly status: number;
	readonly stderr: string;
}

function check(
	argv: readonly string[],
	options: { vantage?: number; select?: (args: readonly string[]) => readonly number[]; agentPid?: string } = {},
): Outcome {
	let stderr = "";
	const status = runKillGuardCheck(
		[KILL_GUARD_COMMAND, "check", "--vantage", String(options.vantage ?? 800), "--", ...argv],
		{
			env: { SENPI_KILL_GUARD_AGENT_PID: options.agentPid ?? String(AGENT) },
			platform: "linux",
			view: fixture(options.select === undefined ? {} : { select: options.select }).context.view,
			writeError: (text) => {
				stderr += text;
			},
		},
	);
	return { status, stderr };
}

describe("__kill-guard check", () => {
	it("allows a narrow pattern that was dynamic in the command text (C10)", () => {
		expect(check(["pkill", "-f", "vite --port 5173"], { select: () => [600] })).toEqual({ status: 0, stderr: "" });
	});

	it("refuses a broad pattern that only appeared at run time (C30, C18)", () => {
		const outcome = check(["pkill", "-f", 'paid" 2>/dev/null || echo 1']);
		expect(outcome.status).toBe(126);
		expect(outcome.stderr).toMatch(/^\[senpi:kill-guard\] refused \(R1 BROAD_PATTERN\)/);
	});

	it("allows the pids `xargs kill` and `kill $PID` expanded to when none is protected (C12, C1d)", () => {
		expect(check(["kill", "600", "700"]).status).toBe(0);
		expect(check(["kill", "-TERM", "4001"]).status).toBe(0);
	});

	it("refuses a dynamic pid that turned out to be the agent's parent or the agent (C22)", () => {
		expect(check(["kill", "400"]).stderr).toContain("(R2 PROTECTED_TARGET)");
		expect(check(["kill", "-9", String(AGENT)]).status).toBe(126);
	});

	it("refuses a selection that reaches the agent's ancestors (C17)", () => {
		const outcome = check(["pkill", "-u", "501"], { select: () => [300, 400, AGENT, 600] });
		expect(outcome.status).toBe(126);
		expect(outcome.stderr).toContain("(R2 PROTECTED_TARGET)");
	});

	it("resolves `kill 0` against the process that sends it", () => {
		expect(check(["kill", "0"], { vantage: AGENT }).stderr).toContain("(R4 GROUP)");
		expect(check(["kill", "0"], { vantage: 800 })).toEqual({ status: 0, stderr: "" });
	});

	it("refuses every-process targets (R3)", () => {
		expect(check(["kill", "--", "-1"]).stderr).toContain("(R3 ALL_PROCESSES)");
	});

	it.each([
		[[KILL_GUARD_COMMAND, "check", "--", "kill", "1"]],
		[[KILL_GUARD_COMMAND, "check", "--vantage", "x", "--", "kill", "1"]],
		[[KILL_GUARD_COMMAND, "check", "--vantage", "800", "--"]],
		[[KILL_GUARD_COMMAND, "judge", "--vantage", "800", "--", "kill", "1"]],
	])("exits 2 on a malformed call, so the shim fails closed: %j", (args) => {
		let stderr = "";
		const status = runKillGuardCheck(args, {
			env: { SENPI_KILL_GUARD_AGENT_PID: String(AGENT) },
			writeError: (text) => {
				stderr += text;
			},
		});
		expect(status).toBe(2);
		expect(stderr).toContain(KILL_GUARD_COMMAND);
	});

	it("exits 2 without the agent pid, so the shim fails closed instead of guessing the protected set", () => {
		expect(check(["kill", "4001"], { agentPid: "" }).status).toBe(2);
	});
});
