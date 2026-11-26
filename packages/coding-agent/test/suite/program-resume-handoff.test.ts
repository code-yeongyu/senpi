// senpi#7493: under Bun the OSC 7577 token must leave the startup environment itself, which Bun.spawn without an env and
// every Worker copy from, so the CLI re-executes in place with the token carried over a pipe.
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FIXTURE = join(import.meta.dirname, "fixtures/program-resume-handoff.ts");
const TOKEN = "dummy-token-replace-me";
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

interface FixtureView {
	pid: number;
	token: string | null;
	spawnChild: string;
	spawnSyncChild: string;
	workerEnv: string;
	workerChild: string;
}

function runFixture(env: NodeJS.ProcessEnv): Promise<{ startedPid: number | undefined; view: FixtureView }> {
	return new Promise((resolve, reject) => {
		const child = spawn("bun", [FIXTURE], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) reject(new Error(`fixture exited ${code}: ${stderr}`));
			else resolve({ startedPid: child.pid, view: JSON.parse(stdout) as FixtureView });
		});
	});
}

describe.skipIf(!bunAvailable || process.platform === "win32")("OSC 7577 token hand-off under Bun (senpi#7493)", () => {
	it("keeps the pid and the token, and no child started without an env, Worker or Worker child sees the token", async () => {
		const { OSC7577_TOKEN: _drop, SENPI_OSC7577_TOKEN_HANDOFF: _stale, ...base } = process.env;
		const { startedPid, view } = await runFixture({ ...base, OSC7577_TOKEN: TOKEN });
		expect(view).toEqual({
			pid: startedPid,
			token: TOKEN,
			spawnChild: "unset",
			spawnSyncChild: "unset",
			workerEnv: "unset",
			workerChild: "unset",
		});
	});

	it("ignores a hand-off it inherited from another process and never reads that descriptor", async () => {
		const { OSC7577_TOKEN: _drop, ...base } = process.env;
		const { view } = await runFixture({ ...base, SENPI_OSC7577_TOKEN_HANDOFF: "1:0" });
		expect(view.token).toBeNull();
	});
});
