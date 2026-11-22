import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { killAndWait, processAlive, reapProcessesUnder, waitForPidGone } from "../../helpers/spawned-host-reaper.ts";

const IDLE = "setInterval(() => {}, 1 << 30);";
// The launcher keeps the sandbox out of its own argv and exits after starting a detached process that names it:
// that process is not a child this test spawned, the way another user's `tail -f <sandbox>/log` is not.
const FOREIGN_LAUNCHER = `const { spawn } = require("node:child_process");
const foreign = spawn(process.execPath, ["-e", ${JSON.stringify(IDLE)}, process.env.FOREIGN_ROOT], { detached: true, stdio: "ignore" });
foreign.unref();
process.stdout.write(String(foreign.pid));`;

async function foreignProcessNaming(root: string): Promise<number> {
	const launcher = spawn(process.execPath, ["-e", FOREIGN_LAUNCHER], {
		env: { ...process.env, FOREIGN_ROOT: root },
		stdio: ["ignore", "pipe", "inherit"],
	});
	let pid = "";
	launcher.stdout.on("data", (chunk: Buffer) => {
		pid += chunk.toString();
	});
	await once(launcher, "exit");
	return Number(pid);
}

// senpi#7296: the reaper signalled every process whose command line named the sandbox (pgrep -f), so a process the
// test never started was killed with SIGKILL. Only children this process spawned, and their descendants, are reaped.
it.skipIf(process.platform === "win32")(
	"reaps its own child but never a foreign process naming the same sandbox",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "reaper-ownership-"));
		let foreign: number | undefined;
		let owned: ChildProcess | undefined;
		try {
			foreign = await foreignProcessNaming(root);
			expect(processAlive(foreign)).toBe(true);
			owned = spawn(process.execPath, ["-e", IDLE, root], { stdio: "ignore" });
			await once(owned, "spawn");

			const reaped = await reapProcessesUnder(root);

			expect(reaped).toContain(owned.pid);
			expect(reaped).not.toContain(foreign);
			expect(processAlive(foreign)).toBe(true);
		} finally {
			if (owned) await killAndWait(owned);
			if (foreign !== undefined && processAlive(foreign)) {
				process.kill(foreign, "SIGKILL");
				await waitForPidGone(foreign, 10_000);
			}
			await rm(root, { recursive: true, force: true });
		}
	},
);
