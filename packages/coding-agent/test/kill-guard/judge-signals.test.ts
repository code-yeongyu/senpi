// senpi#5349 / code-yeongyu/oh-my-openagent#12096: the kill guard's judge, decided on synthetic process tables so every
// rule is deterministic on every OS. Nothing here sends a signal or reads the real process table.
import { describe, expect, it } from "vitest";
import { judgeArgv, judgeCommand, judgeSignal } from "../../src/core/kill-guard/index.ts";
import { AGENT, fixture, rule } from "./judge-fixtures.ts";

describe("kill targets", () => {
	it.each([
		["kill 12345"],
		["kill -9 12345"],
		["kill -s TERM 12345"],
		["kill %1"],
		["kill -0 400"],
		["kill -s 0 -1"],
		["kill -l"],
		["kill -L"],
		["kill -- -4000"],
		["kill -TERM -4000"],
		["sudo kill 4242"],
		["trap 'kill 0' EXIT; sleep 1"],
		["docker kill web"],
		["git log --grep kill"],
		['echo "kill -9 -1"'],
		["systemctl --user stop app"],
		["pgrep -af node"],
		["pgrep -f 'my-worker-[0-9]+' | xargs kill"],
	])("allows %s (C1-C6, C11, C12, C15, C16)", (command) => {
		expect(judgeCommand(command, fixture().context)).toEqual({ action: "allow" });
	});

	it.each([["kill -9 -1"], ["kill -- -1"], ["kill -1"], ["kill -s KILL -1"], ["kill -TERM 12 -1"]])(
		"refuses %s with R3 (C19)",
		(command) => {
			expect(rule(judgeCommand(command, fixture().context))).toBe("R3");
		},
	);

	it.each([["kill 1"], ["kill 400"], ["kill 300"], [`kill -9 ${AGENT}`], ["kill -- -400"]])(
		"refuses %s that names a protected process or its group (C22, R2/R4)",
		(command) => {
			expect(["R2", "R4"]).toContain(rule(judgeCommand(command, fixture().context)));
		},
	);

	it("resolves kill 0 from the caller's vantage (C20a, C20b, C6)", () => {
		expect(rule(judgeCommand("kill 0", fixture({ vantage: { kind: "agent" }, shell: "bun" }).context))).toBe("R4");
		expect(judgeCommand("kill 0", fixture({ vantage: { kind: "process", pid: 900 }, shell: "sh" }).context)).toEqual({
			action: "allow",
		});
		expect(judgeCommand("kill 0", fixture({ vantage: { kind: "fresh-session" } }).context)).toEqual({
			action: "allow",
		});
	});

	it("leaves R1/R2 to the user on native Windows and keeps R3 (C24)", () => {
		const windows = fixture({ platform: "win32", table: "unreadable" });
		expect(rule(judgeCommand("kill -9 -1", windows.context))).toBe("R3");
		expect(judgeCommand("pkill -f '.*'", windows.context)).toEqual({ action: "allow" });
	});
});

describe("dynamic arguments: L1 defers where the runtime layer will see the value, refuses where none will", () => {
	it.each([['pkill -f "$PATTERN"'], ["kill $PID"], ["kill $!"], ["pkill -u $USER"], ["kill -TERM $PPID"]])(
		"defers %s from the bash tool: it runs unjudged in PR 1 (C1d, C2, C10, C17, C22)",
		(command) => {
			expect(judgeCommand(command, fixture().context).action).toBe("defer");
		},
	);

	it.each([
		["sudo kill $PID", "defer"],
		["sudo kill -TERM $PID", "defer"],
		['env -i pkill -f "$P"', "R5"],
		["sudo kill -- -$G", "R5"],
		["sudo kill -$SIG $PID", "R5"],
		['/usr/bin/pkill -f "$P"', "R5"],
		["/bin/kill $PID", "R5"],
		["su - root -c 'pkill -f $P'", "R5"],
	] as const)(
		"%s under a PATH-resetting wrapper or a path spelling -> %s (A1, N2, C16d, C31d)",
		(command, expected) => {
			expect(rule(judgeCommand(command, fixture().context))).toBe(expected);
		},
	);

	it("judges a literal path spelling fully (C31)", () => {
		expect(judgeCommand("/usr/bin/pkill -f foo", fixture({ select: () => [600] }).context)).toEqual({
			action: "allow",
		});
	});

	it("refuses a dynamic group target to a builtin kill no wrapper sees (sh mode), and lets a dynamic pid run", () => {
		const sh = fixture({ shell: "sh", vantage: { kind: "process", pid: 900 } });
		expect(rule(judgeCommand("kill -- -$G", sh.context))).toBe("R5");
		expect(rule(judgeCommand("kill -TERM -$(cat pgid)", sh.context))).toBe("R5");
		expect(judgeCommand("kill $PID", sh.context).action).toBe("defer");
		expect(rule(judgeCommand("sh -c 'kill -- -$G'", fixture().context))).toBe("R5");
	});

	it("defers a command the lexer cannot parse unless it holds a literal kill -1 (C30, unparsed)", () => {
		expect(judgeCommand(`sh -c "pkill -f '$P'"`, fixture().context).action).toBe("defer");
		expect(rule(judgeCommand("case x in x) kill -9 -1;; esac", fixture().context))).toBe("R3");
		expect(judgeCommand("case x in x) pkill -f vite;; esac", fixture().context).action).toBe("defer");
		expect(judgeCommand("case x in x) ls;; esac", fixture().context)).toEqual({ action: "allow" });
	});
});

describe("spawn argv and signal calls", () => {
	it("judges argv directly and lexes a shell -c script (E5)", () => {
		expect(rule(judgeArgv(["pkill", "-f", "a||b"], fixture({ shell: "bun" }).context))).toBe("R1");
		expect(rule(judgeArgv(["sh", "-c", "kill -9 -1"], fixture({ shell: "bun" }).context))).toBe("R3");
		expect(rule(judgeArgv(["/usr/bin/env", "FOO=1", "pkill", "-f", ".*"], fixture({ shell: "bun" }).context))).toBe(
			"R1",
		);
		expect(judgeArgv(["echo", "pkill -f .*"], fixture({ shell: "bun" }).context)).toEqual({ action: "allow" });
	});

	it.each([
		[{ target: -1, group: false, signal: "SIGTERM" }, "R3"],
		[{ target: 0, group: false, signal: "SIGTERM" }, "R4"],
		[{ target: 1, group: false, signal: 9 }, "R2"],
		[{ target: 400, group: false, signal: "SIGTERM" }, "R2"],
		[{ target: 400, group: true, signal: "SIGTERM" }, "R4"],
		[{ target: 0, group: true, signal: "SIGKILL" }, "R4"],
		[{ target: 800, group: false, signal: "SIGTERM" }, "allow"],
		[{ target: -4000, group: false, signal: "SIGTERM" }, "allow"],
		[{ target: -1, group: false, signal: 0 }, "allow"],
		[{ target: 1, group: false, signal: 0 }, "allow"],
	] as const)("judges process.kill in the agent's thread %j -> %s (E6)", (call, expected) => {
		expect(rule(judgeSignal(call, fixture({ vantage: { kind: "agent" } }).context))).toBe(expected);
	});

	it("allows a py kernel to signal its own group and refuses the agent's (C20b, E8)", () => {
		const kernel = fixture({ vantage: { kind: "process", pid: 900 } }).context;
		expect(judgeSignal({ target: 0, group: true, signal: 9 }, kernel)).toEqual({ action: "allow" });
		expect(judgeSignal({ target: 0, group: false, signal: 15 }, kernel)).toEqual({ action: "allow" });
		expect(rule(judgeSignal({ target: AGENT, group: true, signal: 15 }, kernel))).toBe("R4");
		expect(rule(judgeSignal({ target: AGENT, group: false, signal: 15 }, kernel))).toBe("R2");
	});
});
