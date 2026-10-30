import { execFileSync } from "node:child_process";
import fs, { rmSync } from "node:fs";
import { access, type FileHandle, mkdir, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { settledOpportunisticHostGc } from "../../../src/modes/rpc/host-gc-pass.ts";
import { hostGcPassMarkerPath } from "../../../src/modes/rpc/host-gc-pass-marker.ts";
import { removeHostScratch } from "../../helpers/host-scratch-removal.ts";
import { processExitEvent } from "../../helpers/process-exit-event.ts";
import { type GenerationScratch, generationScratch } from "../../helpers/rpc-generation-support.ts";

const fixtureHost = join(import.meta.dirname, "../../fixtures/rpc-host-fixture.mjs");

/**
 * An ensured host that has already exited, and the gc pass its ensure scheduled, parked: the pass's first
 * step reads its marker, which is a FIFO here, so it waits until the returned gate is written and closed.
 */
async function exitedHostWithParkedGcPass(qa: GenerationScratch): Promise<FileHandle> {
	const marker = hostGcPassMarkerPath(qa.agentDir);
	await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
	execFileSync("mkfifo", ["-m", "600", marker]);
	const host = await ensureHost({
		socket: qa.socket,
		agentDir: qa.agentDir,
		_test: {
			spawn: {
				command: process.execPath,
				args: [
					fixtureHost,
					qa.socket,
					"fixture-version",
					"multi_session,extension_events,session_context,session_kind",
					"answer",
				],
			},
		},
	});
	// Opening the write end completes only once the pass has opened the marker: the pass is now in flight.
	const gate = await open(marker, "w");
	const hostExit = await processExitEvent(host.pid);
	try {
		host.release();
		process.kill(host.pid, "SIGTERM");
		await hostExit.wait(10_000, "ensured fixture host");
	} finally {
		await hostExit.dispose();
	}
	return gate;
}

// #4382: ensureHost returns before the gc pass it schedules has run, and that pass writes its marker into
// <agentDir>/rpc-host-daemon. Removing the tree while the pass is in flight races that write (ENOTEMPTY on
// rpc-host-daemon) even after every process the case started has exited, so every removal path joins it.
describe.skipIf(process.platform === "win32")("gc pass outliving the ensured host", () => {
	it.each([
		["removeHostScratch", (qa: GenerationScratch) => removeHostScratch(qa)],
		["node:fs/promises rm", (qa: GenerationScratch) => rm(qa.root, { recursive: true, force: true })],
		["fs.promises.rm", (qa: GenerationScratch) => fs.promises.rm(qa.root, { recursive: true, force: true })],
	] as const)("%s removes a host scratch only after the ensure's gc pass has finished writing", async (_, remove) => {
		const qa = generationScratch("4382");
		const gate = await exitedHostWithParkedGcPass(qa);
		let removed = false;
		let removal: Promise<void> | undefined;
		try {
			removal = remove(qa).then(() => {
				removed = true;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(removed, "the scratch must outlast the gc pass still writing into it").toBe(false);
			await access(join(qa.agentDir, "rpc-host-daemon"));
			await gate.writeFile("{}\n");
		} finally {
			await gate.close();
		}
		await removal;
		await expect(access(qa.root)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rmSync refuses a host scratch while the ensure's gc pass is still writing into it", async () => {
		const qa = generationScratch("4382");
		const gate = await exitedHostWithParkedGcPass(qa);
		try {
			expect(() => rmSync(qa.root, { recursive: true, force: true })).toThrow(/senpi#4382/);
			await access(join(qa.agentDir, "rpc-host-daemon"));
			await gate.writeFile("{}\n");
		} finally {
			await gate.close();
		}
		await settledOpportunisticHostGc(qa.agentDir);
		rmSync(qa.root, { recursive: true, force: true });
		await expect(access(qa.root)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
