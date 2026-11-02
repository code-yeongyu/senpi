import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	collectSpawnedHosts,
	processAlive,
	processesUnder,
	waitForPidGone,
} from "../../helpers/spawned-host-reaper.ts";
import { teardown } from "../rpc-public-auth-harness.ts";

const fixture = join(import.meta.dirname, "../../fixtures/reparented-grandchild.mjs");
const strays: number[] = [];
afterEach(async () => {
	for (const pid of strays.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone: the teardown under test did its job.
		}
		await waitForPidGone(pid, 10_000);
	}
});

/** Reads the fixture's one stdout line; no sleep, the line is the event. */
function grandchildPid(child: ChildProcess): Promise<number> {
	return new Promise((resolve, reject) => {
		let buffered = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			buffered += chunk.toString();
			const line = buffered.split("\n")[0];
			if (buffered.includes("\n")) resolve(JSON.parse(line).grandchild as number);
		});
		child.once("exit", () => reject(new Error(`fixture exited before naming its child: ${buffered}`)));
	});
}

// #4579: killing the spawned handle first re-parents its child out of the descendant walk, and the
// sandbox path never named that child, so the teardown removed the directory it was still writing into.
describe.skipIf(process.platform === "win32")("teardown collects the process tree before it kills", () => {
	it("leaves no re-parented descendant alive, and removes the sandbox", async () => {
		const root = await mkdtemp(join(tmpdir(), "td-"));
		const supervisor = spawn(process.execPath, [fixture, root], {
			cwd: root,
			stdio: ["ignore", "pipe", "inherit"],
		});
		const descendant = await grandchildPid(supervisor);
		strays.push(descendant);

		// The sandbox path names the spawned handle and NOTHING else: were the descendant matched by
		// argv too, this test would pass without any ordering guarantee at all.
		expect(processesUnder(root)).toContain(supervisor.pid);
		expect(processesUnder(root)).not.toContain(descendant);

		await teardown(root, supervisor);

		expect(processAlive(descendant)).toBe(false);
		expect(existsSync(root)).toBe(false);
	}, 60_000);

	it("never collects a handle that has already exited, whose pid another process may now hold", async () => {
		const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
		await once(exited, "exit");
		expect(exited.pid).toBeTypeOf("number");

		expect(collectSpawnedHosts({ children: [exited] })).not.toContain(exited.pid);
	}, 60_000);
});
