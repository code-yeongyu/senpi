// senpi#5349 (L2): the shims run the real judge entry (`check-entry.ts` under this runtime) on commands that only read
// the process table; the real pkill is still a recording fake, so nothing is signalled.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createShimFixture, posix, type ShimFixture, TAG } from "./shim-fixtures.ts";

const entry = fileURLToPath(new URL("../../src/core/kill-guard/check-entry.ts", import.meta.url));

let f: ShimFixture;
beforeAll(() => {
	f = createShimFixture("test-real", 30);
});
afterAll(() => f.cleanup());

function realJudgeEnv(): NodeJS.ProcessEnv {
	return f.env(
		{},
		{
			bashEnv: join(f.shims, "bash_env.sh"),
			exec: process.execPath,
			entry,
			agentPid: process.pid,
			protectedPids: [1, process.pid],
		},
	);
}

describe.runIf(posix)("the real judge behind the shims", () => {
	it("refuses a broad pattern that only appears once the command runs (C30, R1)", () => {
		const result = f.run("/bin/sh", `P='a||b'; sh -c "pkill -f '$P'"`, realJudgeEnv());
		expect(result.status).toBe(126);
		expect(result.stderr).toContain(`${TAG} refused (R1 BROAD_PATTERN)`);
		expect(result.real).toBe("");
	});

	it("allows a narrow exact name and hands the argv to the real binary (C8)", () => {
		const result = f.run("/bin/sh", 'N=senpi-kill-guard-no-such-process; pkill -x "$N"', realJudgeEnv());
		expect(result.stderr).not.toContain(TAG);
		expect(result.status).toBe(0);
		expect(result.real).toBe("pkill [-x] [senpi-kill-guard-no-such-process]\n");
	});
});
