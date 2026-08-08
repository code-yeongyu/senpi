import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	open: vi.fn(),
	spawn: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
	open: mocks.open,
}));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: mocks.spawn,
}));

import { defaultSpawnWorker, omoLocalUpdateWorkerLogPath } from "../src/beta/omo-local-update-worker.ts";

describe("defaultSpawnWorker", () => {
	let tempRoot: string | undefined;

	afterEach(() => {
		if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
		vi.clearAllMocks();
	});

	it("waits for the detached worker log handle to close asynchronously", async () => {
		tempRoot = mkdtempSync(join(tmpdir(), "omo-local-update-worker-test-"));
		const logPath = omoLocalUpdateWorkerLogPath(tempRoot);
		const events: string[] = [];
		let finishClose: (() => void) | undefined;
		const close = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					events.push("close-start");
					finishClose = () => {
						events.push("close-end");
						resolve();
					};
				}),
		);
		const child = {
			pid: 4242,
			unref: vi.fn(() => {
				events.push("unref");
			}),
		} as unknown as ChildProcess;

		mocks.open.mockResolvedValue({ fd: 41, close });
		mocks.spawn.mockImplementation(() => {
			events.push("spawn");
			return child;
		});

		const outcome = Promise.resolve(defaultSpawnWorker({ agentDir: tempRoot, force: true }));
		await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
		let settled = false;
		void outcome.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		finishClose?.();
		await expect(outcome).resolves.toEqual({
			ok: true,
			pid: 4242,
			logPath,
		});

		expect(mocks.open).toHaveBeenCalledWith(logPath, "w");
		expect(mocks.spawn).toHaveBeenCalledWith(
			process.execPath,
			expect.arrayContaining(["update", "--omo-local-update-worker", "--force"]),
			expect.objectContaining({
				detached: true,
				stdio: ["ignore", 41, 41],
			}),
		);
		expect(child.unref).toHaveBeenCalledOnce();
		expect(events).toEqual(["spawn", "unref", "close-start", "close-end"]);
	});
});
