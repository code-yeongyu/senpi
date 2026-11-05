// senpi#5349 / code-yeongyu/oh-my-openagent#12096 (L2): bash's builtin `kill` is judged through the BASH_ENV wrapper.
// The prelude below stops before any `kill` when the wrapper is missing and records the shell's own `kill` (through
// `command` or `builtin`) instead of running it, and every pid an allowed `kill` names is a sleeper this file spawned in
// its own process group, so even a broken wrapper signals nothing the test does not own.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createShimFixture,
	type OwnedSleeper,
	posix,
	SHELL_KILL_RECORDER,
	type ShimFixture,
	spawnOwnedSleeper,
	TAG,
} from "./shim-fixtures.ts";

const bashAvailable = posix && spawnSync("bash", ["-c", "true"]).status === 0;
const PRELUDE = [SHELL_KILL_RECORDER, 'if [ "$(type -t kill)" != function ]; then echo NOT-WRAPPED; exit 99; fi'].join(
	"\n",
);

/** `bash -c script` with a piped stdin, as the bash tool's stdin transport spawns it: libuv makes that pipe a socket. */
async function runWithPipedStdin(script: string, env: NodeJS.ProcessEnv): Promise<string> {
	const child = spawn("bash", ["-c", script], { env, stdio: ["pipe", "pipe", "ignore"] });
	let stdout = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	const closed = once(child, "close");
	child.stdin.end();
	await closed;
	return stdout;
}

let f: ShimFixture;
let target: OwnedSleeper;
let guarded: OwnedSleeper;
beforeAll(() => {
	f = createShimFixture();
	target = spawnOwnedSleeper();
	guarded = spawnOwnedSleeper();
});
afterAll(() => {
	target.stop();
	guarded.stop();
	f.cleanup();
});

/** The fixture's environment with `guarded`'s pid on the host's protected list. */
const guardedEnv = (extra: Record<string, string> = {}) => f.env(extra, { protectedPids: [1, guarded.pid] });

describe.runIf(bashAvailable)("bash's builtin kill through BASH_ENV", () => {
	it("judges a dynamic positive pid on its value and runs the builtin (C1d)", () => {
		const result = f.run("bash", `${PRELUDE}\nPID=${target.pid}; kill $PID`, f.env());
		expect(result.stdout).not.toContain("NOT-WRAPPED");
		expect(result.status).toBe(0);
		expect(result.judge).toBe("");
		expect(result.real).toBe(`builtin [kill] [${target.pid}]\n`);
	});

	it("refuses a dynamic protected pid through the judge and never reaches the builtin (C22)", () => {
		const script = `${PRELUDE}\nP=${guarded.pid}; kill -9 $P; echo "status=$?"`;
		const result = f.run("bash", script, guardedEnv({ FAKE_JUDGE_MODE: "refuse" }));
		expect(result.stdout).toContain("status=126");
		expect(result.judge).toContain(`[--] [kill] [-9] [${guarded.pid}]\n`);
		expect(result.real).toBe("");
	});

	it("refuses a dynamic -1 in bash without starting the judge (R3)", () => {
		const result = f.run("bash", `${PRELUDE}\nT=-1; kill -9 $T; echo "status=$?"`, f.env());
		expect(result.stdout).toContain("status=126");
		expect(result.stderr).toContain(`${TAG} refused (R3 ALL_PROCESSES)`);
		expect(result.judge).toBe("");
		expect(result.real).toBe("");
	});

	it("passes job specs and a process-group target to the judge as written, then to the builtin", () => {
		const result = f.run("bash", `${PRELUDE}\nkill %1; kill -- -${target.pid}`, f.env());
		expect(result.status).toBe(0);
		expect(result.judge).toContain("[--] [kill] [%1]\n");
		expect(result.judge).toContain(`[--] [kill] [--] [-${target.pid}]\n`);
		expect(result.real).toBe(`builtin [kill] [%1]\nbuiltin [kill] [--] [-${target.pid}]\n`);
	});

	it("records a `builtin kill` that bypasses the wrapper's `command kill` instead of running it", () => {
		const bypass = `function kill { builtin kill "$@"; }`;
		const result = f.run("bash", `${PRELUDE}\n${bypass}\nkill -TERM ${target.pid}`, f.env());
		expect(result.status).toBe(0);
		expect(result.real).toBe(`builtin-bypass [kill] [-TERM] [${target.pid}]\n`);
	});

	it("works under `set -eu`, where a refusal fails the command like a failed kill", () => {
		const script = `set -eu\n${PRELUDE}\nkill ${target.pid}\nkill ${guarded.pid} || echo "refused=$?"\necho done`;
		const result = f.run("bash", script, guardedEnv({ FAKE_JUDGE_MODE: "refuse" }));
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("refused=126\ndone\n");
		expect(result.real).toBe(`builtin [kill] [${target.pid}]\n`);
	});

	it("sources the user's own BASH_ENV before defining the wrapper", () => {
		const userEnv = join(f.root, "user-bash-env.sh");
		writeFileSync(userEnv, "USER_ENV_LOADED=yes\n");
		const result = f.run("bash", 'echo "$USER_ENV_LOADED"; type -t kill', f.env({ BASH_ENV: userEnv }));
		expect(result.stdout).toBe("yes\nfunction\n");
	});

	it("wraps kill when stdin is a socket and the environment had no SHLVL (bash's rshd rule)", async () => {
		const env = f.env();
		const stdout = await runWithPipedStdin("[ -S /dev/stdin ] && echo socket; type -t kill", env);
		expect(stdout).toBe("socket\nfunction\n");
	});

	it("does not reach a POSIX-mode /bin/sh, whose builtin kill stays unwrapped (residual 1)", () => {
		const result = f.run("/bin/sh", "type kill", f.env());
		expect(result.stdout).toContain("kill");
		expect(result.stdout).not.toContain("function");
	});
});
