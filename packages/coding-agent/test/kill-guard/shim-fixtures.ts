// Shared setup for the kill guard's runtime-layer tests (senpi#5349, L2). The "real" kill/pkill/killall are recording
// fakes placed on PATH before the system directories and the judge is a recording fake, so no test signals anything.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	installKillGuardShims,
	type KillGuardRuntime,
	killGuardEnvironment,
} from "../../src/core/kill-guard/runtime.ts";

export const posix = process.platform !== "win32";
export const TAG = "[senpi:kill-guard]";
/** A pid the host listed as protected; only the fake judge and the sh fast path ever see it. */
export const PROTECTED = 4747;
export const SYSTEM_PATH = "/usr/bin:/bin";

/** One log line per run: the command's name, then each argument in brackets so argument boundaries stay visible. */
const RECORD = `printf '%s' "\${0##*/}" >> "$LOG"; for a do printf ' [%s]' "$a" >> "$LOG"; done; printf '\\n' >> "$LOG"`;

export function writeExecutable(path: string, content: string): void {
	writeFileSync(path, content);
	chmodSync(path, 0o755);
}

export interface Run {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly real: string;
	readonly judge: string;
}

export interface ShimFixture {
	readonly root: string;
	readonly realDir: string;
	readonly shims: string;
	readonly fakeJudge: string;
	runtime(overrides?: Partial<KillGuardRuntime>): KillGuardRuntime;
	env(extra?: Record<string, string>, overrides?: Partial<KillGuardRuntime>, path?: string): NodeJS.ProcessEnv;
	run(shell: string, script: string, env: NodeJS.ProcessEnv): Run;
	cleanup(): void;
}

function readLog(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function writeFakeJudge(path: string): void {
	writeExecutable(
		path,
		[
			"#!/bin/sh",
			'LOG="$JUDGE_LOG"',
			RECORD,
			'printf \'env ELECTRON_RUN_AS_NODE=%s BUN_BE_BUN=%s\\n\' "${ELECTRON_RUN_AS_NODE-unset}" "${BUN_BE_BUN-unset}" >> "$LOG"',
			'case "$FAKE_JUDGE_MODE" in',
			"allow) exit 0 ;;",
			`refuse) echo "${TAG} refused (fake judge)" >&2; exit 126 ;;`,
			"fail) exit 3 ;;",
			"hang) exec sleep 30 ;;",
			"esac",
			"exit 9",
			"",
		].join("\n"),
	);
}

/** A temp root with recording fakes and one installed shim directory; the judge deadline is short for the fakes. */
export function createShimFixture(version = "test-fast", deadlineSeconds = 1): ShimFixture {
	const root = mkdtempSync(join(tmpdir(), "senpi-kill-guard-l2-"));
	const realDir = join(root, "real");
	mkdirSync(realDir);
	const realLog = join(root, "real.log");
	const judgeLog = join(root, "judge.log");
	for (const name of ["kill", "pkill", "killall"]) writeExecutable(join(realDir, name), `#!/bin/sh\n${RECORD}\n`);
	const fakeJudge = join(root, "fake-judge");
	writeFakeJudge(fakeJudge);
	const shims = installKillGuardShims(join(root, "agent", "kill-guard"), version, { deadlineSeconds });
	const runtime = (overrides: Partial<KillGuardRuntime> = {}): KillGuardRuntime => ({
		dir: shims,
		bashEnv: join(shims, "bash_env.sh"),
		exec: fakeJudge,
		entry: undefined,
		agentPid: 99_999_999,
		protectedPids: [1, PROTECTED],
		...overrides,
	});
	return {
		root,
		realDir,
		shims,
		fakeJudge,
		runtime,
		env(extra = {}, overrides = {}, path = `${realDir}:${SYSTEM_PATH}`) {
			const base: NodeJS.ProcessEnv = {
				PATH: path,
				HOME: root,
				LOG: realLog,
				JUDGE_LOG: judgeLog,
				FAKE_JUDGE_MODE: "allow",
				...extra,
			};
			return { ...base, ...killGuardEnvironment(base, runtime(overrides)) };
		},
		run(shell, script, env) {
			rmSync(realLog, { force: true });
			rmSync(judgeLog, { force: true });
			const result = spawnSync(shell, ["-c", script], { env, encoding: "utf8", timeout: 30_000 });
			return {
				status: result.status,
				stdout: result.stdout,
				stderr: result.stderr,
				real: readLog(realLog),
				judge: readLog(judgeLog),
			};
		},
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}
