// senpi#5349 / code-yeongyu/oh-my-openagent#12096 (L2): bash's builtin `kill` is judged through the BASH_ENV wrapper.
// The prelude below stops before any `kill` when the wrapper is missing and records the shell's own `kill` that the
// wrapper hands an allowed argv to, so no test here sends a signal even if the wrapper is broken.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createShimFixture, PROTECTED, posix, SHELL_KILL_RECORDER, type ShimFixture, TAG } from "./shim-fixtures.ts";

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
beforeAll(() => {
	f = createShimFixture();
});
afterAll(() => f.cleanup());

describe.runIf(bashAvailable)("bash's builtin kill through BASH_ENV", () => {
	it("judges a dynamic positive pid on its value and runs the builtin (C1d)", () => {
		const result = f.run("bash", `${PRELUDE}\nPID=4242; kill $PID`, f.env());
		expect(result.stdout).not.toContain("NOT-WRAPPED");
		expect(result.status).toBe(0);
		expect(result.judge).toBe("");
		expect(result.real).toBe("builtin [kill] [4242]\n");
	});

	it("refuses a dynamic protected pid through the judge and never reaches the builtin (C22)", () => {
		const script = `${PRELUDE}\nP=${PROTECTED}; kill -9 $P; echo "status=$?"`;
		const result = f.run("bash", script, f.env({ FAKE_JUDGE_MODE: "refuse" }));
		expect(result.stdout).toContain("status=126");
		expect(result.judge).toContain(`[--] [kill] [-9] [${PROTECTED}]\n`);
		expect(result.real).toBe("");
	});

	it("refuses a dynamic -1 in bash without starting the judge (R3)", () => {
		const result = f.run("bash", `${PRELUDE}\nT=-1; kill -9 $T; echo "status=$?"`, f.env());
		expect(result.stdout).toContain("status=126");
		expect(result.stderr).toContain(`${TAG} refused (R3 ALL_PROCESSES)`);
		expect(result.judge).toBe("");
		expect(result.real).toBe("");
	});

	it("passes job specs and `kill 0` to the judge as written, then to the builtin", () => {
		const result = f.run("bash", `${PRELUDE}\nkill %1; kill 0`, f.env());
		expect(result.status).toBe(0);
		expect(result.judge).toContain("[--] [kill] [%1]\n");
		expect(result.judge).toContain("[--] [kill] [0]\n");
		expect(result.real).toBe("builtin [kill] [%1]\nbuiltin [kill] [0]\n");
	});

	it("works under `set -eu`, where a refusal fails the command like a failed kill", () => {
		const script = `set -eu\n${PRELUDE}\nkill 4242\nkill ${PROTECTED} || echo "refused=$?"\necho done`;
		const result = f.run("bash", script, f.env({ FAKE_JUDGE_MODE: "refuse" }));
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("refused=126\ndone\n");
		expect(result.real).toBe("builtin [kill] [4242]\n");
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
