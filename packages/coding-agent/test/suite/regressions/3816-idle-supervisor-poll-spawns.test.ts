import { EventEmitter } from "node:events";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Every execFile is counted; real ones run only while `passthrough` is set (to learn the supervisor's real identity).
const spawned = vi.hoisted(() => ({ files: [] as string[], passthrough: true, identity: "" }));
vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: vi.fn((...args: Parameters<typeof actual.execFile>) => {
			if (spawned.passthrough) return actual.execFile(...args);
			spawned.files.push(String(args[0]));
			const callback = args.find((arg) => typeof arg === "function") as (error: null, stdout: string) => void;
			queueMicrotask(() => callback(null, `${spawned.identity}\n`));
			return new EventEmitter();
		}),
	};
});

import { armHostWatchdog, HOST_WATCH_IDENTITY_ONLY_INTERVAL_MS } from "../../../src/modes/rpc/host-watchdog.ts";
import { readProcessStartTime } from "../../../src/utils/process-identity.ts";

const WINDOW_MS = 10_000;

// In-PR regression guard: it pins a defect found in review of this PR (senpi#3816), not a bug that shipped.
// senpi#3816 review (senpi#3738 regression): with no stdin lifetime reader (always so on Linux), the recorded
// supervisor identity poll ran `ps` every 250 ms for the life of an idle host.
describe.skipIf(process.platform === "win32")("idle recorded-supervisor poll", () => {
	beforeAll(async () => {
		const identity = await readProcessStartTime(process.ppid);
		if (!identity) throw new Error("supervisor start time unreadable");
		spawned.identity = identity;
		spawned.passthrough = false;
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		spawned.files.length = 0;
	});

	it("spawns no ps over 10 s while the supervisor stays alive, and still checks liveness once a second", async () => {
		vi.useFakeTimers();
		const kill = vi.spyOn(process, "kill");
		const supervisor = process.ppid;
		const fired = vi.fn();
		const stop = armHostWatchdog({ ppid: supervisor, processStartTime: spawned.identity }, fired);
		try {
			await vi.advanceTimersByTimeAsync(WINDOW_MS);
			// At most one identity read at arm time; none while idle.
			expect(spawned.files.filter((file) => file === "ps").length).toBeLessThanOrEqual(1);
			expect(kill.mock.calls.filter(([pid, signal]) => pid === supervisor && signal === 0)).toHaveLength(
				WINDOW_MS / HOST_WATCH_IDENTITY_ONLY_INTERVAL_MS,
			);
			expect(fired).not.toHaveBeenCalled();
		} finally {
			stop();
		}
	});
});
