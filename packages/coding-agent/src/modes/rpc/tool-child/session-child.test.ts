// senpi#3566 todo 4: one session's tool child starts on the first job, reports its minimal status, and a later job
// respawns a dead child as a new generation. Real child process through the production role entry.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SessionToolChild, type SessionToolChildRecord } from "./session-child.ts";

const resolver = pathToFileURL(resolve(import.meta.dirname, "../../../experimental/source-resolver.ts")).href;
const roleEntry = resolve(import.meta.dirname, "../../../tool-child-main.ts");
const extensionDir = resolve(import.meta.dirname, "../../../../test/fixtures/module-job-ext");
const job = { modulePath: join(extensionDir, "offload.ts"), export: "whoAmI", args: { code: 0 } };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function sessionChild() {
	const dir = await mkdtemp(join(tmpdir(), "tsc-"));
	const records: SessionToolChildRecord[] = [];
	let onRecord: ((record: SessionToolChildRecord) => void) | undefined;
	const child = new SessionToolChild({
		dir,
		cwd: dir,
		moduleRoots: () => [extensionDir],
		command: { command: process.execPath, args: ["--import", resolver, roleEntry] },
		onRecord: (record) => {
			records.push(record);
			onRecord?.(record);
		},
	});
	cleanups.push(async () => {
		await child.close();
		await rm(dir, { recursive: true, force: true });
	});
	const nextRecord = (state: SessionToolChildRecord["state"]) =>
		new Promise<SessionToolChildRecord>((resolveRecord) => {
			onRecord = (record) => {
				if (record.state === state) resolveRecord(record);
			};
		});
	return { child, records, nextRecord };
}

describe.skipIf(process.platform === "win32")("SessionToolChild", () => {
	it("starts on the first job, goes none -> live -> exited, and respawns as a new generation", async () => {
		const { child, records, nextRecord } = await sessionChild();
		expect(child.row()).toEqual({ state: "none" });
		const first = await child.runner(job, undefined);
		expect(first.generation).toBe(1);
		expect(first.pid).not.toBe(process.pid);
		expect(child.row()).toEqual({ state: "live", generation: 1, pid: first.pid });
		const exited = nextRecord("exited");
		process.kill(first.pid, "SIGKILL");
		expect(await exited).toEqual({ state: "exited", generation: 1, pid: first.pid });
		expect(child.row()).toEqual({ state: "exited", generation: 1, pid: first.pid });
		const second = await child.runner(job, undefined);
		expect(second.generation).toBe(2);
		expect(second.pid).not.toBe(first.pid);
		expect(records.map((record) => [record.state, record.generation])).toEqual([
			["spawned", 1],
			["exited", 1],
			["respawned", 2],
		]);
	}, 60_000);

	it("starts one child for concurrent first jobs", async () => {
		const { child, records } = await sessionChild();
		const results = await Promise.all([
			child.runner(job, undefined),
			child.runner(job, undefined),
			child.runner(job, undefined),
		]);
		expect(new Set(results.map((result) => result.pid)).size).toBe(1);
		expect(records.filter((record) => record.state === "spawned")).toHaveLength(1);
	}, 60_000);

	it("refuses jobs after close", async () => {
		const { child } = await sessionChild();
		await child.close();
		await expect(child.runner(job, undefined)).rejects.toThrow(/tool_child_unavailable/);
	}, 30_000);
});
