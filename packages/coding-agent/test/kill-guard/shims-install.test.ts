// senpi#5349 (L2): the shim directory is written once per version, atomically, and the environment that carries it
// chains a user's BASH_ENV instead of replacing it.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	installKillGuardShims,
	KILL_GUARD_SHIM_MARKER,
	killGuardEnvironment,
	renderKillGuardShims,
} from "../../src/core/kill-guard/runtime.ts";
import { createShimFixture, PROTECTED, posix, type ShimFixture } from "./shim-fixtures.ts";

let f: ShimFixture;
beforeAll(() => {
	f = createShimFixture();
});
afterAll(() => f.cleanup());

describe("killGuardEnvironment", () => {
	const base = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: "/usr/bin:/bin", ...extra });

	it("prepends the shim directory once and exports the judge, the agent pid and the protected pids", () => {
		const entries = killGuardEnvironment(base(), f.runtime({ entry: "/opt/senpi/kill-guard-check.js" }));
		expect(entries).toEqual({
			PATH: `${f.shims}:/usr/bin:/bin`,
			BASH_ENV: join(f.shims, "bash_env.sh"),
			SENPI_KILL_GUARD_USER_BASH_ENV: "",
			SENPI_KILL_GUARD_PROTECTED: `1,${PROTECTED}`,
			SENPI_KILL_GUARD_EXEC: f.fakeJudge,
			SENPI_KILL_GUARD_EXEC_ENTRY: "/opt/senpi/kill-guard-check.js",
			SENPI_KILL_GUARD_AGENT_PID: "99999999",
		});
		const again = killGuardEnvironment(base({ PATH: `/usr/bin:${f.shims}:/bin` }), f.runtime());
		expect(again.PATH).toBe(`${f.shims}:/usr/bin:/bin`);
	});

	it("chains a user's BASH_ENV, and keeps it when the environment already carries a kill-guard BASH_ENV", () => {
		const user = killGuardEnvironment(base({ BASH_ENV: "/home/u/.bash_env" }), f.runtime());
		expect(user.SENPI_KILL_GUARD_USER_BASH_ENV).toBe("/home/u/.bash_env");
		const nested = killGuardEnvironment(
			base({ BASH_ENV: join(f.shims, "bash_env.sh"), SENPI_KILL_GUARD_USER_BASH_ENV: "/home/u/.bash_env" }),
			f.runtime(),
		);
		expect(nested.SENPI_KILL_GUARD_USER_BASH_ENV).toBe("/home/u/.bash_env");
		expect(nested.BASH_ENV).toBe(join(f.shims, "bash_env.sh"));
	});
});

describe.runIf(posix)("installKillGuardShims", () => {
	it("writes the shims, the BASH_ENV file and the marker atomically, and reuses them", () => {
		const shimRoot = join(f.root, "install-reuse");
		const dir = installKillGuardShims(shimRoot, "2026.11.01-1");
		expect(dir).toBe(join(shimRoot, "2026.11.01-1"));
		expect(readdirSync(shimRoot)).toEqual(["2026.11.01-1"]);
		const names = ["bash_env.sh", "kill", "killall", "pkill", KILL_GUARD_SHIM_MARKER];
		expect(readdirSync(dir).sort()).toEqual(names.sort());
		for (const name of ["kill", "pkill", "killall"]) expect(statSync(join(dir, name)).mode & 0o111).not.toBe(0);
		const before = statSync(join(dir, "pkill"));
		expect(installKillGuardShims(shimRoot, "2026.11.01-1")).toBe(dir);
		const after = statSync(join(dir, "pkill"));
		expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
	});

	it("replaces a same-version directory whose content is stale", () => {
		const shimRoot = join(f.root, "install-stale");
		const dir = installKillGuardShims(shimRoot, "dev");
		writeFileSync(join(dir, "pkill"), "#!/bin/sh\nexit 0\n");
		expect(installKillGuardShims(shimRoot, "dev")).toBe(dir);
		expect(readFileSync(join(dir, "pkill"), "utf8")).toBe(renderKillGuardShims(dir).pkill);
		expect(readdirSync(shimRoot)).toEqual(["dev"]);
	});

	it("bakes its own directory into every shim, so a shim never resolves to itself", () => {
		const files = renderKillGuardShims("/agent/kill-guard/v1");
		for (const name of ["kill", "pkill", "killall"] as const) {
			expect(files[name].startsWith("#!/bin/sh\n")).toBe(true);
			expect(files[name]).toContain("__senpi_kg_dir='/agent/kill-guard/v1'");
		}
	});
});
