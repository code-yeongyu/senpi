// senpi#5349 / code-yeongyu/oh-my-openagent#12096 (L2): the PATH shims judge `kill`, `pkill` and `killall` on their
// real, expanded argv before the real binary runs (DESIGN-12096 §4' L2, amendment A8).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KILL_GUARD_SHIM_MARKER } from "../../src/core/kill-guard/runtime.ts";
import { createShimFixture, PROTECTED, posix, type ShimFixture, SYSTEM_PATH, TAG, writeExecutable } from "./shim-fixtures.ts";

let f: ShimFixture;
beforeAll(() => {
	f = createShimFixture();
});
afterAll(() => f.cleanup());

const missingJudge = () => ({ exec: join(f.root, "uninstalled-senpi") });

describe.runIf(posix)("PATH shims", () => {
	it("judges the expanded pattern of `pkill -f \"$P\"` and runs the real pkill with the argv unchanged (C10)", () => {
		const result = f.run("/bin/sh", `P='vite --port 5173'; pkill -f "$P"`, f.env());
		expect(result.status).toBe(0);
		expect(result.judge).toMatch(/^fake-judge \[__kill-guard\] \[check\] \[--vantage\] \[\d+\] \[--\] /);
		expect(result.judge).toContain("[--] [pkill] [-f] [vite --port 5173]\n");
		expect(result.real).toBe("pkill [-f] [vite --port 5173]\n");
	});

	it("refuses with 126 and never starts the real binary when the judge refuses (C30)", () => {
		const result = f.run("/bin/sh", `P='a||b'; sh -c "pkill -f '$P'"`, f.env({ FAKE_JUDGE_MODE: "refuse" }));
		expect(result.status).toBe(126);
		expect(result.judge).toContain("[--] [pkill] [-f] [a||b]\n");
		expect(result.stderr).toContain(TAG);
		expect(result.real).toBe("");
	});

	it.each(["killall -u someone", "pkill -x node"])("puts `%s` through the judge too", (command) => {
		const result = f.run("/bin/sh", command, f.env({ FAKE_JUDGE_MODE: "refuse" }));
		expect(result.status).toBe(126);
		expect(result.judge).toContain(`[--] [${command.split(" ").join("] [")}]\n`);
		expect(result.real).toBe("");
	});

	it.each(["fail", "hang"])("fails closed when the judge is present but ends with %s (A8)", (mode) => {
		const result = f.run("/bin/sh", "pkill -f 'vite --port 5173'", f.env({ FAKE_JUDGE_MODE: mode }));
		expect(result.status).toBe(126);
		expect(result.stderr).toContain(`${TAG} refused (R5 UNKNOWN)`);
		expect(result.real).toBe("");
	});

	it("runs the real binary with one notice when the judge is missing (A8)", () => {
		const result = f.run("/bin/sh", "pkill -f 'vite --port 5173'", f.env({}, missingJudge()));
		expect(result.status).toBe(0);
		expect(result.real).toBe("pkill [-f] [vite --port 5173]\n");
		expect(result.stderr.split("\n").filter((line) => line.includes(TAG))).toHaveLength(1);
		expect(result.stderr).toContain("not installed");
	});

	it("runs a judge entry script through the runtime when one is configured (npm layout)", () => {
		const result = f.run("/bin/sh", "pkill -x node", f.env({}, { exec: "/bin/sh", entry: f.fakeJudge }));
		expect(result.status).toBe(0);
		expect(result.judge).toContain("[--] [pkill] [-x] [node]\n");
		expect(result.real).toBe("pkill [-x] [node]\n");
	});

	it("starts the judge without BUN_BE_BUN and with ELECTRON_RUN_AS_NODE", () => {
		const result = f.run("/bin/sh", "pkill -x node", f.env({ BUN_BE_BUN: "1" }));
		expect(result.status).toBe(0);
		expect(result.judge).toContain("env ELECTRON_RUN_AS_NODE=1 BUN_BE_BUN=unset\n");
		expect(result.real).toBe("pkill [-x] [node]\n");
	});

	it("takes the sh fast path for literal positive pids: no judge, argv unchanged (C1, A8)", () => {
		const result = f.run("/bin/sh", "env kill -TERM 4242 4343", f.env());
		expect(result.status).toBe(0);
		expect(result.judge).toBe("");
		expect(result.real).toBe("kill [-TERM] [4242] [4343]\n");
	});

	it.each(["kill -1", "kill -9 -1", "kill -- -1", "kill -s KILL -1", "kill -TERM 12 -1"])(
		"refuses `env %s` in sh before anything else runs (R3)",
		(command) => {
			const result = f.run("/bin/sh", `env ${command}`, f.env());
			expect(result.status).toBe(126);
			expect(result.stderr).toContain(`${TAG} refused (R3 ALL_PROCESSES)`);
			expect(result.judge).toBe("");
			expect(result.real).toBe("");
		},
	);

	it("sends a protected literal pid to the judge, and refuses it when the judge is missing (A8)", () => {
		const judged = f.run("/bin/sh", `env kill ${PROTECTED}`, f.env({ FAKE_JUDGE_MODE: "refuse" }));
		expect(judged.status).toBe(126);
		expect(judged.judge).toContain(`[--] [kill] [${PROTECTED}]\n`);
		expect(judged.real).toBe("");

		const missing = f.run("/bin/sh", `env kill ${PROTECTED}`, f.env({}, missingJudge()));
		expect(missing.status).toBe(126);
		expect(missing.stderr).toContain(`${TAG} refused (R2 PROTECTED_TARGET)`);
		expect(missing.real).toBe("");
	});

	it("sees the pids `xargs kill` read, and judges a protected one (C12)", () => {
		const narrow = f.run("/bin/sh", "printf '4242\\n4343\\n' | xargs kill", f.env());
		expect(narrow.status).toBe(0);
		expect(narrow.judge).toBe("");
		expect(narrow.real).toBe("kill [4242] [4343]\n");

		const guarded = f.run("/bin/sh", `printf '${PROTECTED}\\n' | xargs kill`, f.env({ FAKE_JUDGE_MODE: "refuse" }));
		expect(guarded.status).not.toBe(0);
		expect(guarded.judge).toContain(`[--] [kill] [${PROTECTED}]\n`);
		expect(guarded.real).toBe("");
	});

	it("skips its own directory and every other kill-guard shim directory when it looks for the real binary", () => {
		const other = join(f.root, "other-version");
		mkdirSync(other, { recursive: true });
		writeFileSync(join(other, KILL_GUARD_SHIM_MARKER), "");
		writeExecutable(join(other, "pkill"), '#!/bin/sh\necho shadow >> "$LOG"\nexit 0\n');
		const path = `${f.shims}:${other}:${f.realDir}:${SYSTEM_PATH}`;
		const result = f.run("/bin/sh", "pkill -x node", f.env({}, {}, path));
		expect(result.status).toBe(0);
		expect(result.real).toBe("pkill [-x] [node]\n");
	});
});
