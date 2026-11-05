import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitForListener } from "../../src/modes/rpc/host-lifecycle-proxy.ts";
import { processExitEvent } from "../helpers/process-exit-event.ts";
import { hostSpawnEnv } from "../helpers/rpc-host-spawn-env.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Access modes ("r", "w", "u") of every descriptor `pid` holds on `path`. */
function fifoAccessModes(pid: number, path: string): string[] {
	if (process.platform === "linux") {
		const modes: string[] = [];
		for (const fd of readdirSync(`/proc/${pid}/fd`)) {
			let target: string;
			try {
				target = readlinkSync(`/proc/${pid}/fd/${fd}`);
			} catch {
				continue;
			}
			if (target !== path) continue;
			const flags = Number.parseInt(
				/^flags:\s+(\d+)$/m.exec(readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8"))?.[1] ?? "0",
				8,
			);
			modes.push(["r", "w", "u"][flags & 3] ?? "?");
		}
		return modes;
	}
	throw new Error(`fifoAccessModes reads /proc and runs on Linux only, not ${process.platform}`);
}

// senpi#3816 round 7 (lead ruling: FIFO). A real supervisor creates its lifetime FIFO 0600 in its 0700 hop directory,
// keeps the only writer (never inherited by the host), and its death reaches the host as EOF within a second.
describe.skipIf(process.platform === "win32")("supervisor lifetime FIFO", () => {
	it("is created privately, written only by the supervisor, and ends the host within 1 s of a SIGKILL", async () => {
		const root = mkdtempSync("/tmp/r3816s-");
		roots.push(root);
		const tmp = join(root, "t");
		mkdirSync(tmp);
		const socket = join(root, "public.sock");
		const supervisor = spawn(
			process.execPath,
			[
				join(import.meta.dirname, "../../src/modes/rpc/host-lifecycle.ts"),
				"--socket",
				socket,
				"--child-command",
				process.execPath,
				"--child-args",
				JSON.stringify([
					"--import",
					"tsx",
					join(import.meta.dirname, "../fixtures/rpc-supervised-child.ts"),
					"fixture-version",
					"",
					"answer",
				]),
			],
			{
				env: { ...hostSpawnEnv(), TMPDIR: tmp, SENPI_CODING_AGENT_DIR: join(root, "agent") },
				stdio: ["ignore", "ignore", "inherit"],
			},
		);
		const supervisorExit = once(supervisor, "exit");
		try {
			await waitForListener(socket, 60_000);
			const [hopName] = readdirSync(tmp).filter((name) => name.startsWith("senpi-rpc-host-internal-"));
			expect(hopName).toBeDefined();
			const hop = join(tmp, hopName ?? "");
			const fifo = join(hop, "lifetime.fifo");
			expect(statSync(hop).mode & 0o777).toBe(0o700);
			// Linux binds through the FIFO; macOS through the reopened stdin (libuv reports no FIFO EOF there).
			if (process.platform === "linux") {
				expect(statSync(fifo).isFIFO()).toBe(true);
				expect(statSync(fifo).mode & 0o777).toBe(0o600);
			} else expect(existsSync(fifo)).toBe(false);
			// The host is the supervisor's child listening on this hop.
			const [childPid] = execFileSync(
				"pgrep",
				["-P", String(supervisor.pid), "-f", `unix://${join(hop, "host.sock")}`],
				{
					encoding: "utf8",
				},
			)
				.split("\n")
				.filter(Boolean)
				.map(Number);
			expect(childPid).toBeGreaterThan(1);
			if (process.platform === "linux") expect(fifoAccessModes(childPid ?? 0, fifo)).toEqual(["r"]);
			const childExit = await processExitEvent(childPid ?? 0);
			try {
				supervisor.kill("SIGKILL");
				await childExit.wait(1_000, "supervised host after its supervisor's SIGKILL");
			} finally {
				await childExit.dispose();
			}
		} finally {
			if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
			await supervisorExit;
		}
	}, 90_000);
});
