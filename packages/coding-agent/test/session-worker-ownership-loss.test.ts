import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lockWithLossHandling } from "../src/core/file-lock.ts";
import { stopWorkerOnLostOwnership } from "../src/experimental/session-worker-ownership.ts";

const realLock = lockfile.lock;
const dirs: string[] = [];

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function sessionFile(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "session-worker-ownership-"));
	dirs.push(dir);
	return join(dir, "session.jsonl");
}

function captureCompromise(): { lose(): void } {
	let onCompromised: ((error: Error) => void) | undefined;
	vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
		onCompromised = options?.onCompromised;
		return realLock(file, options);
	});
	return {
		lose: () => onCompromised?.(Object.assign(new Error("lock reclaimed"), { code: "ECOMPROMISED" })),
	};
}

describe("session worker ownership lock", () => {
	it("a worker that loses its session lock while running reports worker_failed and exits", async () => {
		const compromise = captureCompromise();
		const events: string[] = [];
		let exited: () => void = () => {};
		const exit = new Promise<void>((resolve) => {
			exited = resolve;
		});
		const lock = await lockWithLossHandling(await sessionFile(), {
			realpath: false,
			onLost: stopWorkerOnLostOwnership({
				report: async (message) => {
					events.push(`report:${message}`);
				},
				exit: (code) => {
					events.push(`exit:${code}`);
					exited();
				},
			}),
		});

		compromise.lose();
		await exit;

		expect(lock.lost()).toBe(true);
		expect(events).toEqual([
			expect.stringMatching(/^report:Session worker lost its session lock \(ECOMPROMISED\)/),
			"exit:1",
		]);
	});

	it("a dead control socket cannot keep a worker that lost its lock alive", async () => {
		vi.useFakeTimers();
		const compromise = captureCompromise();
		const exit = vi.fn();
		await lockWithLossHandling(await sessionFile(), {
			realpath: false,
			onLost: stopWorkerOnLostOwnership({ report: () => new Promise(() => {}), exit, reportTimeoutMs: 1_000 }),
		});

		compromise.lose();
		await vi.advanceTimersByTimeAsync(999);
		expect(exit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(exit).toHaveBeenCalledWith(1);
	});

	it("a worker that released its lock is not stopped by a late heartbeat report", async () => {
		const compromise = captureCompromise();
		const report = vi.fn(async () => {});
		const exit = vi.fn();
		const lock = await lockWithLossHandling(await sessionFile(), {
			realpath: false,
			onLost: stopWorkerOnLostOwnership({ report, exit }),
		});

		await lock.release();
		compromise.lose();
		await Promise.resolve();

		expect(report).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();
	});
});
