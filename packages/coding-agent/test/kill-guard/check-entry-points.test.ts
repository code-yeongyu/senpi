// senpi#5349 (L2): the runtime shims call the CLI's hidden `__kill-guard check`. The compiled binary is built from
// `src/bun/cli.ts`, so that entry must answer it exactly as the Node launcher does: through the judge, before any
// agent-dir or engine work. The judge's `ps` (macOS) and `pgrep` are recording fakes on PATH and every verdict here
// refuses or selects nothing, so nothing is signalled.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { posix, TAG, writeExecutable } from "./shim-fixtures.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), "senpi-kill-guard-entry-"));
	roots.push(root);
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	const fakes = join(root, "fakes");
	for (const dir of [home, agentDir, fakes]) mkdirSync(dir);
	const pgrepLog = join(root, "pgrep.log");
	// One table row is enough for the view; `pgrep` records the dry run and matches nothing (exit 1).
	writeExecutable(join(fakes, "ps"), "#!/bin/sh\necho '    1     0     1     1     0 init /sbin/init'\n");
	writeExecutable(join(fakes, "pgrep"), `#!/bin/sh\necho "$*" >> '${pgrepLog}'\nexit 1\n`);
	const env: NodeJS.ProcessEnv = {
		PATH: `${fakes}:${process.env.PATH ?? ""}`,
		HOME: home,
		SENPI_CODING_AGENT_DIR: agentDir,
		SENPI_KILL_GUARD_AGENT_PID: String(process.pid),
		PI_OFFLINE: "1",
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "runtime-cache"),
		NODE_COMPILE_CACHE: join(root, "compile-cache"),
	};
	const pgrepCalls = () => {
		try {
			return readFileSync(pgrepLog, "utf8");
		} catch {
			return "";
		}
	};
	return { home, agentDir, env, pgrepCalls };
}

describe.runIf(posix)("`__kill-guard check` on every CLI entry", () => {
	it.each(["cli.ts", "bun/cli.ts"])("%s judges the real argv and leaves the agent dir untouched", (entry) => {
		const box = sandbox();
		const check = (...argv: string[]) =>
			spawnSync(
				"bun",
				[join(packageRoot, "src", entry), "__kill-guard", "check", "--vantage", String(process.pid), "--", ...argv],
				{ env: box.env, encoding: "utf8", timeout: 20_000 },
			);

		const narrow = check("pkill", "-x", "foo");
		expect(narrow.status, narrow.stderr).toBe(0);
		expect(box.pgrepCalls()).toMatch(/-x foo\n/);

		const everything = check("kill", "--", "-1");
		expect(everything.status).toBe(126);
		expect(everything.stderr).toContain(`${TAG} refused (R3 ALL_PROCESSES)`);

		expect(readdirSync(box.agentDir)).toEqual([]);
		expect(readdirSync(box.home)).toEqual([]);
	});
});
