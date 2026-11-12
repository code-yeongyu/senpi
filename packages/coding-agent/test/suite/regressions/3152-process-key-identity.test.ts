import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reclaimLockState } from "../../../src/core/extensions/builtin/terminal/lease-file.ts";
import { processBootAtMs } from "../../../src/core/extensions/builtin/terminal/process-identity.ts";
import { ownProcessKey, readProcessKey } from "../../../src/core/extensions/builtin/terminal/process-key.ts";
import { readProcessStartMs } from "../../../src/core/extensions/builtin/terminal/process-start-probe.ts";

// senpi#3152 / #6562: on Linux the start instant compared before was `/proc/stat btime + start ticks`, and btime moves
// with every wall-clock step, so a live holder recorded before a step read as a reused pid. The process key
// (`<boot id>:<start>`) is read from values the kernel never rewrites. These cases read REAL kernel data; only the
// btime line of /proc/stat is moved, the way a clock step moves it.
const clock = vi.hoisted(() => ({ btimeShiftSeconds: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		readFile: (async (path: unknown, ...rest: unknown[]) => {
			const text: unknown = await Reflect.apply(actual.readFile, actual, [path, ...rest]);
			if (path !== "/proc/stat" || typeof text !== "string" || clock.btimeShiftSeconds === 0) return text;
			return text.replace(
				/^btime (\d+)$/m,
				(_line, seconds: string) => `btime ${Number(seconds) + clock.btimeShiftSeconds}`,
			);
		}) as typeof actual.readFile,
	};
});

const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
	clock.btimeShiftSeconds = 0;
	for (const child of children.splice(0)) child.kill("SIGKILL");
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function liveChild(): number {
	const child = spawn("sleep", ["60"], { stdio: "ignore" });
	children.push(child);
	if (child.pid === undefined) throw new Error("spawn produced no pid");
	return child.pid;
}

async function lockWith(record: object): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "process-key-"));
	dirs.push(dir);
	const lock = join(dir, "s.lease.lock");
	await writeFile(lock, JSON.stringify(record));
	return lock;
}

const keyedPlatform = process.platform === "linux" || process.platform === "darwin";

describe.runIf(keyedPlatform)("process key on real kernel data", () => {
	it("names this process the same way every time, and another process differently", async () => {
		const own = await readProcessKey(process.pid);
		const other = await readProcessKey(liveChild());

		expect({ own, cached: await ownProcessKey(), differs: other !== own }).toEqual({
			own: expect.stringMatching(/^[0-9A-Fa-f-]{36}:.+$/),
			cached: own,
			differs: true,
		});
	});
});

describe.runIf(process.platform === "linux")("liveness across a wall-clock step (Linux)", () => {
	it("keeps a live holder recorded before btime moved when the record carries its key, and not without it", async () => {
		const pid = liveChild();
		const identity = {
			pid,
			bootAtMs: await processBootAtMs(),
			processStartedAtMs: await readProcessStartMs(pid),
			processKey: await readProcessKey(pid),
		};
		const keyed = await lockWith(identity);
		const { processKey: _dropped, ...withoutKey } = identity;
		const unkeyed = await lockWith(withoutKey);
		// A wall-clock step of +600 s: the kernel's btime moves, the boot id and the start ticks do not.
		clock.btimeShiftSeconds = 600;

		const verdicts = {
			keyed: (await reclaimLockState(keyed)).state,
			unkeyed: (await reclaimLockState(unkeyed)).state,
		};

		expect(verdicts).toEqual({ keyed: "held", unkeyed: "stale" });
	});

	it("never takes a live pid from another boot for the holder, even when its start time matches", async () => {
		const pid = liveChild();
		const key = await readProcessKey(pid);
		if (key === undefined) throw new Error("expected a process key on Linux");
		const otherBoot = `00000000-0000-4000-8000-000000000000${key.slice(key.indexOf(":"))}`;
		const lock = await lockWith({
			pid,
			bootAtMs: await processBootAtMs(),
			processStartedAtMs: await readProcessStartMs(pid),
			processKey: otherBoot,
		});

		expect((await reclaimLockState(lock)).state).toBe("stale");
	});
});
