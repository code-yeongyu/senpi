// senpi#7493: under Bun the OSC 7577 token must leave the startup environment itself, which Bun.spawn without an env and
// every Worker copy from, so the CLI re-executes in place with the token carried over a pipe.
import { spawn, spawnSync, type StdioOptions } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FIXTURE = join(import.meta.dirname, "fixtures/program-resume-handoff.ts");
const TOKEN = "dummy-token-replace-me";
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

interface FixtureView {
	pid: number;
	cwd: string;
	argv: string[];
	token: string | null;
	spawnChild: string;
	spawnSyncChild: string;
	childEnvNames: string;
	workerEnv: string;
	workerChild: string;
	fd7Inode: number | null;
}

interface FixtureRun {
	readonly env?: NodeJS.ProcessEnv;
	readonly bunArgs?: readonly string[];
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly stdio?: StdioOptions;
}

function runFixture(run: FixtureRun): Promise<{ startedPid: number | undefined; view: FixtureView }> {
	const { OSC7577_TOKEN: _drop, ...base } = process.env;
	return new Promise((resolve, reject) => {
		const child = spawn("bun", [...(run.bunArgs ?? []), FIXTURE, ...(run.args ?? [])], {
			env: { ...base, ...run.env },
			cwd: run.cwd,
			stdio: run.stdio ?? ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code !== 0) reject(new Error(`fixture exited ${code}: ${stderr}`));
			else resolve({ startedPid: child.pid, view: JSON.parse(stdout) as FixtureView });
		});
	});
}

describe.skipIf(!bunAvailable || process.platform === "win32")("OSC 7577 token hand-off under Bun (senpi#7493)", () => {
	it("keeps the pid, argv and token, and nothing it starts sees the token or the hand-off", async () => {
		const { startedPid, view } = await runFixture({ env: { OSC7577_TOKEN: TOKEN }, args: ["--keep", "me"] });
		expect(view).toMatchObject({
			pid: startedPid,
			argv: ["--keep", "me"],
			token: TOKEN,
			spawnChild: "unset",
			spawnSyncChild: "unset",
			childEnvNames: "none",
			workerEnv: "unset",
			workerChild: "unset",
		});
	});

	it("does not apply a relative --cwd twice", async () => {
		const root = mkdtempSync(join(tmpdir(), "osc7577-cwd-"));
		mkdirSync(join(root, "inner"));
		const { view } = await runFixture({ env: { OSC7577_TOKEN: TOKEN }, bunArgs: ["--cwd=inner"], cwd: root });
		expect(view.cwd).toBe(join(root, "inner"));
		expect(view.token).toBe(TOKEN);
		expect(view.spawnChild).toBe("unset");
	});

	it("leaves a launch that was handed descriptors in place, so an inherited descriptor survives", async () => {
		// Bun marks an inherited file descriptor close-on-exec at startup, so an exec here would close it.
		const fd = openSync(join(mkdtempSync(join(tmpdir(), "osc7577-fd-")), "probe"), "w");
		const inherited = { fd, inode: fstatSync(fd).ino };
		const { startedPid, view } = await runFixture({
			env: { OSC7577_TOKEN: TOKEN, SENPI_PRIVATE_FDS: '{"probe":7}' },
			stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", inherited.fd],
		}).finally(() => closeSync(inherited.fd));
		expect(view.pid).toBe(startedPid);
		expect(view.fd7Inode).toBe(inherited.inode);
		expect(view.token).toBe(TOKEN);
	});

	it("drops a hand-off flag that names no pipe and reads nothing from it", async () => {
		for (const flag of ["--senpi-osc7577-token-fd=0", "--senpi-osc7577-token-fd=x"]) {
			const { view } = await runFixture({ args: [flag, "rest"] });
			expect(view.argv).toEqual(["rest"]);
			expect(view.token).toBeNull();
		}
	});
});
