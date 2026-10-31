import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonPidFile } from "../../src/utils/process-identity.ts";
import {
	clearStartupIntent,
	readStartupIntent,
	reconcileStartupIntent,
	type StartupIntent,
	startupIntentPath,
	writeStartupIntent,
} from "../../src/modes/rpc/host-startup-intent.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function daemonDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-startup-intent-"));
	dirs.push(dir);
	return dir;
}

const launcher: DaemonPidFile = { pid: 101, processStartTime: "launcher-start" };
const child: DaemonPidFile = { pid: 202, processStartTime: "child-start" };
const base: StartupIntent = { attempt: "a".repeat(32), instanceId: "instance-1", generation: 0, launcher };

function liveness(live: ReadonlySet<number>, unreadable: ReadonlySet<number> = new Set()) {
	return async (record: DaemonPidFile) => {
		if (unreadable.has(record.pid)) throw new Error("identity unreadable");
		return live.has(record.pid);
	};
}

describe("startup intent record (senpi#4602)", () => {
	it("round-trips owner-only, with and without the child's identity, and clears", async () => {
		const dir = await daemonDir();
		await writeStartupIntent(dir, base);
		expect((await stat(startupIntentPath(dir))).mode & 0o777).toBe(0o600);
		expect(await readStartupIntent(dir)).toEqual(base);
		await writeStartupIntent(dir, { ...base, child });
		expect(await readStartupIntent(dir)).toEqual({ ...base, child });
		await clearStartupIntent(dir);
		expect(await readStartupIntent(dir)).toBeUndefined();
	});

	it("reads a torn or foreign-shaped intent as unreadable, not as absent", async () => {
		const dir = await daemonDir();
		await writeFile(startupIntentPath(dir), "{not json");
		expect(await readStartupIntent(dir)).toBe("unreadable");
		await writeFile(startupIntentPath(dir), JSON.stringify({ version: 1, attempt: "x" }));
		expect(await readStartupIntent(dir)).toBe("unreadable");
	});
});

describe("startup intent reconciliation (senpi#4602)", () => {
	it.each([
		["no intent", undefined, liveness(new Set()), "none"],
		["an unreadable intent", "unreadable", liveness(new Set()), "unknown"],
		["a launcher still running", { ...base, child }, liveness(new Set([101])), "launcher_live"],
		["a launcher whose identity cannot be read", { ...base, child }, liveness(new Set(), new Set([101])), "unknown"],
		["a dead launcher that never bound its child", base, liveness(new Set()), "unknown"],
		["a dead launcher whose child still runs", { ...base, child }, liveness(new Set([202])), "candidate_live"],
		["a child whose identity cannot be read", { ...base, child }, liveness(new Set(), new Set([202])), "unknown"],
		["a dead launcher and a provably gone child", { ...base, child }, liveness(new Set()), "candidate_gone"],
	] as const)("%s reconciles to %s", async (_case, intent, matches, verdict) => {
		expect(await reconcileStartupIntent(intent, matches)).toBe(verdict);
	});
});
