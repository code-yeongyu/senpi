// senpi#5349 / code-yeongyu/oh-my-openagent#12096 (L2): an interactive bash reads no BASH_ENV, so the PROMPT_COMMAND hook
// sources the same `kill` wrapper before the first prompt, after the user's startup files, and every line the shell
// runs (typed, history-expanded, in a child shell) reaches it. Each script first stops the shell when `kill` is not the
// guard's wrapper and records the shell's own `kill` instead of running it, so no test here sends a signal.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { killGuardEnvironment } from "../../src/core/kill-guard/runtime.ts";
import { createShimFixture, posix, SHELL_KILL_RECORDER, type ShimFixture, TAG } from "./shim-fixtures.ts";

const WRAPPED = "if ! declare -f kill | grep -q __senpi_kg_decide; then echo NOT-WRAPPED; exit 99; fi";
const GUARDED = [WRAPPED, SHELL_KILL_RECORDER];
const ALL_PROCESSES = `${TAG} refused (R3 ALL_PROCESSES)`;

let f: ShimFixture;
beforeAll(() => {
	f = createShimFixture();
});
afterAll(() => f.cleanup());

const lines = (...typed: string[]) => `${[...typed, "exit"].join("\n")}\n`;

function homeWith(name: string, rc: string): string {
	const home = join(f.root, name);
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, ".bashrc"), rc);
	return home;
}

describe.runIf(posix)("bash's builtin kill in an interactive bash, through the PROMPT_COMMAND hook", () => {
	it.each([[["-i"]], [["--norc", "-i"]], [["--posix", "-i"]]])(
		"refuses `kill -9 -1` typed after the first prompt and hands an allowed kill to the shell (bash %j)",
		(args) => {
			const result = f.runInteractive(args, lines(...GUARDED, 'kill -9 -1; echo "status=$?"', "kill 4242"), f.env());

			expect(result.stdout).not.toContain("NOT-WRAPPED");
			expect(result.stdout).toContain("status=126");
			expect(result.stderr).toContain(ALL_PROCESSES);
			expect(result.real).toBe("builtin [kill] [4242]\n");
		},
	);

	it("refuses at execution a `kill -9 -1` that history expansion builds from an allowed `echo kill -9 -1`", () => {
		const result = f.runInteractive(
			["--norc", "-i"],
			lines(...GUARDED, "echo kill -9 -1", "!!:1*", 'echo "status=$?"'),
			f.env(),
		);

		expect(result.stdout).toContain("kill -9 -1\nstatus=126");
		expect(result.stderr).toContain(ALL_PROCESSES);
		expect(result.real).toBe("");
	});

	it("defines its wrapper after ~/.bashrc, so a `kill` function from the rc file is overridden", () => {
		const home = homeWith("home-rc-kill", "kill() { :; }\n");

		const result = f.runInteractive(["-i"], lines(...GUARDED, 'kill -9 -1; echo "status=$?"'), f.env({ HOME: home }));

		expect(result.stdout).not.toContain("NOT-WRAPPED");
		expect(result.stdout).toContain("status=126");
	});

	it("guards a child interactive bash started inside the first one (the once-marker is not inherited)", () => {
		const child = ["bash --norc -i <<'CHILD'", ...GUARDED, 'kill -9 -1; echo "child=$?"', "exit", "CHILD"];

		const result = f.runInteractive(["--norc", "-i"], lines(...child), f.env());

		expect(result.stdout).not.toContain("NOT-WRAPPED");
		expect(result.stdout).toContain("child=126");
		expect(result.real).toBe("");
	});

	it("after `enable -n kill` still refuses `kill -9 -1` and runs an allowed kill through the PATH shim", () => {
		const result = f.runInteractive(
			["--norc", "-i"],
			lines(WRAPPED, "enable -n kill || exit 99", 'kill 4242; echo "own=$?"', 'kill -9 -1; echo "all=$?"'),
			f.env(),
		);

		expect(result.stdout).toContain("own=0");
		expect(result.stdout).toContain("all=126");
		expect(result.real).toBe("kill [4242]\n");
	});

	it("runs the user's own PROMPT_COMMAND after the hook, with $? as the last command left it", () => {
		const result = f.runInteractive(
			["--norc", "-i"],
			lines(WRAPPED, "false"),
			f.env({ PROMPT_COMMAND: 'echo "user-prompt rc=$?"' }),
		);

		expect(result.stdout).toContain("user-prompt rc=0\nuser-prompt rc=1\n");
	});

	it("keeps the user's PROMPT_COMMAND under a nested agent, whose shells reach their prompt (C1)", () => {
		const outer = f.env({ PROMPT_COMMAND: "echo user-prompt" });
		const nested = { ...outer, ...killGuardEnvironment(outer, f.runtime()) };

		const result = f.runInteractive(["--norc", "-i"], lines(WRAPPED, "echo alive"), nested);

		expect(nested.SENPI_KILL_GUARD_USER_PROMPT_COMMAND).toBe("echo user-prompt");
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("user-prompt\nalive\n");
	});

	it("leaves the PATH shims judging pkill and an external kill when ~/.bashrc overwrites PROMPT_COMMAND (R-b)", () => {
		const home = homeWith("home-rc-prompt", "PROMPT_COMMAND='echo user-prompt'\n");

		const result = f.runInteractive(
			["-i"],
			lines("type -t kill", 'pkill -f x; echo "pkill=$?"', 'env kill -9 -1; echo "env=$?"'),
			f.env({ HOME: home, FAKE_JUDGE_MODE: "refuse" }),
		);

		expect(result.stdout).toContain("user-prompt");
		expect(result.stdout).toContain("builtin\n");
		expect(result.judge).toContain("[pkill] [-f] [x]\n");
		expect(result.stdout).toContain("pkill=126");
		expect(result.stdout).toContain("env=126");
		expect(result.stderr).toContain(ALL_PROCESSES);
		expect(result.real).toBe("");
	});
});
