import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadNativePty } from "../src/native-loader.ts";
import { TerminalSession } from "../src/session.ts";
import type { TerminalSessionDependencies } from "../src/session-types.ts";

// Contract (senpi#5519): a session's child gets exactly the caller's environment, never a value the caller deleted.
// The engine trust restore (omo#10762) deletes its CA closure from process.env, and no agent shell may get it back.
const NAME = "SENPI_PTY_ENV_PROBE";
const PROBE = `printf "%s|%s|%s|%s\\n" "\${${NAME}-unset}" "\${PATH:+path}" "\${HOME:+home}" "\${TERM:+term}"`;
const CLEAN = "unset|path|home|term";
const LEAKED = "/closure/empty.pem|path|home|term";
const nativeAvailable = process.platform !== "win32" && loadNativePty().native !== null;
const bun = spawnSync("bun", ["--version"]).status === 0 ? "bun" : null;
const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TERM: process.env.TERM ?? "xterm-256color" };

async function childSees(
	env: Record<string, string | undefined> | undefined,
	dependencies: TerminalSessionDependencies,
): Promise<string> {
	const session = new TerminalSession({ command: "/bin/sh", args: ["-c", PROBE], env }, dependencies);
	const chunks: Buffer[] = [];
	session.onData((chunk) => chunks.push(chunk));
	session.start();
	await session.waitExit();
	return Buffer.concat(chunks).toString("utf8").replace(/\r/g, "").trim();
}

describe.skipIf(process.platform === "win32")("TerminalSession child environment", () => {
	const previousTerm = process.env.TERM;
	afterEach(() => {
		delete process.env[NAME];
		if (previousTerm === undefined) delete process.env.TERM;
		else process.env.TERM = previousTerm;
	});

	const backends: [string, TerminalSessionDependencies, boolean][] = [
		["native", { env: {} }, nativeAvailable],
		["pipe-fallback", { env: { SENPI_PTY_FORCE_PIPE: "1" } }, true],
	];
	it.each(backends)(
		"keeps PATH/HOME/TERM and drops a deleted variable on the %s backend",
		async (_name, dependencies, available) => {
			if (!available) return;
			// Given: the variable and TERM are in this process's environment.
			process.env[NAME] = "/closure/empty.pem";
			process.env.TERM = baseEnv.TERM;
			// When: the caller deletes the variable for the child, and separately passes no overrides at all.
			const deleted = await childSees({ [NAME]: undefined }, dependencies);
			const inherited = await childSees(undefined, dependencies);
			// Then: the deletion holds, the rest of the environment is still the child's.
			expect(deleted).toBe(CLEAN);
			expect(inherited).toBe(LEAKED);
		},
	);

	it.skipIf(bun === null)("never hands a child a variable Bun deleted only from process.env", () => {
		// Given: a Bun process launched with the variable in its OS environment that deletes it from process.env,
		// which Bun never propagates to the C environment.
		const result = spawnSync(bun ?? "bun", [join(import.meta.dirname, "fixtures", "env-deleted-in-bun.mjs")], {
			env: { ...baseEnv, [NAME]: "/closure/empty.pem" },
			encoding: "utf8",
			timeout: 60_000,
		});
		expect(result.status, result.stderr).toBe(0);
		const { sessions, raw } = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as {
			sessions: Record<string, string>;
			raw: Record<string, string>;
		};
		// Then: every session backend, with and without overrides, gives the child the deleted state.
		const checked = Object.entries(sessions).filter(([key]) => nativeAvailable || !key.startsWith("native"));
		expect(checked.length).toBeGreaterThanOrEqual(4);
		expect(Object.fromEntries(checked)).toEqual(Object.fromEntries(checked.map(([key]) => [key, CLEAN])));
		// And: the raw Bun primitives still behave as measured, which is why every Bun.spawn in shipped sources must
		// pass env (scripts/bun-spawn-explicit-env.test.mjs). A change here re-scopes that guard.
		expect(raw).toEqual({
			"Bun.spawnSync default env": LEAKED,
			"Bun.spawn default env": LEAKED,
			"Bun.spawn env: process.env": CLEAN,
			"Bun.spawn explicit env": CLEAN,
			"Bun.$ default": CLEAN,
		});
	});
});

describe.runIf(process.platform === "win32")("TerminalSession child environment on Windows", () => {
	afterEach(() => {
		delete process.env[NAME];
	});

	const windowsBackends: [string, TerminalSessionDependencies, boolean][] = [
		["native", { env: {} }, loadNativePty().native !== null],
		["pipe-fallback", { env: { SENPI_PTY_FORCE_PIPE: "1" } }, true],
	];
	it.each(windowsBackends)(
		"runs the default shell with a complete environment and drops a deleted variable on the %s backend",
		async (_name, dependencies, available) => {
			if (!available) return;
			// Given: the variable is in this process's environment.
			process.env[NAME] = "/closure/empty.pem";
			// When: the default shell (no command: ComSpec) lists its environment with the variable deleted.
			const session = new TerminalSession(
				{ args: ["/d", "/s", "/c", "set"], env: { [NAME]: undefined } },
				dependencies,
			);
			const chunks: Buffer[] = [];
			session.onData((chunk) => chunks.push(chunk));
			session.start();
			const exit = await session.waitExit();
			const names = new Set(
				Buffer.concat(chunks)
					.toString("utf8")
					.split(/\r?\n/)
					.map((line) =>
						line
							.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
							.split("=")[0]
							?.trim()
							.toUpperCase(),
					),
			);
			// Then: the shell ran, the platform variables survived the cleared native environment, the deletion holds.
			expect(exit.exitCode).toBe(0);
			for (const required of ["PATH", "SYSTEMROOT", "COMSPEC", "USERPROFILE", "TEMP"]) {
				expect(names, required).toContain(required);
			}
			expect(names).not.toContain(NAME);
		},
	);
});
