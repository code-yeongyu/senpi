// senpi#3566 todo 4 (review MEDIUM 2): a cancel reaches a module body as an aborted signal, the job fails
// tool_child_cancelled, the owned commands it still runs are ended, and an already-aborted run is never sent.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ToolChildClient } from "./client.ts";
import { defaultGroupProbes } from "./group-ownership.ts";
import { TOOL_CHILD_MODULE_ROOTS_ENV } from "./module-job.ts";

const resolver = pathToFileURL(resolve(import.meta.dirname, "../../../experimental/source-resolver.ts")).href;
const roleEntry = resolve(import.meta.dirname, "../../../tool-child-main.ts");
const extensionDir = resolve(import.meta.dirname, "../../../../test/fixtures/module-job-ext");
const modulePath = join(extensionDir, "offload.ts");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startChild() {
	const dir = await mkdtemp(join(tmpdir(), "tmc-"));
	const instance = new ToolChildClient({
		dir,
		cwd: dir,
		command: { command: process.execPath, args: ["--import", resolver, roleEntry] },
		env: { ...process.env, [TOOL_CHILD_MODULE_ROOTS_ENV]: JSON.stringify([extensionDir]) },
	});
	cleanups.push(async () => {
		await instance.close();
		await rm(dir, { recursive: true, force: true });
	});
	await instance.start();
	return { instance, dir };
}

/** The process has ended: gone, or a zombie waiting to be reaped. */
function ended(pid: number): boolean {
	const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
	return state === "" || state.startsWith("Z");
}

/** Bounded wait on a file another process writes: there is no event for it across processes. */
async function readWhenWritten(path: string, ms: number): Promise<string> {
	const deadline = Date.now() + ms;
	for (;;) {
		const text = await readFile(path, "utf8").catch(() => "");
		if (text !== "" || Date.now() >= deadline) return text;
		await new Promise((resolveTick) => setTimeout(resolveTick, 50));
	}
}

describe.skipIf(process.platform === "win32")("module job cancellation", () => {
	it("hands the body an aborted signal and fails the job tool_child_cancelled", async () => {
		const { instance } = await startChild();
		const abort = new AbortController();
		const job = instance.run("module", { modulePath, export: "waitForCancel", args: null }, abort.signal);
		const settled = job.then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		abort.abort();
		const outcome = await settled;
		expect(outcome).toMatchObject({ value: { aborted: true } });
	}, 30_000);

	it("fails a body that ignores the cancel tool_child_cancelled and ends the owned group it still runs", async () => {
		const { instance, dir } = await startChild();
		const marker = join(dir, "sleep.pid");
		const abort = new AbortController();
		const job = instance.run("module", { modulePath, export: "ownedSleepThenHang", args: { marker } }, abort.signal);
		const pid = Number(await readWhenWritten(marker, 10_000));
		expect(defaultGroupProbes.groupHasMembers(pid)).toBe(true);
		abort.abort();
		await expect(job).rejects.toMatchObject({ code: "tool_child_cancelled" });
		// Killed and not yet reaped: the worker that held its handle is gone, so it may linger as a zombie (Z) of the child.
		expect(ended(pid)).toBe(true);
	}, 30_000);

	it("never sends a job whose signal is already aborted", async () => {
		const { instance } = await startChild();
		const abort = new AbortController();
		abort.abort();
		await expect(
			instance.run("module", { modulePath, export: "waitForCancel", args: null }, abort.signal),
		).rejects.toMatchObject({
			code: "tool_child_cancelled",
		});
		expect(await instance.ping()).toBeGreaterThan(0);
	}, 30_000);
});
