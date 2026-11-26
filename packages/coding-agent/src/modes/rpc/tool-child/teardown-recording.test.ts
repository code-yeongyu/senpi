// senpi#3566 todo 4: teardown never sweeps a ledger that is missing a launch the server already received. Found by the
// Boat QA run at ecf83e5244: a violation killed the child while the owned launch's entry was still being written, the
// sweep saw an empty ledger, and the command's group outlived the child.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectChannel, openChannelListener } from "./channel.ts";
import { createGenerationBarrier } from "./client-barrier.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(process.platform === "win32")("generation teardown", () => {
	it("sweeps an owned group whose launch frame arrived just before teardown", async () => {
		const root = await mkdtemp(join(tmpdir(), "ttr-"));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const listener = await openChannelListener({ dir: join(root, "ch"), generation: 1 });
		const childSide = await connectChannel(listener.env);
		const serverSide = await listener.accepted;
		await listener.close();
		cleanups.push(async () => {
			childSide.close();
			serverSide.close();
		});
		const command = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
		const pgid = command.pid ?? -1;
		cleanups.push(async () => {
			if (groupAlive(pgid)) process.kill(-pgid, "SIGKILL");
		});
		const barrier = createGenerationBarrier({ dir: root, generation: 1, channel: serverSide, onViolation: () => {} });
		barrier.handle({
			type: "launch",
			launchId: "W1-1-0-1",
			origin: "kernel",
			api: "bun.spawn",
			containment: "own-group",
			lifetime: "owned",
			pid: pgid,
			pgid,
			jobId: "j1",
		});
		const outcomes = await barrier.teardown(undefined);
		expect(outcomes.map((outcome) => outcome.launchId)).toEqual(["W1-1-0-1"]);
		expect(groupAlive(pgid)).toBe(false);
	}, 30_000);
});
